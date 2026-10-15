/** Address objects/groups, service objects/groups and schedules: validation, save, delete, reference checks. */
import type { AddressGroup, AddressObject, FirewallConfig, Schedule, ServiceGroup, ServiceObject } from '../state/types';
import type { AuditInput } from '../state/store';
import { allAddressNames, allServiceNames, builtInAddresses, builtInGroups, describeAddress } from '../engine/objects';
import { ipToInt, isIPv4, isMask, networkOf } from '../lib/ip';
import { uid } from '../lib/hash';

type Errors = Record<string, string>;
type Result = { next: FirewallConfig; audit: AuditInput[] };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,63}$/;
const FQDN_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Every place an address or service name is used — deletion is blocked while any reference remains. */
export function referencesOf(cfg: FirewallConfig, name: string): string[] {
  const refs: string[] = [];
  cfg.addressGroups.forEach((g) => g.members.includes(name) && refs.push(`address group ${g.name}`));
  cfg.serviceGroups.forEach((g) => g.members.includes(name) && refs.push(`service group ${g.name}`));
  cfg.accessRules.forEach((r) => [r.src, r.dst, r.service].includes(name) && refs.push(`access rule ${r.name}`));
  cfg.accessRules.forEach((r) => r.schedule === name && refs.push(`access rule ${r.name} (schedule)`));
  cfg.natRules.forEach((n) => [n.origSrc, n.transSrc, n.origDst, n.transDst, n.origSvc, n.transSvc].includes(name) && refs.push(`NAT policy ${n.name}`));
  cfg.routes.forEach((r) => [r.src, r.dst, r.service].includes(name) && refs.push(`route ${r.name}`));
  if (cfg.sslvpn.pool === name || cfg.sslvpn.clientRoutes.includes(name)) refs.push('SSL VPN settings');
  cfg.ipsec.forEach((p) => [p.localNet, p.remoteNet].includes(name) && refs.push(`VPN policy ${p.name}`));
  return refs;
}

/* ------------------------------ Address objects ------------------------------ */

export const blankAddress = (): AddressObject => ({ id: '', name: '', zone: 'LAN', type: 'host', ip: '', ip2: '255.255.255.0', fqdn: '', comment: '' });

export function validateAddress(cfg: FirewallConfig, a: AddressObject, original: string | null): Errors {
  const e: Errors = {};
  if (!NAME_RE.test(a.name)) e.name = 'Enter a name (letters, digits, space, _ . - ( )).';
  else if (a.name !== original && allAddressNames(cfg).some((n) => n.toLowerCase() === a.name.toLowerCase())) e.name = `An address object or group named “${a.name}” already exists.`;
  if (!cfg.zones.some((z) => z.name === a.zone)) e.zone = 'Choose a zone.';
  if (a.type === 'host' && !isIPv4(a.ip)) e.ip = 'Enter a valid IPv4 address, e.g. 172.16.10.100.';
  if (a.type === 'range') {
    if (!isIPv4(a.ip)) e.ip = 'Enter the first address of the range.';
    if (!isIPv4(a.ip2)) e.ip2 = 'Enter the last address of the range.';
    else if (isIPv4(a.ip) && ipToInt(a.ip2) < ipToInt(a.ip)) e.ip2 = 'The end address must not be lower than the start.';
  }
  if (a.type === 'network') {
    if (!isIPv4(a.ip)) e.ip = 'Enter the network address, e.g. 192.168.10.0.';
    if (!isMask(a.ip2)) e.ip2 = 'Enter a subnet mask, e.g. 255.255.255.0.';
    else if (isIPv4(a.ip) && networkOf(a.ip, a.ip2) !== a.ip) e.ip = `${a.ip} is a host address, not the network address. With mask ${a.ip2} the network is ${networkOf(a.ip, a.ip2)}.`;
  }
  if (a.type === 'fqdn' && !FQDN_RE.test(a.fqdn)) e.fqdn = 'Enter a fully qualified domain name, e.g. updates.vendor.example.';
  return e;
}

