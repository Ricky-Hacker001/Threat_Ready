/** Layer 2/3 model: host addressing (DHCP), ARP, link health, routing, SD-WAN path choice, HA role. */
import type { DhcpScope, FirewallConfig, NetInterface, RootState } from '../state/types';
import { inSubnet, intToIp, ipToInt, isIPv4, maskToPrefix, networkOf } from '../lib/ip';
import { HOSTS, ISP_GATEWAYS, type LabHost } from './world';
import { addrMatches, findAddress, groupMembers, serviceMatches } from './objects';
import { tunnelStatus } from './vpn';
import type { Proto } from '../state/types';

export const ifaceByName = (cfg: FirewallConfig, n: string) => cfg.interfaces.find((i) => i.name === n);
export const hasAddress = (i: NetInterface) => i.zone !== null && i.mode === 'static' && i.ip !== '0.0.0.0';

/** Interface usable for traffic right now (lab trunk applies to VLANs). */
export function ifaceUp(s: RootState, i: NetInterface | undefined): { ok: boolean; reason: string } {
  if (!i) return { ok: false, reason: 'interface does not exist' };
  if (i.zone === null) return { ok: false, reason: `${i.name} is unassigned` };
  if (!i.enabled) return { ok: false, reason: `${i.name} is disabled` };
  if (i.kind === 'vlan') {
    const p = ifaceByName(s.config, i.parent ?? '');
    if (!p || p.zone === null || !p.enabled) return { ok: false, reason: `parent ${i.parent} is not configured` };
    if (!s.lab.trunk) return { ok: false, reason: `the switch port on ${i.parent} is not an 802.1Q trunk, so VLAN ${i.vlanId} frames never arrive` };
    return { ok: true, reason: '' };
  }
  if (i.link !== 'up') return { ok: false, reason: `${i.name} has no link` };
  return { ok: true, reason: '' };
}

/* ------------------------------ DHCP ------------------------------ */

export function hostIface(cfg: FirewallConfig, h: LabHost): NetInterface | undefined {
  if (h.segment === 'iface') return ifaceByName(cfg, h.iface!);
  if (h.segment === 'vlan') return cfg.interfaces.find((i) => i.kind === 'vlan' && i.parent === 'X0' && i.vlanId === h.vlan);
  return undefined;
}

export function scopeFor(cfg: FirewallConfig, iface: NetInterface): DhcpScope | undefined {
  if (!cfg.dhcp.enabled || !hasAddress(iface)) return undefined;
  return cfg.dhcp.scopes.find((sc) => sc.enabled && sc.iface === iface.name && isIPv4(sc.start) && isIPv4(sc.end)
    && inSubnet(sc.start, iface.ip, iface.mask) && inSubnet(sc.end, iface.ip, iface.mask));
}

export interface Lease { mac: string; ip: string; host: string; iface: string; kind: 'dynamic' | 'static'; gateway: string; dns: string; mask: string }

/** Deterministic lease table: reservations by MAC first, then pool in host order. */
export function leases(s: RootState): Lease[] {
  const cfg = s.config;
  const out: Lease[] = [];
  const dhcpHosts = HOSTS.filter((h) => h.addr.mode === 'dhcp' || (h.addr.mode === 'pc' && s.session.pc.mode === 'dhcp' && s.session.pc.cabled));
  for (const iface of cfg.interfaces) {
    const sc = scopeFor(cfg, iface);
    if (!sc || !ifaceUp(s, iface).ok) continue;
    const taken = new Set<string>([iface.ip, ...HOSTS.filter((h) => h.addr.mode === 'static').map((h) => (h.addr as { ip: string }).ip)]);
    const attached = dhcpHosts.filter((h) => hostIface(cfg, h)?.name === iface.name);
    // reservations
    const pending: LabHost[] = [];
    for (const h of attached) {
      const mac = h.addr.mode === 'pc' ? s.session.pc.mac : h.mac!;
      const res = cfg.dhcp.statics.find((r) => r.enabled && r.mac.toLowerCase() === mac.toLowerCase() && inSubnet(r.ip, iface.ip, iface.mask));
      if (res) { taken.add(res.ip); out.push({ mac, ip: res.ip, host: h.id, iface: iface.name, kind: 'static', gateway: sc.gateway, dns: sc.dns[0], mask: iface.mask }); }
      else pending.push(h);
    }
    cfg.dhcp.statics.forEach((r) => r.enabled && taken.add(r.ip));
    let cur = ipToInt(sc.start);
    const end = ipToInt(sc.end);
    for (const h of pending) {
      while (cur <= end && taken.has(intToIp(cur))) cur++;
      if (cur > end) break;
      const ip = intToIp(cur);
      taken.add(ip);
      const mac = h.addr.mode === 'pc' ? s.session.pc.mac : h.mac!;
      out.push({ mac, ip, host: h.id, iface: iface.name, kind: 'dynamic', gateway: sc.gateway, dns: sc.dns[0], mask: iface.mask });
    }
  }
  return out;
}

