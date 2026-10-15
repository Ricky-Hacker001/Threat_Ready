/** DHCP server, static ARP, MAC-IP anti-spoof and DNS settings. */
import type { AntiSpoofEntry, AntiSpoofIface, DhcpConfig, DhcpScope, DhcpStatic, DnsSettings, FirewallConfig, StaticArp } from '../state/types';
import type { AuditInput } from '../state/store';
import { hasAddress } from '../engine/network';
import { inSubnet, ipToInt, isIPv4, isMac } from '../lib/ip';
import { uid } from '../lib/hash';
import { defaultAntiSpoof } from '../state/baseline';

type Errors = Record<string, string>;
type Result = { next: FirewallConfig; audit: AuditInput[] };
export const normMac = (m: string) => m.trim().toLowerCase().replace(/-/g, ':');

/* ------------------------------ DHCP ------------------------------ */

export function saveDhcpSettings(cfg: FirewallConfig, patch: Partial<Pick<DhcpConfig, 'enabled' | 'conflictDetection'>>): Result {
  const dhcp = { ...cfg.dhcp, ...patch };
  return { next: { ...cfg, dhcp }, audit: [{ category: 'Network', action: 'DHCP server settings modified', detail: `DHCP server ${dhcp.enabled ? 'enabled' : 'disabled'}, conflict detection ${dhcp.conflictDetection ? 'on' : 'off'}` }] };
}

export const blankScope = (cfg: FirewallConfig): DhcpScope => {
  const i = cfg.interfaces.find((x) => x.name === 'X0');
  return { id: '', iface: 'X0', start: '', end: '', gateway: i?.ip ?? '', dns: ['', ''], leaseMin: 1440, enabled: true, comment: '' };
};

export function validateScope(cfg: FirewallConfig, sc: DhcpScope, originalId: string | null): Errors {
  const e: Errors = {};
  const i = cfg.interfaces.find((x) => x.name === sc.iface);
  if (!i || !hasAddress(i)) { e.iface = 'Choose an interface that has a static IP address.'; return e; }
  const net = `${i.ip}/${i.mask}`;
  if (!isIPv4(sc.start)) e.start = 'Enter the first address of the range.';
  else if (!inSubnet(sc.start, i.ip, i.mask)) e.start = `${sc.start} is not in ${i.name}’s subnet (${net}).`;
  if (!isIPv4(sc.end)) e.end = 'Enter the last address of the range.';
  else if (!inSubnet(sc.end, i.ip, i.mask)) e.end = `${sc.end} is not in ${i.name}’s subnet (${net}).`;
  else if (isIPv4(sc.start) && ipToInt(sc.end) < ipToInt(sc.start)) e.end = 'Range end must not be lower than the start.';
  if (!e.start && !e.end && ipToInt(i.ip) >= ipToInt(sc.start) && ipToInt(i.ip) <= ipToInt(sc.end)) e.start = `The range includes the interface address ${i.ip}.`;
  if (!e.start && !e.end) {
    const clash = cfg.dhcp.scopes.find((x) => x.id !== originalId && x.iface === sc.iface && isIPv4(x.start) && isIPv4(x.end) && ipToInt(sc.start) <= ipToInt(x.end) && ipToInt(x.start) <= ipToInt(sc.end));
    if (clash) e.start = `Overlaps the existing scope ${clash.start}–${clash.end}.`;
  }
  if (!isIPv4(sc.gateway)) e.gateway = 'Enter the default gateway clients should use (normally the interface IP).';
  else if (!inSubnet(sc.gateway, i.ip, i.mask)) e.gateway = `Gateway ${sc.gateway} is not in ${net}. Clients could never reach it.`;
  sc.dns.forEach((d, n) => { if (d && !isIPv4(d)) e[`dns${n}`] = 'Enter a valid IPv4 address or leave empty.'; });
  if (!sc.dns[0]) e.dns0 = 'Give clients at least one DNS server.';
  if (!(sc.leaseMin >= 1 && sc.leaseMin <= 9999999)) e.leaseMin = 'Lease time must be a positive number of minutes.';
  return e;
}

export function saveScope(cfg: FirewallConfig, input: DhcpScope, originalId: string | null): Result {
  const sc = { ...input, id: input.id || uid(), dns: [input.dns[0] || '0.0.0.0', input.dns[1] || '0.0.0.0'] as [string, string] };
  const detail = `${sc.iface} ${sc.start}–${sc.end}, gateway ${sc.gateway}, DNS ${sc.dns.filter((d) => d !== '0.0.0.0').join('/')}, lease ${sc.leaseMin} min`;
  const scopes = originalId ? cfg.dhcp.scopes.map((x) => (x.id === originalId ? sc : x)) : [...cfg.dhcp.scopes, sc];
  return { next: { ...cfg, dhcp: { ...cfg.dhcp, scopes } }, audit: [{ category: 'Network', action: `DHCP scope ${originalId ? 'modified' : 'added'}`, detail }] };
}

