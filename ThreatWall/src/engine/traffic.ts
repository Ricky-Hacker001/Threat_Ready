/**
 * Deterministic traffic evaluation for the lab.
 * Pure: evaluate() never mutates state. It returns a result plus the side effects (hit counters, logs, captured packets)
 * that the store applies only when the learner actually sends the traffic.
 */
import type { LogEntry, Packet, Proto, RootState } from '../state/types';
import { HOSTS, APPS, SIGNATURES, ISP_GATEWAYS, hostById, siteByIp, siteByName, type LabHost } from './world';
import { addrMatches, findAddress, labNow, serviceLabel, resolveFqdn, serviceMatches } from './objects';
import { tunnelStatus } from './vpn';
import { haActiveUnit, hostNet, ifaceByName, ifaceUp, isPrivate, leases, lookupRoute, hasAddress } from './network';
import { decide } from './rules';
import { inSubnet, isIPv4 } from '../lib/ip';
import { LAB } from '../state/baseline';

export type Verdict =
  | 'allowed' | 'consumed' | 'denied' | 'no-rule' | 'invalid-route' | 'dns-failure' | 'nat-mismatch' | 'schedule-inactive'
  | 'security-blocked' | 'vpn-unavailable' | 'spoof-blocked' | 'arp-conflict' | 'host-offline' | 'auth-required' | 'no-address'
  | 'mgmt-denied' | 'cert-error' | 'firewall-down';

export const VERDICT_LABEL: Record<Verdict, string> = {
  allowed: 'Allowed', consumed: 'Allowed (to firewall)', denied: 'Denied by rule', 'no-rule': 'No matching rule', 'invalid-route': 'Invalid route',
  'dns-failure': 'DNS failure', 'nat-mismatch': 'NAT mismatch', 'schedule-inactive': 'Schedule inactive', 'security-blocked': 'Security inspection blocked',
  'vpn-unavailable': 'VPN tunnel unavailable', 'spoof-blocked': 'Anti-spoof drop', 'arp-conflict': 'IP/ARP conflict', 'host-offline': 'Host offline',
  'auth-required': 'Authentication required', 'no-address': 'No IP address', 'mgmt-denied': 'Management denied', 'cert-error': 'Certificate error',
  'firewall-down': 'Firewall down',
};

export interface FlowSpec {
  from: string;             // lab host id
  to: string;               // host id, IP address or FQDN
  proto: Proto;
  port: number;
  app?: string;
  payload?: 'clean' | 'exploit' | 'eicar' | 'fp';
  tls?: boolean;
  user?: string | null;
  label?: string;
}

export interface TraceStep { stage: string; ok: boolean; detail: string }

export interface FlowResult {
  spec: FlowSpec;
  ts: number;
  verdict: Verdict;
  ok: boolean;
  reason: string;
  trace: TraceStep[];
  srcName: string;
  srcIp: string;
  dstName: string;
  dstIp: string;
  srcZone: string;
  dstZone: string;
  ingress: string;
  egress: string;
  service: string;
  rule: string;
  ruleId: string;
  nat: string;
  natId: string;
  translatedSrc: string;
  translatedDst: string;
  security?: { kind: 'cfs' | 'app' | 'ips' | 'gav' | 'botnet' | 'dpi'; detail: string; blocked: boolean };
  blockPage?: string;
  certIssuer?: string;
  servedBy: string;
}

export interface Effects {
  ruleHits: string[];
  natHits: string[];
  routeHits: string[];
  cfsHits: string[];
  logs: Omit<LogEntry, 'id'>[];
  packets: Omit<Packet, 'id'>[];
}

const emptyEffects = (): Effects => ({ ruleHits: [], natHits: [], routeHits: [], cfsHits: [], logs: [], packets: [] });

const licensed = (s: RootState, id: string) => s.config.licensing.services.some((x) => x.id === id && x.status === 'licensed');
const zoneFlag = (s: RootState, zones: string[], key: 'gatewayAv' | 'ips' | 'appControl' | 'antiSpyware') =>
  zones.some((z) => s.config.zones.find((x) => x.name === z)?.[key]);

/** Firewall's own DNS servers (static or inherited from WAN interfaces). */
export function firewallDns(s: RootState): string[] {
  const d = s.config.dns;
  const list = d.mode === 'static' ? d.servers : s.config.interfaces.filter((i) => i.zone === 'WAN' && hasAddress(i)).flatMap((i) => i.dns);
  return list.filter((x) => isIPv4(x) && x !== '0.0.0.0');
}

/** Can the firewall itself reach the internet (for its DNS proxy, probes, ping)? */
export function firewallInternet(s: RootState): { ok: boolean; reason: string; iface?: string } {
  const r = lookupRoute(s, '8.8.8.8', { src: '0.0.0.0', proto: 'UDP', port: 53 });
  if (r.kind === 'none' || !r.iface) return { ok: false, reason: r.reason };
  if (s.lab.isp[r.iface] === 'down') return { ok: false, reason: `ISP upstream on ${r.iface} is not responding` };
  const i = ifaceByName(s.config, r.iface);
  if (i && i.gateway !== (r.iface === 'X1' ? LAB.wanGw : r.iface === 'X3' ? LAB.wan2Gw : i.gateway)) {
    return { ok: false, reason: `gateway ${i.gateway} on ${r.iface} does not answer (the ISP router is ${r.iface === 'X1' ? LAB.wanGw : LAB.wan2Gw})` };
  }
  return { ok: true, reason: r.reason, iface: r.iface };
}

