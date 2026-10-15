/** Address/service/schedule resolution shared by the engine and every object selector. */
import type { AddressObject, FirewallConfig, NetInterface, Proto, RootState } from '../state/types';
import { inSubnet, ipToInt, isIPv4, cidr } from '../lib/ip';
import { siteByName } from './world';

export interface ResolvedAddr { name: string; kind: 'any' | 'host' | 'network' | 'range' | 'fqdn' | 'group'; zone: string; detail: string; builtIn: boolean }

const hasIp = (i: NetInterface) => i.zone !== null && i.ip !== '0.0.0.0' && i.mode !== 'unassigned';

/** Default (computed) address objects, derived from interfaces like a real appliance does. */
export function builtInAddresses(cfg: FirewallConfig): AddressObject[] {
  const out: AddressObject[] = [];
  for (const i of cfg.interfaces) {
    if (!hasIp(i)) continue;
    const z = i.zone ?? '';
    out.push({ id: `bi-${i.name}-ip`, name: `${i.name} IP`, zone: z, type: 'host', ip: i.ip, ip2: '255.255.255.255', fqdn: '', comment: 'Default' });
    out.push({ id: `bi-${i.name}-sn`, name: `${i.name} Subnet`, zone: z, type: 'network', ip: i.ip, ip2: i.mask, fqdn: '', comment: 'Default' });
    if (i.gateway && i.gateway !== '0.0.0.0') {
      out.push({ id: `bi-${i.name}-gw`, name: `${i.name} Default Gateway`, zone: z, type: 'host', ip: i.gateway, ip2: '255.255.255.255', fqdn: '', comment: 'Default' });
    }
  }
  return out;
}

/** Default (computed) groups: "<ZONE> Subnets". */
export function builtInGroups(cfg: FirewallConfig): { name: string; members: string[] }[] {
  const zones = new Set(cfg.interfaces.filter(hasIp).map((i) => i.zone as string));
  return [...zones].map((z) => ({ name: `${z} Subnets`, members: cfg.interfaces.filter((i) => hasIp(i) && i.zone === z).map((i) => `${i.name} Subnet`) }));
}

export function allAddressNames(cfg: FirewallConfig): string[] {
  return [
    ...builtInGroups(cfg).map((g) => g.name),
    ...builtInAddresses(cfg).map((a) => a.name),
    ...cfg.addresses.map((a) => a.name),
    ...cfg.addressGroups.map((g) => g.name),
  ];
}

export function findAddress(cfg: FirewallConfig, name: string): AddressObject | undefined {
  return cfg.addresses.find((a) => a.name === name) ?? builtInAddresses(cfg).find((a) => a.name === name);
}

export function groupMembers(cfg: FirewallConfig, name: string): string[] | undefined {
  return cfg.addressGroups.find((g) => g.name === name)?.members ?? builtInGroups(cfg).find((g) => g.name === name)?.members;
}

export function resolveFqdn(fqdn: string): string | null {
  return siteByName(fqdn)?.ip ?? null;
}

/** Does `ip` fall inside address object/group `name`? */
export function addrMatches(cfg: FirewallConfig, name: string, ip: string, seen = new Set<string>()): boolean {
  if (name === 'Any' || name === '') return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const members = groupMembers(cfg, name);
  if (members) return members.some((m) => addrMatches(cfg, m, ip, seen));
  const a = findAddress(cfg, name);
  if (!a) return false;
  return objectContains(a, ip);
}

export function objectContains(a: AddressObject, ip: string): boolean {
  switch (a.type) {
    case 'host': return a.ip === ip;
    case 'network': return isIPv4(a.ip) && isIPv4(a.ip2) && inSubnet(ip, a.ip, a.ip2);
    case 'range': return isIPv4(a.ip) && isIPv4(a.ip2) && ipToInt(ip) >= ipToInt(a.ip) && ipToInt(ip) <= ipToInt(a.ip2);
    case 'fqdn': return resolveFqdn(a.fqdn) === ip;
  }
}