/** What ADMIN-PC would get from `ipconfig /renew` right now. */
export function pcLease(s: RootState): Lease | null {
  if (!s.session.pc.cabled) return null;
  const st = { ...s, session: { ...s.session, pc: { ...s.session.pc, mode: 'dhcp' as const } } };
  return leases(st).find((l) => l.host === 'admin') ?? null;
}

/* ------------------------------ Host addressing ------------------------------ */

export interface HostNet { ip: string; mask: string; gw: string; dns: string; iface?: NetInterface; mac?: string }

export function hostNet(s: RootState, h: LabHost): HostNet | null {
  const iface = hostIface(s.config, h);
  switch (h.addr.mode) {
    case 'public': return { ip: h.addr.ip, mask: '255.255.255.255', gw: '', dns: '1.1.1.1' };
    case 'static': return { ip: h.addr.ip, mask: h.addr.mask, gw: h.addr.gw, dns: h.addr.dns, iface, mac: h.mac };
    case 'pc': {
      const pc = s.session.pc;
      if (!pc.cabled || !pc.ip) return null;
      return { ip: pc.ip, mask: pc.mask, gw: pc.gateway, dns: pc.dns, iface, mac: pc.mac };
    }
    case 'dhcp': {
      const l = leases(s).find((x) => x.host === h.id);
      return l ? { ip: l.ip, mask: l.mask, gw: l.gateway, dns: l.dns, iface, mac: h.mac } : null;
    }
  }
}

/* ------------------------------ ARP ------------------------------ */

export interface ArpRow { ip: string; mac: string; iface: string; type: 'Static' | 'Dynamic'; vendor: string; timeout: string }

export function arpTable(s: RootState): ArpRow[] {
  const cfg = s.config;
  const rows: ArpRow[] = [];
  for (const i of cfg.interfaces) {
    if (!hasAddress(i)) continue;
    rows.push({ ip: i.ip, mac: i.mac, iface: i.name, type: 'Static', vendor: 'ThreatWall', timeout: 'Permanent published' });
  }
  const byIp = new Map<string, ArpRow>();
  for (const h of HOSTS) {
    if (h.segment !== 'iface' && h.segment !== 'vlan') continue;
    const n = hostNet(s, h);
    if (!n || !n.iface || !hasAddress(n.iface) || !ifaceUp(s, n.iface).ok || !inSubnet(n.ip, n.iface.ip, n.iface.mask)) continue;
    const vendor = h.kind === 'printer' ? 'HP INC.' : h.id === 'rogue' ? 'UNKNOWN' : h.kind === 'server' ? 'VMWARE' : 'DELL INC.';
    // The rogue answers ARP last, so it wins the conflict unless ARP Lock pins the cache entry.
    byIp.set(`${n.iface.name}/${n.ip}`, { ip: n.ip, mac: n.mac ?? '', iface: n.iface.name, type: 'Dynamic', vendor, timeout: `Expires in ${3 + (n.ip.length % 7)} minutes` });
  }
  for (const [key, row] of byIp) {
    const [iface] = key.split('/');
    const as = cfg.antiSpoof.ifaces[iface];
    const locked = as?.enabled && as.arpLock ? cfg.antiSpoof.cache.find((c) => c.iface === iface && c.ip === row.ip && !c.blacklisted) : undefined;
    rows.push(locked ? { ...row, mac: locked.mac, type: 'Static', timeout: 'Locked (anti-spoof)' } : row);
  }
  for (const st of cfg.staticArp) rows.push({ ip: st.ip, mac: st.mac, iface: st.iface, type: 'Static', vendor: '', timeout: st.publish ? 'Permanent published' : 'Permanent' });
  for (const [wan, gw] of Object.entries(ISP_GATEWAYS)) {
    const i = ifaceByName(cfg, wan);
    if (i && hasAddress(i) && i.gateway === gw && ifaceUp(s, i).ok) rows.push({ ip: gw, mac: wan === 'X1' ? '00:0c:29:aa:10:01' : '00:0c:29:bb:20:01', iface: wan, type: 'Dynamic', vendor: 'ISP ROUTER', timeout: 'Expires in 10 minutes' });
  }
  return rows.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}