const DROP_CODE: Partial<Record<Verdict, string>> = {
  denied: 'Policy drop (access rule)', 'no-rule': 'Policy drop (no matching rule)', 'invalid-route': 'No route / next hop unreachable',
  'nat-mismatch': 'NAT policy not found', 'schedule-inactive': 'Policy drop (schedule inactive)', 'security-blocked': 'Security services drop',
  'vpn-unavailable': 'VPN SA not found', 'spoof-blocked': 'MAC-IP anti-spoof drop', 'mgmt-denied': 'Management not allowed on interface',
  'arp-conflict': 'ARP resolves to a different MAC', 'auth-required': 'Redirected to user login', 'cert-error': 'Client rejected re-signed certificate',
};

interface Ctx { depth: number; at?: number }

export function evaluate(s: RootState, spec: FlowSpec, opts: { at?: number } = {}): { result: FlowResult; effects: Effects } {
  return run(s, spec, { depth: 0, at: opts.at });
}

function run(s: RootState, spec: FlowSpec, ctx: Ctx): { result: FlowResult; effects: Effects } {
  const cfg = s.config;
  const ts = ctx.at ?? labNow(s);
  const fx = emptyEffects();
  const trace: TraceStep[] = [];
  const add = (stage: string, ok: boolean, detail: string) => trace.push({ stage, ok, detail });
  const host = hostById(spec.from);
  const service = serviceLabel(spec.proto, spec.port);
  const res: FlowResult = {
    spec, ts, verdict: 'allowed', ok: true, reason: '', trace, srcName: host?.name ?? spec.from, srcIp: '', dstName: spec.to, dstIp: '',
    srcZone: '', dstZone: '', ingress: '', egress: '', service, rule: '', ruleId: '', nat: '', natId: '', translatedSrc: '', translatedDst: '', servedBy: 'primary',
  };
  const finish = (v: Verdict, reason: string) => {
    res.verdict = v;
    res.ok = v === 'allowed' || v === 'consumed';
    res.reason = reason;
    logAndCapture(s, res, fx, host);
    return { result: res, effects: fx };
  };

  // ---------- Appliance ----------
  const unit = haActiveUnit(s);
  if (unit === 'none') { add('Appliance', false, 'The firewall is powered off and no standby unit has taken over.'); return finish('firewall-down', 'No firewall is passing traffic: the primary is down and HA is not configured or not synchronised.'); }
  res.servedBy = unit;
  if (unit === 'secondary') add('Appliance', true, 'Primary is down — the HA secondary is active and passing traffic.');

  if (!host) return finish('host-offline', `Unknown lab host ${spec.from}`);

  // ---------- Source ----------
  let srcIp = '';
  let srcZone = '';
  let ingress = '';
  let hostDns = '';
  const dstIsPrivateTarget = (() => { const h = hostById(spec.to); const ip = h ? hostAddrIp(s, h) : isIPv4(spec.to) ? spec.to : ''; return !!ip && isPrivate(ip); })();

  if (host.segment === 'internet') {
    const pub = (host.addr as { ip: string }).ip;
    if (host.id === 'remote-user' && dstIsPrivateTarget) {
      if (!s.lab.remoteUserConnected) { add('Source', false, 'NetExtender is not connected, so the home laptop has no route to office addresses.'); return finish('invalid-route', 'The remote laptop is not connected to the SSL VPN.'); }
      const pool = cfg.sslvpn.pool ? findAddress(cfg, cfg.sslvpn.pool) : undefined;
      srcIp = pool?.ip ?? '0.0.0.0';
      srcZone = 'SSLVPN';
      ingress = 'SSLVPN';
      add('Source', true, `${host.name} via NetExtender, client address ${srcIp} (zone SSLVPN)`);
    } else {
      srcIp = pub;
      srcZone = 'WAN';
      add('Source', true, `${host.name} ${srcIp} on the internet`);
    }
    hostDns = '1.1.1.1';
  } else if (host.segment === 'branch') {
    srcIp = (host.addr as { ip: string }).ip;
    srcZone = 'VPN';
    ingress = 'VPN';
    hostDns = LAB.dns1;
    add('Source', true, `${host.name} ${srcIp} at the branch office, arrives through the IPsec tunnel (zone VPN)`);
  } else {
    const net = hostNet(s, host);
    if (!net) {
      add('Source', false, host.addr.mode === 'pc' ? (s.session.pc.cabled ? 'ADMIN-PC has no IP address (run ipconfig /renew or set a static address).' : 'ADMIN-PC is not cabled to X0.') : `${host.name} did not get a DHCP lease.`);
      return finish('no-address', `${host.name} has no IP address.`);
    }
    const iface = net.iface;
    const up = ifaceUp(s, iface);
    if (!iface || !up.ok) { add('Source', false, `${host.name} is attached to ${iface?.name ?? host.iface ?? 'a VLAN'} but ${up.reason}.`); return finish('host-offline', up.reason); }
    if (!hasAddress(iface) || !inSubnet(net.ip, iface.ip, iface.mask)) {
      add('Source', false, `${host.name} is ${net.ip} but ${iface.name} is ${iface.ip}/${iface.mask}: they are in different subnets, so the host cannot reach its gateway.`);
      return finish('invalid-route', `${host.name}'s address ${net.ip} is not in ${iface.name}'s subnet.`);
    }
    srcIp = net.ip;
    srcZone = iface.zone!;
    ingress = iface.name;
    hostDns = net.dns;
    add('Source', true, `${host.name} ${srcIp} on ${iface.name} (zone ${srcZone})`);
    res.srcIp = srcIp; res.srcZone = srcZone; res.ingress = ingress;

    // ----- MAC-IP anti-spoof -----
    const mac = (net.mac ?? '').toLowerCase();
    const as = cfg.antiSpoof.ifaces[iface.name];
    const dstFw = (() => { const ip = isIPv4(spec.to) ? spec.to : ''; return cfg.interfaces.some((i) => hasAddress(i) && i.ip === ip); })();
    if (as?.enabled) {
      const black = cfg.antiSpoof.cache.find((c) => c.blacklisted && c.mac.toLowerCase() === mac);
      const known = [
        ...cfg.antiSpoof.cache.filter((c) => !c.blacklisted && c.iface === iface.name).map((c) => ({ ip: c.ip, mac: c.mac.toLowerCase() })),
        ...(as.staticArp ? cfg.staticArp.filter((a) => a.iface === iface.name).map((a) => ({ ip: a.ip, mac: a.mac.toLowerCase() })) : []),
        ...(as.dhcpServer ? leases(s).filter((l) => l.iface === iface.name).map((l) => ({ ip: l.ip, mac: l.mac.toLowerCase() })) : []),
      ];
      const forIp = known.filter((k) => k.ip === srcIp);
      const match = forIp.some((k) => k.mac === mac);
      const mismatch = forIp.length > 0 && !match;
      if (black) {
        add('MAC-IP anti-spoof', false, `${mac} is blacklisted in the anti-spoof cache.`);
        if (as.spoofDetection) fx.logs.push(mkLog(ts, 'Network', 'Alert', `MAC-IP anti-spoof: packet from blacklisted MAC ${mac} dropped`, srcIp, '', spec.proto, 'drop', '', `Interface ${iface.name}`, host.id));
        return finish('spoof-blocked', `${host.name} (${mac}) is blacklisted on ${iface.name}.`);
      }
      if (as.enforceIngress && !match) {
        if (dstFw && as.allowMgmt) add('MAC-IP anti-spoof', true, 'Not in the cache, but Allow Management lets traffic to the firewall through.');
        else {
          add('MAC-IP anti-spoof', false, mismatch ? `${srcIp} is cached for ${forIp[0].mac}, but this packet came from ${mac}.` : `${srcIp}/${mac} is not in the anti-spoof cache and Enforce Ingress is on.`);
          if (as.spoofDetection) fx.logs.push(mkLog(ts, 'Network', 'Alert', `MAC-IP anti-spoof check failed: ${srcIp} ${mac}`, srcIp, '', spec.proto, 'drop', '', `Interface ${iface.name}; added to Spoof Detected List`, host.id));
          return finish('spoof-blocked', mismatch ? `IP/MAC mismatch on ${iface.name}: ${srcIp} belongs to ${forIp[0].mac}.` : `${host.name} is not in the anti-spoof cache and ingress enforcement is on.`);
        }
      } else if (mismatch && as.spoofDetection) {
        fx.logs.push(mkLog(ts, 'Network', 'Warning', `MAC-IP anti-spoof: ${srcIp} seen from ${mac} (expected ${forIp[0].mac})`, srcIp, '', spec.proto, 'info', '', 'Detection only — Enforce Ingress is off', host.id));
        add('MAC-IP anti-spoof', true, 'Mismatch detected and logged (enforcement off).');
      } else add('MAC-IP anti-spoof', true, match ? 'IP/MAC pair matches the cache.' : 'Checked (no cache entry; enforcement off).');
    }

    // ----- IP conflict (FIN-PC vs the rogue laptop) -----
    if (host.id === 'fin' || host.id === 'rogue') {
      const other = hostById(host.id === 'fin' ? 'rogue' : 'fin')!;
      const on = hostNet(s, other);
      if (on && on.ip === srcIp) {
        const roguePinnedOut = cfg.antiSpoof.ifaces[iface.name]?.enabled && (
          cfg.antiSpoof.cache.some((c) => c.blacklisted && c.mac.toLowerCase() === LAB.macs.rogue)
          || (cfg.antiSpoof.ifaces[iface.name].enforceIngress && cfg.antiSpoof.cache.some((c) => c.ip === LAB.finPc && c.mac.toLowerCase() === LAB.macs.fin && !c.blacklisted)));
        const finLocked = cfg.antiSpoof.ifaces[iface.name]?.arpLock && cfg.antiSpoof.cache.some((c) => c.ip === LAB.finPc && c.mac.toLowerCase() === LAB.macs.fin && !c.blacklisted);
        if (host.id === 'fin' && !(roguePinnedOut || finLocked)) {
          res.srcIp = srcIp; res.srcZone = srcZone; res.ingress = ingress;
          add('ARP', false, `Two devices use ${srcIp}. The firewall's ARP entry points at ${LAB.macs.rogue} (the unknown laptop), so replies never reach FIN-PC.`);
          return finish('arp-conflict', `IP address conflict on ${srcIp}: replies go to ${LAB.macs.rogue}, not FIN-PC.`);
        }
      }
    }
  }
  res.srcIp = srcIp;
  res.srcZone = srcZone;
  res.ingress = ingress;

  // ---------- Destination ----------
  let dstIp = '';
  let dstName = spec.to;
  const dstHost = hostById(spec.to);
  if (dstHost) {
    dstIp = hostAddrIp(s, dstHost);
    dstName = dstHost.name;
    if (!dstIp) { add('Destination', false, `${dstHost.name} has no address.`); return finish('host-offline', `${dstHost.name} has no address.`); }
  } else if (isIPv4(spec.to)) {
    dstIp = spec.to;
    const site = siteByIp(dstIp);
    if (site) dstName = site.name;
  } else {
    // DNS lookup by the client
    const dnsIp = hostDns || '0.0.0.0';
    const ownDns = cfg.interfaces.some((i) => hasAddress(i) && i.ip === dnsIp);
    if (ctx.depth > 1) return finish('dns-failure', 'DNS recursion limit');
    if (!isIPv4(dnsIp) || dnsIp === '0.0.0.0') { add('DNS', false, `${host.name} has no DNS server configured.`); return finish('dns-failure', `${host.name} has no DNS server.`); }
    if (ownDns) {
      const fw = firewallDns(s);
      const net = firewallInternet(s);
      if (!fw.length || !net.ok) {
        add('DNS', false, `${host.name} asks the firewall (${dnsIp}) to resolve ${spec.to}, but the firewall ${!fw.length ? 'has no DNS servers configured' : `cannot reach them: ${net.reason}`}.`);
        return finish('dns-failure', `Name resolution failed: the firewall ${!fw.length ? 'has no DNS servers' : 'cannot reach its DNS servers'}.`);
      }
      add('DNS', true, `Firewall DNS proxy resolved ${spec.to} via ${fw[0]}.`);
    } else {
      const q = run(s, { from: spec.from, to: dnsIp, proto: 'UDP', port: 53, label: `DNS query for ${spec.to}` }, { depth: ctx.depth + 1, at: ctx.at });
      mergeEffects(fx, q.effects);
      if (!q.result.ok) {
        add('DNS', false, `DNS query to ${dnsIp} (UDP 53) failed: ${q.result.reason}`);
        return finish('dns-failure', `DNS lookup for ${spec.to} failed — ${q.result.reason}`);
      }
      add('DNS', true, `Resolved ${spec.to} via ${dnsIp}.`);
    }
    const ip = resolveFqdn(spec.to);
    if (!ip) { add('DNS', false, `${spec.to}: NXDOMAIN (name does not exist).`); return finish('dns-failure', `${spec.to} does not exist.`); }
    dstIp = ip;
  }
  res.dstIp = dstIp;
  res.dstName = dstName;

  // ---------- Inbound from the internet ----------
  if (srcZone === 'WAN') {
    const wan = cfg.interfaces.find((i) => i.zone === 'WAN' && hasAddress(i) && inSubnet(dstIp, i.ip, i.mask));
    if (!wan || !ifaceUp(s, wan).ok || s.lab.isp[wan.name] === 'down') { add('Ingress', false, `${dstIp} is not reachable on any working WAN interface.`); return finish('invalid-route', `Nothing on the firewall answers for ${dstIp}.`); }
    res.ingress = wan.name;
    add('Ingress', true, `Arrives on ${wan.name} (${wan.ip}/${wan.mask}).`);
    const nat = cfg.natRules.find((n) => n.enabled && (n.inIface === 'Any' || n.inIface === wan.name) && addrMatches(cfg, n.origSrc, srcIp) && addrMatches(cfg, n.origDst, dstIp)
      && natSvc(s, n.origSvc, spec.proto, spec.port));
    if (!nat) {
      if (dstIp === wan.ip) return mgmt(wan.name);
      const near = cfg.natRules.find((n) => n.enabled && addrMatches(cfg, n.origDst, dstIp));
      add('NAT', false, near ? `NAT policy ${near.name} exists for ${dstIp} but not for ${service}.` : `No inbound NAT policy translates ${dstIp}.`);
      return finish(near ? 'nat-mismatch' : 'no-rule', near ? `${near.name} only translates ${near.origSvc}, not ${service}.` : `No NAT policy publishes ${dstIp}.`);
    }
    const tDst = nat.transDst === 'Original' ? dstIp : (findAddress(cfg, nat.transDst)?.ip ?? '');
    res.nat = nat.name;
    res.natId = nat.id;
    res.translatedDst = tDst;
    fx.natHits.push(nat.id);
    add('NAT', true, `${nat.name}: ${dstIp} → ${tDst}`);
    const r = lookupRoute(s, tDst, { src: srcIp, proto: spec.proto, port: spec.port });
    if (r.kind === 'none' || r.kind === 'local') { add('Route', false, r.reason); return finish('invalid-route', `Translated address ${tDst}: ${r.reason}`); }
    res.egress = r.iface ?? '';
    res.dstZone = r.zone ?? '';
    add('Route', true, r.reason);
    const d = decide(s, { fromZone: 'WAN', toZone: res.dstZone, src: srcIp, dst: dstIp, dstAlt: tDst, proto: spec.proto, port: spec.port, user: null, ts });
    const ruleOut = applyDecision(d, 'WAN', res.dstZone);
    if (ruleOut) return ruleOut;
    // web server answers only on the ports it listens on
    const listens = [80, 443];
    if (dstHost === undefined && tDst === LAB.webServer && !(spec.proto === 'TCP' && listens.includes(spec.port))) {
      add('Server', false, `WEB-01 is not listening on ${service}.`);
      return finish('host-offline', `WEB-01 does not listen on ${service}.`);
    }
    return security();
  }

  // ---------- Routing ----------
  const route = lookupRoute(s, dstIp, { src: srcIp, proto: spec.proto, port: spec.port });
  if (route.kind === 'local') {
    if (srcZone === 'VPN' || srcZone === 'SSLVPN') { add('Route', true, route.reason); return finish('consumed', 'Reached the firewall.'); }
    return mgmt(ingress);
  }
  if (route.kind === 'none') {
    add('Route', false, route.reason);
    return finish(route.policyId ? 'vpn-unavailable' : 'invalid-route', route.reason);
  }
  if (route.policyId && route.kind === 'policy') fx.routeHits.push(route.policyId);
  res.egress = route.iface ?? '';
  res.dstZone = route.zone ?? '';
  add('Route', true, route.reason);
  if (route.kind === 'policy' && route.iface && ISP_GATEWAYS[route.iface] && route.gateway && route.gateway !== '0.0.0.0' && route.gateway !== ISP_GATEWAYS[route.iface]) {
    add('Next hop', false, `Route ${route.name} sends this to ${route.gateway} on ${route.iface}, but nothing answers ARP for that address (the ISP router is ${ISP_GATEWAYS[route.iface]}).`);
    return finish('invalid-route', `Next hop ${route.gateway} (route ${route.name}) is unreachable.`);
  }

  // VPN traffic must also be permitted by the tunnel's selectors
  if (srcZone === 'VPN') {
    const p = cfg.ipsec.find((x) => x.kind === 'site' && x.enabled && addrMatches(cfg, x.localNet, dstIp));
    if (!p || tunnelStatus(s, p.id).state !== 'up') {
      add('VPN', false, p ? `Tunnel ${p.name} is down: ${tunnelStatus(s, p.id).reason}` : 'No VPN policy covers this destination.');
      return finish('vpn-unavailable', p ? `Tunnel ${p.name} is down.` : 'No VPN policy covers this destination.');
    }
    add('VPN', true, `Decrypted from tunnel ${p.name}.`);
  }

  // ---------- Access rules ----------
  const d = decide(s, { fromZone: srcZone, toZone: res.dstZone, src: srcIp, dst: dstIp, proto: spec.proto, port: spec.port, user: authUser(s, spec, host), ts });
  const ruleOut = applyDecision(d, srcZone, res.dstZone);
  if (ruleOut) return ruleOut;

  // ---------- NAT (outbound) ----------
  if (res.dstZone === 'WAN') {
    const nat = cfg.natRules.find((n) => n.enabled && (n.outIface === 'Any' || n.outIface === res.egress) && n.inIface !== res.egress
      && addrMatches(cfg, n.origSrc, srcIp) && addrMatches(cfg, n.origDst, dstIp) && natSvc(s, n.origSvc, spec.proto, spec.port));
    const eg = ifaceByName(cfg, res.egress);
    if (nat) {
      res.nat = nat.name;
      res.natId = nat.id;
      res.translatedSrc = nat.transSrc === 'Original' ? srcIp : (findAddress(cfg, nat.transSrc)?.ip ?? srcIp);
      fx.natHits.push(nat.id);
    } else if (eg && !cfg.natDefaultsDisabled.includes(eg.name)) {
      res.nat = `Default NAT Policy (${eg.name})`;
      res.natId = `default-${eg.name}`;
      res.translatedSrc = eg.ip;
      fx.natHits.push(res.natId);
    }
    if (!res.translatedSrc || isPrivate(res.translatedSrc)) {
      add('NAT', false, `No NAT policy translates ${srcIp} leaving ${res.egress}; the ISP drops private source addresses.`);
      return finish('nat-mismatch', `${srcIp} would leave ${res.egress} untranslated.`);
    }
    add('NAT', true, `${res.nat}: source ${srcIp} → ${res.translatedSrc}`);
  }

  // ---------- Security services ----------
  return security();

  /* ---------------------------- helpers ---------------------------- */

  function applyDecision(dec: ReturnType<typeof decide>, from: string, to: string) {
    if (dec.rule) {
      res.rule = dec.rule.name;
      res.ruleId = dec.rule.id;
      fx.ruleHits.push(dec.rule.id);
      if (dec.rule.action !== 'allow') {
        add('Access rule', false, `${dec.rule.name} (${from} → ${to}) ${dec.rule.action === 'deny' ? 'denies' : 'discards'} ${service}.`);
        return finish('denied', `Denied by access rule ${dec.rule.name}.`);
      }
      add('Access rule', true, `${dec.rule.name} (${from} → ${to}) allows ${service}${dec.rule.schedule !== 'Always' ? ` during ${dec.rule.schedule}` : ''}${dec.rule.usersIncl !== 'All' ? ` for ${dec.rule.usersIncl}` : ''}.`);
      return null;
    }
    if (dec.needsAuth) {
      res.rule = dec.needsAuth.name;
      add('Access rule', false, `${dec.needsAuth.name} only allows members of ${dec.needsAuth.usersIncl}; the user is not logged in.`);
      return finish('auth-required', `Log in first: ${dec.needsAuth.name} requires ${dec.needsAuth.usersIncl}.`);
    }
    if (dec.implicit === 'trust') { add('Access rule', true, `Interface Trust allows traffic inside zone ${from}.`); return null; }
    if (dec.skippedBySchedule) {
      res.rule = dec.skippedBySchedule.name;
      add('Access rule', false, `${dec.skippedBySchedule.name} matches but its schedule ${dec.skippedBySchedule.schedule} is not active now.`);
      return finish('schedule-inactive', `${dec.skippedBySchedule.name} is outside its schedule (${dec.skippedBySchedule.schedule}).`);
    }
    add('Access rule', false, `No rule ${from} → ${to} allows ${service}; the implicit deny drops it.`);
    return finish('no-rule', `Policy not found for packet on Zones (${from} → ${to}).`);
  }

  function mgmt(ifaceName: string) {
    const i = ifaceByName(cfg, ifaceName)!;
    const m = i.mgmt;
    const sslvpn = spec.proto === 'TCP' && spec.port === cfg.sslvpn.port && cfg.sslvpn.zones[i.zone ?? ''];
    const ok = spec.proto === 'ICMP' ? m.ping
      : spec.proto === 'TCP' && spec.port === cfg.system.httpsPort ? m.https
        : spec.proto === 'TCP' && spec.port === 22 ? m.ssh
          : spec.proto === 'UDP' && spec.port === 161 ? m.snmp
            : spec.proto === 'UDP' && spec.port === 53 ? i.zone !== 'WAN'
              : spec.proto === 'TCP' && spec.port === 80 ? m.http || i.httpRedirect
                : sslvpn;
    res.dstZone = i.zone ?? '';
    res.egress = 'firewall';
    if (!ok) {
      const why = spec.proto === 'TCP' && spec.port === 443 && cfg.system.httpsPort !== 443 ? ` HTTPS management now listens on port ${cfg.system.httpsPort}, not 443.` : '';
      add('Management', false, `${service} to ${i.name} (${i.ip}) is not enabled under Management on ${i.name}.${why}`);
      return finish('mgmt-denied', `${service} management is not allowed on ${i.name}.${why}`);
    }
    add('Management', true, sslvpn ? `SSL VPN portal on ${i.name}:${spec.port}` : `${service} to the firewall on ${i.name} is allowed.`);
    return finish('consumed', sslvpn ? 'SSL VPN portal reached.' : `Firewall answered on ${i.name}.`);
  }

  function security() {
    const zones = [res.srcZone, res.dstZone];
    const site = siteByIp(res.translatedDst || res.dstIp) ?? (isIPv4(spec.to) ? undefined : siteByName(spec.to));
    const tls = spec.tls ?? (spec.proto === 'TCP' && spec.port === 443);
    const dpi = s.config.security.dpiSsl;
    const lanClient = host!.segment === 'iface' || host!.segment === 'vlan';
    const dpiOn = tls && lanClient && res.dstZone === 'WAN' && dpi.clientEnabled && licensed(s, 'dpissl')
      && !(site && dpi.excludedCategories.includes(site.category)) && !(site && dpi.excludedNames.some((n) => site.name.endsWith(n)));
    if (tls) {
      res.certIssuer = dpiOn ? 'ThreatWall DPI-SSL CA (re-signed)' : site ? `${site.name} (original certificate)` : 'Original server certificate';
      if (dpiOn) {
        if (!s.lab.pcsTrustDpiCa) {
          add('DPI-SSL', false, 'Traffic is decrypted and re-signed by the ThreatWall DPI-SSL CA, which this PC does not trust.');
          res.security = { kind: 'dpi', detail: 'Re-signed certificate not trusted by the client', blocked: true };
          return finish('cert-error', 'Browser certificate error: the DPI-SSL CA is not installed on the client.');
        }
        if (site?.name === 'pinned-app.example') {
          add('DPI-SSL', false, 'The app pins its server certificate and rejects the re-signed one.');
          res.security = { kind: 'dpi', detail: 'Certificate pinning broke the connection — add an exclusion', blocked: true };
          return finish('cert-error', 'Pinned application rejected the re-signed certificate. Exclude it from DPI-SSL.');
        }
        add('DPI-SSL', true, 'Decrypted for inspection (client trusts the DPI-SSL CA).');
      } else add('DPI-SSL', true, dpi.clientEnabled ? 'Not inspected (excluded or not LAN→WAN).' : 'Not decrypted — encrypted content is invisible to IPS/anti-virus.');
    }
    const seeInside = !tls || dpiOn;

    // Botnet
    if (res.dstIp === LAB.c2 && s.config.security.botnet.enabled && licensed(s, 'botnet')) {
      res.security = { kind: 'botnet', detail: `Known command-and-control server ${LAB.c2}`, blocked: true };
      add('Botnet filter', false, `${LAB.c2} is on the botnet blocklist.`);
      return finish('security-blocked', `Botnet filter blocked ${LAB.c2}.`);
    }

    // Content filter
    const cfs = s.config.security.cfs;
    if (site && (spec.port === 80 || spec.port === 443) && cfs.enabled && licensed(s, 'cfs') && res.dstZone === 'WAN') {
      const user = authUser(s, spec, host!);
      const rule = cfs.rules.find((r) => r.enabled && (r.srcZone === 'Any' || r.srcZone === res.srcZone) && (r.dstZone === 'Any' || r.dstZone === 'WAN')
        && (r.users === 'All' || (user && s.config.users.local.find((u) => u.name === user)?.groups.includes(r.users))));
      const prof = rule && cfs.profiles.find((p) => p.name === rule.profile);
      if (rule && prof) {
        fx.cfsHits.push(rule.id);
        if (prof.allowList.some((a) => site.name.endsWith(a.trim()))) add('Content filter', true, `${site.name} is on the allow list of ${prof.name}.`);
        else if (prof.blocked.includes(site.category)) {
          res.security = { kind: 'cfs', detail: `${site.category} blocked by ${prof.name}`, blocked: true };
          res.blockPage = `This site (${site.name}) is blocked by the ThreatWall content filter. Category: ${site.category}. Policy: ${rule.name}.`;
          add('Content filter', false, `${site.name} is ${site.category}, blocked by ${prof.name} (${rule.name}).`);
          return finish('security-blocked', `Content filter blocked ${site.name} (${site.category}).`);
        } else add('Content filter', true, `${site.category} is allowed by ${prof.name}.`);
      } else add('Content filter', true, 'No content filter policy applies.');
    }

    // App control
    const app = APPS.find((a) => a.id === (spec.app ?? site?.app));
    const ac = s.config.security.appControl;
    if (app && ac.enabled && licensed(s, 'app') && zoneFlag(s, zones, 'appControl')) {
      const act = ac.categories[app.category];
      if (act === 'block') {
        res.security = { kind: 'app', detail: `${app.name} (${app.category}) blocked`, blocked: true };
        add('App Control', false, `${app.name} is in ${app.category}, set to Block.`);
        return finish('security-blocked', `App Control blocked ${app.name} (${app.category}).`);
      }
      if (act === 'log' || ac.logAll) {
        res.security = { kind: 'app', detail: `${app.name} (${app.category}) logged`, blocked: false };
        fx.logs.push(mkLog(ts, 'Security Services', 'Notice', `Application Control Detection Alert: ${app.name} (${app.category})`, res.srcIp, res.dstIp, spec.proto, 'allow', res.rule, 'Logged, not blocked', host!.id));
        add('App Control', true, `${app.name} (${app.category}) detected and logged.`);
      } else add('App Control', true, `${app.name} (${app.category}) — no action.`);
    } else if (app) add('App Control', true, ac.enabled ? 'App Control is not enabled on these zones or not licensed.' : 'App Control is off.');

    // IPS
    const sigId = spec.payload === 'exploit' ? 2103 : spec.payload === 'fp' ? 5946 : 0;
    const ips = s.config.security.ips;
    if (sigId) {
      const sig = SIGNATURES[sigId];
      if (!ips.enabled || !licensed(s, 'ips') || !zoneFlag(s, zones, 'ips')) add('IPS', true, 'IPS is off, unlicensed or not enabled on these zones — not inspected.');
      else if (!seeInside || (dpiOn && !dpi.inspect.ips)) add('IPS', true, 'Encrypted traffic — IPS cannot see the payload.');
      else if (ips.exclusions.includes(sigId)) add('IPS', true, `Signature ${sigId} (${sig.name}) is excluded.`);
      else {
        const lvl = ips[sig.severity];
        if (lvl.prevent) {
          res.security = { kind: 'ips', detail: `${sig.name} (SID ${sigId}, ${sig.severity})`, blocked: true };
          add('IPS', false, `Signature ${sigId} ${sig.name} (${sig.severity}) — Prevent.`);
          return finish('security-blocked', `IPS prevented ${sig.name} (SID ${sigId}).`);
        }
        if (lvl.detect) {
          res.security = { kind: 'ips', detail: `${sig.name} (SID ${sigId}) detected`, blocked: false };
          fx.logs.push(mkLog(ts, 'Security Services', 'Alert', `IPS Detection Alert: ${sig.name}, SID: ${sigId}`, res.srcIp, res.dstIp, spec.proto, 'allow', res.rule, 'Detected, not prevented', host!.id));
          add('IPS', true, `Signature ${sigId} detected and logged (Prevent is off for ${sig.severity}).`);
        } else add('IPS', true, `${sig.severity} signatures are neither prevented nor detected.`);
      }
    }

    // Gateway anti-virus
    const gav = s.config.security.gav;
    if (spec.payload === 'eicar') {
      const proto = spec.port === 21 ? 'FTP' : spec.port === 25 ? 'SMTP' : 'HTTP';
      if (!gav.enabled || !licensed(s, 'gav') || !zoneFlag(s, zones, 'gatewayAv')) add('Gateway AV', true, 'Gateway Anti-Virus is off, unlicensed or not enabled on these zones.');
      else if (!seeInside || (dpiOn && !dpi.inspect.gav)) add('Gateway AV', true, 'The file arrives over HTTPS without DPI-SSL — anti-virus cannot see it.');
      else if (!gav.protocols[proto]?.inbound) add('Gateway AV', true, `Inbound ${proto} inspection is off.`);
      else {
        res.security = { kind: 'gav', detail: 'EICAR test file (Eicar-Test-Signature)', blocked: true };
        add('Gateway AV', false, 'EICAR test signature found in the download.');
        return finish('security-blocked', 'Gateway Anti-Virus blocked the EICAR test file.');
      }
    }

    // Upstream: the ISP behind the egress WAN must answer
    if (res.dstZone === 'WAN' && res.egress && s.lab.isp[res.egress] === 'down') {
      add('Upstream', false, `ISP behind ${res.egress} is not responding — packets leave but nothing comes back.`);
      return finish('invalid-route', `${res.egress} upstream (ISP) is down; nothing answers.`);
    }
    if (res.dstZone === 'WAN' && res.egress) {
      const eg = ifaceByName(s.config, res.egress);
      const expect = res.egress === 'X1' ? LAB.wanGw : res.egress === 'X3' ? LAB.wan2Gw : eg?.gateway;
      if (eg && eg.gateway !== expect) {
        add('Upstream', false, `Next hop ${eg.gateway} does not answer ARP — the ISP router is ${expect}.`);
        return finish('invalid-route', `Wrong gateway on ${res.egress} (${eg.gateway}).`);
      }
    }
    // DMZ server only listens on web ports
    if (res.dstIp === LAB.webServer && !(spec.proto === 'TCP' && [80, 443].includes(spec.port)) && spec.proto !== 'ICMP') {
      add('Server', false, `WEB-01 is not listening on ${service}.`);
      return finish('host-offline', `WEB-01 does not listen on ${service}.`);
    }
    add('Delivered', true, `${service} reached ${res.dstName}${res.servedBy === 'secondary' ? ' (via the HA secondary)' : ''}.`);
    return finish('allowed', `Allowed${res.rule ? ` by ${res.rule}` : ''}.`);
  }
}