export function normaliseAddress(a: AddressObject): AddressObject {
  if (a.type === 'host') return { ...a, ip2: '255.255.255.255', fqdn: '' };
  if (a.type === 'fqdn') return { ...a, ip: '', ip2: '', fqdn: a.fqdn.trim().toLowerCase() };
  return { ...a, fqdn: '' };
}

export function saveAddress(cfg: FirewallConfig, input: AddressObject, original: string | null): Result {
  const a = normaliseAddress({ ...input, id: input.id || uid() });
  if (original === null) return { next: { ...cfg, addresses: [...cfg.addresses, a] }, audit: [{ category: 'Object', action: `Address object ${a.name} added`, detail: `${a.type}, zone ${a.zone}: ${describeAddress(a)}` }] };
  const next = renameEverywhere({ ...cfg, addresses: cfg.addresses.map((x) => (x.name === original ? a : x)) }, original, a.name);
  return { next, audit: [{ category: 'Object', action: `Address object ${a.name} modified`, detail: `${a.type}, zone ${a.zone}: ${describeAddress(a)}` }] };
}

function renameEverywhere(cfg: FirewallConfig, from: string, to: string): FirewallConfig {
  if (from === to) return cfg;
  const r = (v: string) => (v === from ? to : v);
  return {
    ...cfg,
    addressGroups: cfg.addressGroups.map((g) => ({ ...g, members: g.members.map(r) })),
    serviceGroups: cfg.serviceGroups.map((g) => ({ ...g, members: g.members.map(r) })),
    accessRules: cfg.accessRules.map((x) => ({ ...x, src: r(x.src), dst: r(x.dst), service: r(x.service), schedule: r(x.schedule) })),
    natRules: cfg.natRules.map((n) => ({ ...n, origSrc: r(n.origSrc), transSrc: r(n.transSrc), origDst: r(n.origDst), transDst: r(n.transDst), origSvc: r(n.origSvc), transSvc: r(n.transSvc) })),
    routes: cfg.routes.map((x) => ({ ...x, src: r(x.src), dst: r(x.dst), service: r(x.service) })),
    sslvpn: { ...cfg.sslvpn, pool: r(cfg.sslvpn.pool), clientRoutes: cfg.sslvpn.clientRoutes.map(r) },
    ipsec: cfg.ipsec.map((p) => ({ ...p, localNet: r(p.localNet), remoteNet: r(p.remoteNet) })),
  };
}

export function deleteAddresses(cfg: FirewallConfig, names: string[]): Result & { error?: string } {
  const used = names.map((n) => [n, referencesOf(cfg, n)] as const).filter(([, r]) => r.length);
  if (used.length) return { next: cfg, audit: [], error: `Still in use: ${used.map(([n, r]) => `${n} (${r.join(', ')})`).join('; ')}. Remove those references first.` };
  return {
    next: { ...cfg, addresses: cfg.addresses.filter((a) => !names.includes(a.name)), addressGroups: cfg.addressGroups.filter((g) => !names.includes(g.name)) },
    audit: names.map((n) => ({ category: 'Object' as const, action: `Address object ${n} deleted`, detail: '' })),
  };
}

/* ------------------------------ Address groups ------------------------------ */

export function validateAddrGroup(cfg: FirewallConfig, g: AddressGroup, original: string | null): Errors {
  const e: Errors = {};
  if (!NAME_RE.test(g.name)) e.name = 'Enter a group name.';
  else if (g.name !== original && allAddressNames(cfg).some((n) => n.toLowerCase() === g.name.toLowerCase())) e.name = `“${g.name}” already exists.`;
  if (!g.members.length) e.members = 'Add at least one member.';
  if (g.members.includes(g.name)) e.members = 'A group cannot contain itself.';
  return e;
}