/* ------------------------------ WAN / SD-WAN / HA ------------------------------ */

export const WAN_LATENCY: Record<string, number> = { X1: 12, X3: 28 };

/** Link-level health: what the firewall knows without a probe. */
export function wanLinkUp(s: RootState, name: string): boolean {
  const i = ifaceByName(s.config, name);
  return !!i && i.zone === 'WAN' && i.enabled && i.link === 'up' && hasAddress(i) && i.gateway !== '0.0.0.0';
}
/** Real upstream health (ISP alive) — what a probe detects. */
export function wanPathUp(s: RootState, name: string): boolean {
  return wanLinkUp(s, name) && s.lab.isp[name] !== 'down' && ISP_GATEWAYS[name] === ifaceByName(s.config, name)?.gateway;
}

export function probeStatus(s: RootState, probeName: string, iface: string): 'up' | 'down' | 'n/a' {
  const p = s.config.sdwan.probes.find((x) => x.name === probeName);
  if (!p || !p.enabled || !p.ifaces.includes(iface)) return 'n/a';
  return wanPathUp(s, iface) ? 'up' : 'down';
}

export function sdwanChoose(s: RootState, profileName: string): { iface: string | null; reason: string } {
  const prof = s.config.sdwan.profiles.find((p) => p.name === profileName && p.enabled);
  if (!prof) return { iface: null, reason: `path selection profile ${profileName} not found or disabled` };
  const grp = s.config.sdwan.groups.find((g) => g.name === prof.group);
  if (!grp || !grp.members.length) return { iface: null, reason: `SD-WAN group ${prof.group} has no members` };
  for (const m of grp.members) {
    const probed = probeStatus(s, prof.probe, m);
    const healthy = probed === 'n/a' ? wanLinkUp(s, m) : probed === 'up';
    const sla = (WAN_LATENCY[m] ?? 50) <= prof.maxLatencyMs;
    if (healthy && sla) return { iface: m, reason: `${m} meets the SLA (${WAN_LATENCY[m]} ms, 0% loss)` };
  }
  if (prof.backup && wanLinkUp(s, prof.backup)) return { iface: prof.backup, reason: `no member met the SLA; using backup ${prof.backup}` };
  return { iface: null, reason: 'no SD-WAN member is healthy' };
}

export function haActiveUnit(s: RootState): 'primary' | 'secondary' | 'none' {
  if (s.lab.haPower.primary) return 'primary';
  const ha = s.config.ha;
  if (ha.mode === 'active-standby' && ha.synced && ha.secondarySerial && s.lab.haPower.secondary) return 'secondary';
  return 'none';
}

/* ------------------------------ Routing ------------------------------ */

export interface RouteResult {
  kind: 'local' | 'connected' | 'vpn' | 'sslvpn' | 'policy' | 'default' | 'none';
  iface?: string;
  zone?: string;
  gateway?: string;
  name: string;
  reason: string;
  policyId?: string;
}

function prefixLen(cfg: FirewallConfig, name: string): number {
  if (name === 'Any') return 0;
  const a = findAddress(cfg, name);
  if (a?.type === 'host') return 32;
  if (a?.type === 'network' && isIPv4(a.ip2)) return maskToPrefix(a.ip2);
  if (groupMembers(cfg, name)) return 16;
  return 24;
}

export const isPrivate = (ip: string) =>
  inSubnet(ip, '10.0.0.0', '255.0.0.0') || inSubnet(ip, '172.16.0.0', '255.240.0.0') || inSubnet(ip, '192.168.0.0', '255.255.0.0');