function natSvc(s: RootState, name: string, proto: Proto, port: number) {
  if (name === 'Any' || name === 'Original') return true;
  return serviceMatches(s.config, name, proto, port);
}

function hostAddrIp(s: RootState, h: LabHost): string {
  return hostNet(s, h)?.ip ?? '';
}

function authUser(s: RootState, spec: FlowSpec, host: LabHost): string | null {
  if (spec.user !== undefined) return spec.user;
  return s.lab.authSessions.find((a) => a.host === host.id)?.user ?? null;
}

export function mkLog(ts: number, category: LogEntry['category'], priority: LogEntry['priority'], message: string, src: string, dst: string, proto: string, action: LogEntry['action'], rule: string, notes: string, host?: string): Omit<LogEntry, 'id'> {
  return { ts, category, priority, message, src, dst, proto, action, rule, notes, host };
}

function mergeEffects(a: Effects, b: Effects) {
  a.ruleHits.push(...b.ruleHits); a.natHits.push(...b.natHits); a.routeHits.push(...b.routeHits); a.cfsHits.push(...b.cfsHits);
  a.logs.push(...b.logs); a.packets.push(...b.packets);
}

function logAndCapture(s: RootState, r: FlowResult, fx: Effects, host?: LabHost) {
  const proto = r.spec.proto.toLowerCase();
  const src = `${r.srcIp || '-'}${r.spec.proto === 'ICMP' ? '' : ''}, ${r.ingress || '-'}`;
  const dst = `${r.dstIp || r.spec.to}, ${r.spec.port || ''}${r.egress ? `, ${r.egress}` : ''}`;
  const matched = s.config.accessRules.find((x) => x.id === r.ruleId);
  if (!r.ok) {
    const cat: LogEntry['category'] = r.verdict === 'security-blocked' || r.verdict === 'cert-error' ? 'Security Services' : r.verdict === 'vpn-unavailable' ? 'VPN'
      : r.verdict === 'spoof-blocked' ? 'Network' : r.verdict === 'firewall-down' ? 'High Availability' : 'Firewall Rule';
    if (!(r.verdict === 'spoof-blocked' && fx.logs.length)) {
      fx.logs.push(mkLog(r.ts, cat, r.verdict === 'security-blocked' ? 'Alert' : 'Warning', `${r.spec.proto} packet dropped — ${VERDICT_LABEL[r.verdict]}: ${r.reason}`, src, dst, proto, r.verdict === 'security-blocked' ? 'block' : 'drop', r.rule, r.security?.detail ?? '', host?.id));
    }
  } else if (matched?.logging || r.verdict === 'consumed' || r.security) {
    fx.logs.push(mkLog(r.ts, r.verdict === 'consumed' ? 'System' : 'Firewall Rule', 'Info', `Connection ${r.verdict === 'consumed' ? 'to firewall' : 'opened'}: ${r.service} ${r.srcName} → ${r.dstName}`, src, dst, proto, 'allow', r.rule, r.nat ? `NAT: ${r.nat}` : '', host?.id));
  }
  // packet monitor
  const pm = s.pm;
  if (!pm.capturing) return;
  const f = pm.filter;
  const ipMatch = (want: string, ...have: string[]) => !want || have.includes(want);
  if (!ipMatch(f.src, r.srcIp, r.translatedSrc) || !ipMatch(f.dst, r.dstIp, r.translatedDst) || (f.dstPort && String(r.spec.port) !== f.dstPort.trim())) return;
  if (f.etherType === 'ARP') return;
  const status: Packet['status'] = r.verdict === 'consumed' ? 'consumed' : r.ok ? 'forwarded' : 'dropped';
  if ((status === 'dropped' && !f.dropped) || (status === 'forwarded' && !f.forwarded) || (status === 'consumed' && !f.consumed)) return;
  fx.packets.push({
    ts: r.ts, ingress: r.ingress || '-', egress: r.ok ? r.egress || 'firewall' : '-', src: r.srcIp, dst: r.dstIp, srcPort: 49152 + (r.ts % 1000),
    dstPort: r.spec.port, proto: r.spec.proto, status, reason: r.ok ? '' : `${DROP_CODE[r.verdict] ?? VERDICT_LABEL[r.verdict]} — ${r.reason}`,
    rule: r.rule, nat: r.nat, flowLabel: r.spec.label ?? `${r.srcName} → ${r.dstName}`,
  });
}

export { HOSTS };