export function deleteScope(cfg: FirewallConfig, id: string): Result {
  const sc = cfg.dhcp.scopes.find((x) => x.id === id)!;
  return { next: { ...cfg, dhcp: { ...cfg.dhcp, scopes: cfg.dhcp.scopes.filter((x) => x.id !== id) } }, audit: [{ category: 'Network', action: 'DHCP scope deleted', detail: `${sc.iface} ${sc.start}–${sc.end}` }] };
}

export const blankStatic = (): DhcpStatic => ({ id: '', name: '', ip: '', mac: '', enabled: true });

export function validateStatic(cfg: FirewallConfig, st: DhcpStatic, originalId: string | null): Errors {
  const e: Errors = {};
  if (!st.name.trim()) e.name = 'Enter a name, e.g. PRINTER-01.';
  if (!isIPv4(st.ip)) e.ip = 'Enter the address to reserve.';
  else {
    const i = cfg.interfaces.find((x) => hasAddress(x) && inSubnet(st.ip, x.ip, x.mask));
    if (!i) e.ip = `${st.ip} is not in any interface subnet.`;
    else if (i.ip === st.ip) e.ip = `${st.ip} is the firewall’s own ${i.name} address.`;
  }
  if (!isMac(normMac(st.mac))) e.mac = 'Enter the MAC address, e.g. 00:1a:2b:3c:4d:50.';
  const others = cfg.dhcp.statics.filter((x) => x.id !== originalId);
  if (!e.ip && others.some((x) => x.ip === st.ip)) e.ip = `${st.ip} is already reserved.`;
  if (!e.mac && others.some((x) => normMac(x.mac) === normMac(st.mac))) e.mac = 'This MAC already has a reservation.';
  return e;
}

export function saveStatic(cfg: FirewallConfig, input: DhcpStatic, originalId: string | null): Result {
  const st = { ...input, id: input.id || uid(), name: input.name.trim(), mac: normMac(input.mac) };
  const statics = originalId ? cfg.dhcp.statics.map((x) => (x.id === originalId ? st : x)) : [...cfg.dhcp.statics, st];
  return { next: { ...cfg, dhcp: { ...cfg.dhcp, statics } }, audit: [{ category: 'Network', action: `DHCP reservation ${originalId ? 'modified' : 'added'}`, detail: `${st.name} ${st.ip} ↔ ${st.mac}` }] };
}

export function deleteStatic(cfg: FirewallConfig, id: string): Result {
  const st = cfg.dhcp.statics.find((x) => x.id === id)!;
  return { next: { ...cfg, dhcp: { ...cfg.dhcp, statics: cfg.dhcp.statics.filter((x) => x.id !== id) } }, audit: [{ category: 'Network', action: 'DHCP reservation deleted', detail: `${st.name} ${st.ip}` }] };
}

/* ------------------------------ Static ARP ------------------------------ */

export function validateArp(cfg: FirewallConfig, a: StaticArp): Errors {
  const e: Errors = {};
  const i = cfg.interfaces.find((x) => x.name === a.iface);
  if (!i || !hasAddress(i)) e.iface = 'Choose an interface with an IP address.';
  if (!isIPv4(a.ip)) e.ip = 'Enter an IPv4 address.';
  else if (i && hasAddress(i) && !inSubnet(a.ip, i.ip, i.mask)) e.ip = `${a.ip} is not in ${i.name}’s subnet.`;
  if (!isMac(normMac(a.mac))) e.mac = 'Enter a MAC address.';
  if (cfg.staticArp.some((x) => x.ip === a.ip && x.id !== a.id)) e.ip = 'A static entry for this IP already exists.';
  return e;
}

export function saveArp(cfg: FirewallConfig, input: StaticArp): Result {
  const a = { ...input, id: input.id || uid(), mac: normMac(input.mac) };
  const exists = cfg.staticArp.some((x) => x.id === a.id);
  return { next: { ...cfg, staticArp: exists ? cfg.staticArp.map((x) => (x.id === a.id ? a : x)) : [...cfg.staticArp, a] }, audit: [{ category: 'Network', action: 'Static ARP entry saved', detail: `${a.ip} ↔ ${a.mac} on ${a.iface}` }] };
}

