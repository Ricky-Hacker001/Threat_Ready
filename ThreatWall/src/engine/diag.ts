/** Diagnostics run FROM the firewall itself (DEVICE › Diagnostics). Pure and simulated: nothing touches the host OS or a real network. */
import type { RootState } from '../state/types';
import { HOSTS, ISP_GATEWAYS, SITES } from './world';
import { hasAddress, hostNet, ifaceUp, lookupRoute } from './network';
import { firewallDns, firewallInternet } from './traffic';
import { resolveFqdn } from './objects';
import { inSubnet, isIPv4 } from '../lib/ip';

export interface DiagResult { ok: boolean; ip: string; lines: string[]; reason: string }

export function fwResolve(s: RootState, name: string): { ok: boolean; ip: string; reason: string } {
  if (isIPv4(name)) return { ok: true, ip: name, reason: '' };
  const servers = firewallDns(s);
  if (!servers.length) return { ok: false, ip: '', reason: 'the firewall has no DNS servers (NETWORK › DNS › DNS Settings, or WAN interface DNS)' };
  const net = firewallInternet(s);
  if (!net.ok) return { ok: false, ip: '', reason: `DNS servers ${servers.join(', ')} are unreachable: ${net.reason}` };
  const ip = resolveFqdn(name);
  if (!ip) return { ok: false, ip: '', reason: `${name}: name does not exist (NXDOMAIN)` };
  return { ok: true, ip, reason: `resolved by ${servers[0]}` };
}

/** Can the firewall reach `ip`? */
function reach(s: RootState, ip: string): { ok: boolean; reason: string; via: string } {
  const cfg = s.config;
  if (cfg.interfaces.some((i) => hasAddress(i) && i.ip === ip)) return { ok: true, reason: 'own address', via: 'local' };
  // ISP routers
  for (const [wan, gw] of Object.entries(ISP_GATEWAYS)) {
    if (ip !== gw) continue;
    const i = cfg.interfaces.find((x) => x.name === wan);
    if (!i || !hasAddress(i)) return { ok: false, reason: `${wan} has no static address, so ${gw} is not on any connected network`, via: '' };
    if (!inSubnet(ip, i.ip, i.mask)) return { ok: false, reason: `${gw} is not in ${wan}’s subnet ${i.ip}/${i.mask}`, via: '' };
    if (!ifaceUp(s, i).ok) return { ok: false, reason: `${wan} is down`, via: '' };
    if (s.lab.isp[wan] === 'down') return { ok: false, reason: `the ISP router on ${wan} is not answering`, via: wan };
    return { ok: true, reason: `directly connected on ${wan}`, via: wan };
  }
  const r = lookupRoute(s, ip, { src: '0.0.0.0', proto: 'ICMP', port: 0 });
  if (r.kind === 'none') return { ok: false, reason: r.reason, via: '' };
  if (r.kind === 'connected') {
    const host = HOSTS.find((h) => hostNet(s, h)?.ip === ip);
    return host ? { ok: true, reason: `${host.name} on ${r.iface}`, via: r.iface ?? '' } : { ok: false, reason: `no device answers at ${ip} on ${r.iface}`, via: r.iface ?? '' };
  }
  if (r.kind === 'vpn' || r.kind === 'sslvpn') return { ok: true, reason: r.reason, via: r.iface ?? '' };
  // internet
  const i = cfg.interfaces.find((x) => x.name === r.iface);
  const realGw = ISP_GATEWAYS[r.iface ?? ''];
  if (s.lab.isp[r.iface ?? ''] === 'down') return { ok: false, reason: `ISP upstream on ${r.iface} is down`, via: r.iface ?? '' };
  if (i && realGw && (r.gateway ?? i.gateway) !== realGw) return { ok: false, reason: `next hop ${r.gateway ?? i.gateway} does not answer on ${r.iface} (the ISP router is ${realGw})`, via: r.iface ?? '' };
  const known = SITES.some((x) => x.ip === ip) || ['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1'].includes(ip);
  return known ? { ok: true, reason: r.reason, via: r.iface ?? '' } : { ok: false, reason: `${ip} does not answer ICMP`, via: r.iface ?? '' };
}

export function fwPing(s: RootState, target: string): DiagResult {
  const t = target.trim();
  const res = fwResolve(s, t);
  if (!res.ok) return { ok: false, ip: '', lines: [`ping: cannot resolve ${t}`, `  ${res.reason}`], reason: res.reason };
  const r = reach(s, res.ip);
  const head = `PING ${t}${t !== res.ip ? ` (${res.ip})` : ''}${r.via && r.via !== 'local' ? ` via ${r.via}` : ''}`;
  if (!r.ok) return { ok: false, ip: res.ip, lines: [head, 'Request timed out.', 'Request timed out.', 'Request timed out.', `--- ${t}: 0 of 3 replies — ${r.reason}`], reason: r.reason };
  const ms = r.via === 'local' || r.via.startsWith('X0') ? 1 : r.via === 'X3' ? 28 : 12;
  return { ok: true, ip: res.ip, lines: [head, ...[0, 1, 2].map(() => `${res.ip} is alive, time=${ms} ms`), `--- ${t}: 3 of 3 replies`], reason: r.reason };
}

export function fwLookup(s: RootState, name: string): DiagResult {
  const r = fwResolve(s, name.trim());
  const servers = firewallDns(s);
  return r.ok
    ? { ok: true, ip: r.ip, lines: [`Server: ${servers[0]}`, `Name: ${name}`, `Address: ${r.ip}`], reason: r.reason }
    : { ok: false, ip: '', lines: [`Server: ${servers[0] ?? '(none)'}`, `** lookup failed: ${r.reason}`], reason: r.reason };
}

export function fwTrace(s: RootState, target: string): DiagResult {
  const res = fwResolve(s, target.trim());
  if (!res.ok) return { ok: false, ip: '', lines: [`traceroute: cannot resolve ${target}`], reason: res.reason };
  const r = lookupRoute(s, res.ip, { src: '0.0.0.0', proto: 'ICMP', port: 0 });
  const p = fwPing(s, res.ip);
  const lines = [`traceroute to ${target} (${res.ip})`];
  if (r.kind === 'default' || r.kind === 'policy') {
    lines.push(`1  ${r.gateway ?? '?'}  ${p.ok ? '11 ms' : '* * *'}`);
    if (p.ok) lines.push(`2  isp-core.example (192.0.2.254)  14 ms`, `3  ${res.ip}  16 ms`);
  } else lines.push(`1  ${res.ip}  ${p.ok ? '1 ms' : '* * *'}`);
  return { ok: p.ok, ip: res.ip, lines, reason: p.reason };
}