export function saveAddrGroup(cfg: FirewallConfig, input: AddressGroup, original: string | null): Result {
  const g = { ...input, id: input.id || uid() };
  if (original === null) return { next: { ...cfg, addressGroups: [...cfg.addressGroups, g] }, audit: [{ category: 'Object', action: `Address group ${g.name} added`, detail: `Members: ${g.members.join(', ')}` }] };
  const next = renameEverywhere({ ...cfg, addressGroups: cfg.addressGroups.map((x) => (x.name === original ? g : x)) }, original, g.name);
  return { next, audit: [{ category: 'Object', action: `Address group ${g.name} modified`, detail: `Members: ${g.members.join(', ')}` }] };
}

export const addressCatalog = (cfg: FirewallConfig) => [
  ...builtInGroups(cfg).map((g) => ({ name: g.name, kind: 'group' as const, builtIn: true })),
  ...builtInAddresses(cfg).map((a) => ({ name: a.name, kind: 'object' as const, builtIn: true })),
  ...cfg.addresses.map((a) => ({ name: a.name, kind: 'object' as const, builtIn: false })),
  ...cfg.addressGroups.map((g) => ({ name: g.name, kind: 'group' as const, builtIn: false })),
];

/* ------------------------------ Services ------------------------------ */

export const blankService = (): ServiceObject => ({ id: '', name: '', protocol: 'TCP', portStart: 0, portEnd: 0, builtIn: false });

export function validateService(cfg: FirewallConfig, sv: ServiceObject, original: string | null): Errors {
  const e: Errors = {};
  if (!NAME_RE.test(sv.name)) e.name = 'Enter a service name.';
  else if (sv.name !== original && allServiceNames(cfg).some((n) => n.toLowerCase() === sv.name.toLowerCase())) e.name = `“${sv.name}” already exists.`;
  if (sv.protocol === 'TCP' || sv.protocol === 'UDP') {
    if (!(sv.portStart >= 1 && sv.portStart <= 65535)) e.portStart = 'Port must be 1–65535.';
    if (!(sv.portEnd >= 1 && sv.portEnd <= 65535)) e.portEnd = 'Port must be 1–65535.';
    else if (sv.portEnd < sv.portStart) e.portEnd = 'End port must not be lower than the start port.';
  }
  return e;
}

export function saveService(cfg: FirewallConfig, input: ServiceObject, original: string | null): Result {
  const sv = { ...input, id: input.id || uid(), ...(input.protocol === 'ICMP' || input.protocol === 'ESP' ? { portStart: 0, portEnd: 0 } : {}) };
  const detail = `${sv.protocol}${sv.portStart ? ` ${sv.portStart}${sv.portEnd !== sv.portStart ? `-${sv.portEnd}` : ''}` : ''}`;
  if (original === null) return { next: { ...cfg, services: [...cfg.services, sv] }, audit: [{ category: 'Object', action: `Service object ${sv.name} added`, detail }] };
  const next = renameEverywhere({ ...cfg, services: cfg.services.map((x) => (x.name === original ? sv : x)) }, original, sv.name);
  return { next, audit: [{ category: 'Object', action: `Service object ${sv.name} modified`, detail }] };
}

export function deleteServices(cfg: FirewallConfig, names: string[]): Result & { error?: string } {
  const bi = names.filter((n) => cfg.services.find((x) => x.name === n)?.builtIn || cfg.serviceGroups.find((x) => x.name === n)?.builtIn);
  if (bi.length) return { next: cfg, audit: [], error: `Built-in services cannot be deleted: ${bi.join(', ')}.` };
  const used = names.map((n) => [n, referencesOf(cfg, n)] as const).filter(([, r]) => r.length);
  if (used.length) return { next: cfg, audit: [], error: `Still in use: ${used.map(([n, r]) => `${n} (${r.join(', ')})`).join('; ')}.` };
  return {
    next: { ...cfg, services: cfg.services.filter((x) => !names.includes(x.name)), serviceGroups: cfg.serviceGroups.filter((x) => !names.includes(x.name)) },
    audit: names.map((n) => ({ category: 'Object' as const, action: `Service ${n} deleted`, detail: '' })),
  };
}