export function deleteArp(cfg: FirewallConfig, id: string): Result {
  const a = cfg.staticArp.find((x) => x.id === id)!;
  return { next: { ...cfg, staticArp: cfg.staticArp.filter((x) => x.id !== id) }, audit: [{ category: 'Network', action: 'Static ARP entry deleted', detail: `${a.ip} on ${a.iface}` }] };
}

/* ------------------------------ MAC-IP anti-spoof ------------------------------ */

export const ifaceSpoof = (cfg: FirewallConfig, name: string): AntiSpoofIface => cfg.antiSpoof.ifaces[name] ?? defaultAntiSpoof();

export function saveSpoofIface(cfg: FirewallConfig, name: string, s: AntiSpoofIface): Result {
  const on = Object.entries(s).filter(([, v]) => v).map(([k]) => k).join(', ') || 'all off';
  return { next: { ...cfg, antiSpoof: { ...cfg.antiSpoof, ifaces: { ...cfg.antiSpoof.ifaces, [name]: s } } }, audit: [{ category: 'Network', action: `MAC-IP anti-spoof settings for ${name} modified`, detail: on }] };
}

export const blankSpoofEntry = (): AntiSpoofEntry => ({ id: '', iface: 'X0', ip: '', mac: '', router: false, blacklisted: false, comment: '' });

export function validateSpoofEntry(cfg: FirewallConfig, en: AntiSpoofEntry): Errors {
  const e: Errors = {};
  const i = cfg.interfaces.find((x) => x.name === en.iface);
  if (!i || !hasAddress(i)) e.iface = 'Choose an interface with an IP address.';
  if (!isIPv4(en.ip)) e.ip = 'Enter the IP address.';
  else if (i && hasAddress(i) && !inSubnet(en.ip, i.ip, i.mask)) e.ip = `${en.ip} is not in ${i.name}’s subnet (${i.ip}/${i.mask}).`;
  if (!isMac(normMac(en.mac))) e.mac = 'Enter the MAC address (from the device label or the ARP page).';
  if (!e.ip && !e.mac && cfg.antiSpoof.cache.some((x) => x.id !== en.id && x.iface === en.iface && x.ip === en.ip && normMac(x.mac) === normMac(en.mac))) e.mac = 'This IP/MAC pair is already in the cache.';
  return e;
}

export function saveSpoofEntry(cfg: FirewallConfig, input: AntiSpoofEntry): Result {
  const en = { ...input, id: input.id || uid(), mac: normMac(input.mac) };
  const exists = cfg.antiSpoof.cache.some((x) => x.id === en.id);
  const cache = exists ? cfg.antiSpoof.cache.map((x) => (x.id === en.id ? en : x)) : [...cfg.antiSpoof.cache, en];
  return { next: { ...cfg, antiSpoof: { ...cfg.antiSpoof, cache } }, audit: [{ category: 'Network', action: `Anti-spoof cache entry ${exists ? 'modified' : 'added'}`, detail: `${en.ip} ↔ ${en.mac} on ${en.iface}${en.blacklisted ? ' (blacklisted)' : ''}` }] };
}

export function deleteSpoofEntries(cfg: FirewallConfig, ids: string[]): Result {
  const gone = cfg.antiSpoof.cache.filter((x) => ids.includes(x.id));
  return { next: { ...cfg, antiSpoof: { ...cfg.antiSpoof, cache: cfg.antiSpoof.cache.filter((x) => !ids.includes(x.id)) } }, audit: gone.map((g) => ({ category: 'Network' as const, action: 'Anti-spoof cache entry deleted', detail: `${g.ip} ↔ ${g.mac}` })) };
}

/* ------------------------------ DNS ------------------------------ */

export function validateDns(d: DnsSettings): Errors {
  const e: Errors = {};
  if (d.mode === 'static') {
    d.servers.forEach((x, n) => { if (x && x !== '0.0.0.0' && !isIPv4(x)) e[`s${n}`] = 'Enter a valid IPv4 address.'; });
    if (!d.servers[0] || d.servers[0] === '0.0.0.0') e.s0 = 'Enter at least the primary DNS server.';
  }
  return e;
}

export function saveDns(cfg: FirewallConfig, d: DnsSettings): Result {
  const dns: DnsSettings = { mode: d.mode, servers: d.servers.map((x) => x || '0.0.0.0') as DnsSettings['servers'] };
  return { next: { ...cfg, dns }, audit: [{ category: 'Network', action: 'DNS settings modified', detail: dns.mode === 'inherit' ? 'Inherit DNS settings dynamically from WAN zone' : `Static: ${dns.servers.filter((x) => x !== '0.0.0.0').join(', ')}` }] };
}