export function lookupRoute(s: RootState, dst: string, ctx: { src: string; proto: Proto; port: number }): RouteResult {
  const cfg = s.config;
  // 1. The firewall itself
  const own = cfg.interfaces.find((i) => hasAddress(i) && i.ip === dst);
  if (own) return { kind: 'local', iface: own.name, zone: own.zone!, name: `${own.name} IP`, reason: 'destination is the firewall' };

  // 2. Connected networks
  const conn = cfg.interfaces.find((i) => hasAddress(i) && inSubnet(dst, i.ip, i.mask));
  if (conn) {
    const up = ifaceUp(s, conn);
    if (!up.ok) return { kind: 'none', name: `${conn.name} Subnet`, reason: up.reason };
    return { kind: 'connected', iface: conn.name, zone: conn.zone!, name: `${conn.name} Subnet (connected)`, reason: `directly connected on ${conn.name}` };
  }

  // 3. SSL VPN clients
  if (cfg.sslvpn.pool && addrMatches(cfg, cfg.sslvpn.pool, dst)) {
    if (!s.lab.remoteUserConnected) return { kind: 'none', name: 'SSL VPN pool', reason: 'no SSL VPN client is connected with that address' };
    return { kind: 'sslvpn', iface: 'SSLVPN', zone: 'SSLVPN', name: 'SSL VPN client route', reason: 'address belongs to a connected NetExtender client' };
  }

  // 4. IPsec remote networks
  for (const p of cfg.ipsec) {
    if (p.kind !== 'site' || !p.enabled) continue;
    if (!addrMatches(cfg, p.remoteNet, dst)) continue;
    const t = tunnelStatus(s, p.id);
    if (t.state !== 'up') return { kind: 'none', name: `VPN: ${p.name}`, reason: `the tunnel ${p.name} is down: ${t.reason}`, policyId: p.id };
    return { kind: 'vpn', iface: 'VPN', zone: 'VPN', name: `VPN: ${p.name}`, reason: `remote network of tunnel ${p.name}`, policyId: p.id };
  }

  // 5. Route policies (most specific destination first, then order)
  const candidates = cfg.routes
    .filter((r) => r.enabled && addrMatches(cfg, r.dst, dst) && addrMatches(cfg, r.src, ctx.src) && serviceMatches(cfg, r.service, ctx.proto, ctx.port))
    .sort((a, b) => prefixLen(cfg, b.dst) - prefixLen(cfg, a.dst));
  for (const r of candidates) {
    if (r.type === 'sdwan') {
      const c = sdwanChoose(s, r.pathProfile);
      if (!c.iface) continue;
      const i = ifaceByName(cfg, c.iface)!;
      return { kind: 'policy', iface: i.name, zone: i.zone!, gateway: i.gateway, name: r.name, reason: `SD-WAN route via ${c.iface}: ${c.reason}`, policyId: r.id };
    }
    const i = ifaceByName(cfg, r.iface);
    if (!i || !ifaceUp(s, i).ok) continue;
    return { kind: 'policy', iface: i.name, zone: i.zone!, gateway: r.gateway, name: r.name, reason: `route policy ${r.name} via ${i.name}`, policyId: r.id };
  }

  // 6. Default route: the first WAN interface with a gateway (no automatic failover without SD-WAN).
  if (isPrivate(dst)) return { kind: 'none', name: '—', reason: `no route to private address ${dst}` };
  const wan = cfg.interfaces.find((i) => i.zone === 'WAN' && hasAddress(i) && i.gateway !== '0.0.0.0' && i.enabled);
  if (!wan) return { kind: 'none', name: 'Default route', reason: 'no default route: no WAN interface has a static address and gateway' };
  if (!ifaceUp(s, wan).ok) return { kind: 'none', name: 'Default route', reason: `${wan.name} is down` };
  return { kind: 'default', iface: wan.name, zone: 'WAN', gateway: wan.gateway, name: `Default Route (${wan.name})`, reason: `default route via ${wan.name}, gateway ${wan.gateway}` };
}

/** Connected + default routes the appliance builds itself, for the Routing Rules page. */
export function builtInRoutes(cfg: FirewallConfig): { name: string; src: string; dst: string; iface: string; gateway: string; metric: number }[] {
  const out: { name: string; src: string; dst: string; iface: string; gateway: string; metric: number }[] = [];
  cfg.interfaces.filter(hasAddress).forEach((i) => out.push({ name: `${i.name} connected`, src: 'Any', dst: `${i.name} Subnet`, iface: i.name, gateway: '0.0.0.0', metric: 20 }));
  cfg.interfaces.filter((i) => hasAddress(i) && i.zone === 'WAN' && i.gateway !== '0.0.0.0')
    .forEach((i, n) => out.push({ name: `Default Route (${i.name})`, src: 'Any', dst: '0.0.0.0/0', iface: i.name, gateway: i.gateway, metric: n === 0 ? 20 : 30 }));
  return out;
}

export const networkLabel = (ip: string, mask: string) => `${networkOf(ip, mask)}/${maskToPrefix(mask)}`;