export function describeAddress(a: AddressObject): string {
  switch (a.type) {
    case 'host': return `${a.ip}/255.255.255.255`;
    case 'network': return isIPv4(a.ip) && isIPv4(a.ip2) ? `${cidr(a.ip, a.ip2)} (${a.ip2})` : `${a.ip}/${a.ip2}`;
    case 'range': return `${a.ip} - ${a.ip2}`;
    case 'fqdn': return a.fqdn;
  }
}

/** Networks an address object/group covers, as [ip, mask] pairs (FQDN/range ignored). Used for VPN selectors. */
export function addrNetworks(cfg: FirewallConfig, name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const members = groupMembers(cfg, name);
  if (members) return members.flatMap((m) => addrNetworks(cfg, m, seen)).sort();
  const a = findAddress(cfg, name);
  if (!a) return [];
  if (a.type === 'network' && isIPv4(a.ip) && isIPv4(a.ip2)) return [cidr(a.ip, a.ip2)];
  if (a.type === 'host') return [`${a.ip}/32`];
  if (a.type === 'range') return [`${a.ip}-${a.ip2}`];
  return [];
}

/* ----------------------------- Services ----------------------------- */

export function allServiceNames(cfg: FirewallConfig): string[] {
  return [...cfg.serviceGroups.map((g) => g.name), ...cfg.services.map((s) => s.name)];
}

export function serviceMatches(cfg: FirewallConfig, name: string, proto: Proto, port: number, seen = new Set<string>()): boolean {
  if (name === 'Any' || name === '') return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const g = cfg.serviceGroups.find((x) => x.name === name);
  if (g) return g.members.some((m) => serviceMatches(cfg, m, proto, port, seen));
  const s = cfg.services.find((x) => x.name === name);
  if (!s || s.protocol !== proto) return false;
  if (proto === 'ICMP' || proto === 'ESP') return true;
  return port >= s.portStart && port <= s.portEnd;
}

export function serviceLabel(proto: Proto, port: number): string {
  const known: Record<string, string> = { 'TCP/80': 'HTTP', 'TCP/443': 'HTTPS', 'UDP/53': 'DNS', 'TCP/53': 'DNS', 'TCP/22': 'SSH', 'TCP/8443': 'TCP 8443', 'TCP/4433': 'SSL VPN', 'UDP/500': 'IKE', 'TCP/3389': 'RDP' };
  if (proto === 'ICMP') return 'Ping (ICMP)';
  return known[`${proto}/${port}`] ?? `${proto} ${port}`;
}

/* ----------------------------- Schedules / clock ----------------------------- */

export const labNow = (s: Pick<RootState, 'lab'>): number => s.lab.clockOverride ?? Date.now();

/** Day-of-week (0=Sun) and minutes since midnight in the appliance's time zone. */
export function localTime(ts: number, tz: string): { day: number; minutes: number; label: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const h = Number(get('hour')) % 24;
  const m = Number(get('minute'));
  return { day, minutes: h * 60 + m, label: `${get('weekday')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
}

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function scheduleActive(cfg: FirewallConfig, name: string, ts: number): boolean {
  if (name === 'Always' || name === '') return true;
  const s = cfg.schedules.find((x) => x.name === name);
  if (!s) return false;
  const t = localTime(ts, cfg.system.timezone);
  return s.days.includes(t.day) && t.minutes >= toMin(s.start) && t.minutes < toMin(s.end);
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Epoch ms for weekday `day` (0=Sun) at `hhmm` in the appliance time zone, in the week of `near`. */
export function tsAt(day: number, hhmm: string, tz: string, near: number): number {
  const base = Math.floor(near / 60_000) * 60_000;
  const lt = localTime(base, tz);
  const want = day * 1440 + toMin(hhmm);
  const have = lt.day * 1440 + lt.minutes;
  return base + (want - have) * 60_000;
}