export function validateSvcGroup(cfg: FirewallConfig, g: ServiceGroup, original: string | null): Errors {
  const e: Errors = {};
  if (!NAME_RE.test(g.name)) e.name = 'Enter a group name.';
  else if (g.name !== original && allServiceNames(cfg).some((n) => n.toLowerCase() === g.name.toLowerCase())) e.name = `“${g.name}” already exists.`;
  if (!g.members.length) e.members = 'Add at least one member.';
  if (g.members.includes(g.name)) e.members = 'A group cannot contain itself.';
  return e;
}

export function saveSvcGroup(cfg: FirewallConfig, input: ServiceGroup, original: string | null): Result {
  const g = { ...input, id: input.id || uid(), builtIn: false };
  if (original === null) return { next: { ...cfg, serviceGroups: [...cfg.serviceGroups, g] }, audit: [{ category: 'Object', action: `Service group ${g.name} added`, detail: `Members: ${g.members.join(', ')}` }] };
  const next = renameEverywhere({ ...cfg, serviceGroups: cfg.serviceGroups.map((x) => (x.name === original ? g : x)) }, original, g.name);
  return { next, audit: [{ category: 'Object', action: `Service group ${g.name} modified`, detail: `Members: ${g.members.join(', ')}` }] };
}

/* ------------------------------ Schedules ------------------------------ */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
export const blankSchedule = (): Schedule => ({ id: '', name: '', days: [], start: '09:00', end: '17:00', builtIn: false });

export function validateSchedule(cfg: FirewallConfig, sc: Schedule, original: string | null): Errors {
  const e: Errors = {};
  if (!NAME_RE.test(sc.name)) e.name = 'Enter a schedule name.';
  else if (sc.name !== original && cfg.schedules.some((x) => x.name.toLowerCase() === sc.name.toLowerCase())) e.name = `“${sc.name}” already exists.`;
  if (!sc.days.length) e.days = 'Select at least one day.';
  if (!HHMM.test(sc.start)) e.start = 'Use HH:MM (24-hour).';
  if (!HHMM.test(sc.end)) e.end = 'Use HH:MM (24-hour).';
  else if (HHMM.test(sc.start) && sc.end <= sc.start) e.end = 'End time must be after the start time (this lab does not support overnight ranges).';
  return e;
}

export function saveSchedule(cfg: FirewallConfig, input: Schedule, original: string | null): Result {
  const sc = { ...input, id: input.id || uid(), days: [...input.days].sort() };
  const detail = `${sc.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(',')} ${sc.start}–${sc.end}`;
  if (original === null) return { next: { ...cfg, schedules: [...cfg.schedules, sc] }, audit: [{ category: 'Object', action: `Schedule ${sc.name} added`, detail }] };
  const next = renameEverywhere({ ...cfg, schedules: cfg.schedules.map((x) => (x.name === original ? sc : x)) }, original, sc.name);
  return { next, audit: [{ category: 'Object', action: `Schedule ${sc.name} modified`, detail }] };
}

export function deleteSchedules(cfg: FirewallConfig, names: string[]): Result & { error?: string } {
  if (names.some((n) => cfg.schedules.find((x) => x.name === n)?.builtIn)) return { next: cfg, audit: [], error: 'Built-in schedules cannot be deleted.' };
  const used = names.map((n) => [n, referencesOf(cfg, n)] as const).filter(([, r]) => r.length);
  if (used.length) return { next: cfg, audit: [], error: `Still in use: ${used.map(([n, r]) => `${n} (${r.join(', ')})`).join('; ')}.` };
  return { next: { ...cfg, schedules: cfg.schedules.filter((x) => !names.includes(x.name)) }, audit: names.map((n) => ({ category: 'Object' as const, action: `Schedule ${n} deleted`, detail: '' })) };
}
