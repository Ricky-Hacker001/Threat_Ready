/** IPsec (HQ + lab Branch peer), SSL VPN, SD-WAN, certificates and DPI-SSL helpers. */
import type { AddressObject, FirewallConfig, IpsecPolicy, PathProfile, SdwanGroup, SlaProbe, SslVpnConfig } from '../state/types';
import type { AuditInput } from '../state/store';
import { allAddressNames, findAddress } from '../engine/objects';
import { branchBuiltIns } from '../engine/vpn';
import { isIPv4, isMask, networkOf } from '../lib/ip';
import { uid } from '../lib/hash';

type Errors = Record<string, string>;
type Result = { next: FirewallConfig; audit: AuditInput[] };

export const DH_GROUPS = ['Group 2', 'Group 5', 'Group 14', 'Group 19', 'Group 20'];
export const ENCS = ['3DES', 'AES-128', 'AES-256'];
export const AUTHS = ['SHA1', 'SHA256', 'SHA384', 'SHA512'];

export const blankPolicy = (): IpsecPolicy => ({
  id: '', name: '', kind: 'site', gateway: '', secret: '', localNet: '', remoteNet: '', exchange: 'ikev2',
  p1: { dh: 'Group 2', enc: '3DES', auth: 'SHA1', life: 28800 }, p2: { proto: 'ESP', enc: '3DES', auth: 'SHA1', pfs: false, pfsGroup: 'Group 2', life: 28800 },
  keepAlive: false, suppressAutoRules: false, boundTo: 'Zone WAN', enabled: true,
});

/** Validate a site-to-site policy against the address names available on that side (HQ or Branch). */
export function validatePolicy(p: IpsecPolicy, names: string[], others: IpsecPolicy[]): Errors {
  const e: Errors = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(p.name)) e.name = 'Enter a policy name, e.g. HQ-to-Branch.';
  else if (others.some((x) => x.name.toLowerCase() === p.name.toLowerCase() && x.id !== p.id)) e.name = `“${p.name}” already exists.`;
  if (p.kind === 'site') {
    if (!isIPv4(p.gateway)) e.gateway = 'Enter the peer’s public IP address.';
    if (p.secret.length < 8) e.secret = 'Use a training-only pre-shared key of at least 8 characters.';
    if (!names.includes(p.localNet)) e.localNet = 'Choose the local network object.';
    if (!names.includes(p.remoteNet)) e.remoteNet = 'Choose the remote network object (create it under Addresses first).';
    else if (p.remoteNet === p.localNet) e.remoteNet = 'Local and remote networks must differ.';
  }
  if (!(p.p1.life >= 120 && p.p1.life <= 86400)) e.p1life = 'Life time 120–86400 seconds.';
  if (!(p.p2.life >= 120 && p.p2.life <= 86400)) e.p2life = 'Life time 120–86400 seconds.';
  return e;
}

const pdesc = (p: IpsecPolicy) => `peer ${p.gateway}, ${p.localNet} ↔ ${p.remoteNet}, ${p.exchange.toUpperCase()}, P1 ${p.p1.dh}/${p.p1.enc}/${p.p1.auth}, P2 ${p.p2.proto} ${p.p2.enc}/${p.p2.auth} PFS ${p.p2.pfs ? p.p2.pfsGroup : 'off'}${p.enabled ? '' : ' (disabled)'}`;

export function saveHqPolicy(cfg: FirewallConfig, input: IpsecPolicy): Result {
  const p = { ...input, id: input.id || uid() };
  const exists = cfg.ipsec.some((x) => x.id === p.id);
  return { next: { ...cfg, ipsec: exists ? cfg.ipsec.map((x) => (x.id === p.id ? p : x)) : [...cfg.ipsec, p] }, audit: [{ category: 'VPN', action: `VPN policy ${p.name} ${exists ? 'modified' : 'added'}`, detail: pdesc(p) }] };
}
export function deleteHqPolicy(cfg: FirewallConfig, id: string): Result {
  const p = cfg.ipsec.find((x) => x.id === id)!;
  return { next: { ...cfg, ipsec: cfg.ipsec.filter((x) => x.id !== id) }, audit: [{ category: 'VPN', action: `VPN policy ${p.name} deleted`, detail: '' }] };
}
export function saveBranchPolicy(cfg: FirewallConfig, input: IpsecPolicy): Result {
  const p = { ...input, id: input.id || uid() };
  const list = cfg.branch.ipsec;
  const exists = list.some((x) => x.id === p.id);
  return { next: { ...cfg, branch: { ...cfg.branch, ipsec: exists ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p] } }, audit: [{ category: 'Lab', action: `Branch (${cfg.branch.hostname}) VPN policy ${p.name} ${exists ? 'modified' : 'added'}`, detail: pdesc(p) }] };
}
export function branchNames(cfg: FirewallConfig): string[] {
  return [...branchBuiltIns(cfg.branch).map((a) => a.name), ...cfg.branch.addresses.map((a) => a.name)];
}
export const hqNames = (cfg: FirewallConfig) => allAddressNames(cfg);

export function validateBranchAddress(cfg: FirewallConfig, a: AddressObject): Errors {
  const e: Errors = {};
  if (!a.name.trim()) e.name = 'Enter a name, e.g. N_HQ-LAN.';
  else if (branchNames(cfg).some((n) => n.toLowerCase() === a.name.toLowerCase() && n !== a.id)) e.name = 'Already exists on the Branch.';
  if (!isIPv4(a.ip)) e.ip = 'Enter the network address.';
  if (!isMask(a.ip2)) e.ip2 = 'Enter the mask.';
  else if (isIPv4(a.ip) && networkOf(a.ip, a.ip2) !== a.ip) e.ip = `Network address should be ${networkOf(a.ip, a.ip2)}.`;
  return e;
}
export function saveBranchAddress(cfg: FirewallConfig, a: AddressObject): Result {
  const x = { ...a, id: a.id || uid(), type: 'network' as const };
  return { next: { ...cfg, branch: { ...cfg.branch, addresses: [...cfg.branch.addresses.filter((y) => y.name !== x.name), x] } }, audit: [{ category: 'Lab', action: `Branch address object ${x.name} saved`, detail: `${x.ip}/${x.ip2}` }] };
}

/* ------------------------------ SSL VPN ------------------------------ */

export function validateSslVpn(cfg: FirewallConfig, v: SslVpnConfig): Errors {
  const e: Errors = {};
  if (!(v.port >= 1 && v.port <= 65535)) e.port = 'Port 1–65535.';
  else if (v.port === cfg.system.httpsPort) e.port = `Port ${v.port} is used by HTTPS management.`;
  if (v.pool) {
    const a = findAddress(cfg, v.pool);
    if (!a) e.pool = 'Unknown address object.';
    else if (a.type !== 'range' && a.type !== 'network') e.pool = 'The client pool must be a range or network object.';
    else if (a.zone !== 'SSLVPN') e.pool = `The pool object must be in the SSLVPN zone (it is in ${a.zone}).`;
  }
  v.clientRoutes.forEach((r) => { if (r !== 'Any' && !allAddressNames(cfg).includes(r)) e.clientRoutes = `Unknown route object ${r}.`; });
  v.dns.forEach((d, n) => { if (d && d !== '0.0.0.0' && !isIPv4(d)) e[`dns${n}`] = 'Invalid IP.'; });
  return e;
}
export function saveSslVpn(cfg: FirewallConfig, v: SslVpnConfig): Result {
  const sslvpn = { ...v, dns: v.dns.map((d) => d || '0.0.0.0') as [string, string] };
  return { next: { ...cfg, sslvpn }, audit: [{ category: 'VPN', action: 'SSL VPN settings modified', detail: `zones ${Object.entries(sslvpn.zones).filter(([, x]) => x).map(([k]) => k).join(', ') || 'none'}; port ${sslvpn.port}; pool ${sslvpn.pool || 'none'}; routes ${sslvpn.tunnelAll ? 'tunnel all' : sslvpn.clientRoutes.join(', ') || 'none'}` }] };
}

/* ------------------------------ SD-WAN ------------------------------ */

export function saveSdGroup(cfg: FirewallConfig, g: SdwanGroup): Result {
  const x = { ...g, id: g.id || uid() };
  const groups = cfg.sdwan.groups.some((y) => y.id === x.id) ? cfg.sdwan.groups.map((y) => (y.id === x.id ? x : y)) : [...cfg.sdwan.groups, x];
  return { next: { ...cfg, sdwan: { ...cfg.sdwan, groups } }, audit: [{ category: 'Network', action: `SD-WAN group ${x.name} saved`, detail: `Members (priority order): ${x.members.join(', ')}` }] };
}
export function validateSdGroup(cfg: FirewallConfig, g: SdwanGroup): Errors {
  const e: Errors = {};
  if (!g.name.trim()) e.name = 'Enter a group name.';
  else if (cfg.sdwan.groups.some((y) => y.name === g.name && y.id !== g.id)) e.name = 'Already exists.';
  if (g.members.length < 2) e.members = 'Add at least two WAN interfaces.';
  if (g.members.some((m) => cfg.interfaces.find((i) => i.name === m)?.zone !== 'WAN')) e.members = 'Members must be WAN-zone interfaces.';
  return e;
}
export function saveProbe(cfg: FirewallConfig, p: SlaProbe): Result {
  const x = { ...p, id: p.id || uid() };
  const probes = cfg.sdwan.probes.some((y) => y.id === x.id) ? cfg.sdwan.probes.map((y) => (y.id === x.id ? x : y)) : [...cfg.sdwan.probes, x];
  return { next: { ...cfg, sdwan: { ...cfg.sdwan, probes } }, audit: [{ category: 'Network', action: `SLA probe ${x.name} saved`, detail: `Ping ${x.target} every ${x.intervalSec}s on ${x.ifaces.join(', ')}` }] };
}
export function validateProbe(cfg: FirewallConfig, p: SlaProbe): Errors {
  const e: Errors = {};
  if (!p.name.trim()) e.name = 'Enter a probe name.';
  else if (cfg.sdwan.probes.some((y) => y.name === p.name && y.id !== p.id)) e.name = 'Already exists.';
  if (!isIPv4(p.target)) e.target = 'Enter an IP address to probe, e.g. 1.1.1.1.';
  if (!p.ifaces.length) e.ifaces = 'Select the interfaces to probe from.';
  if (!(p.intervalSec >= 1 && p.intervalSec <= 60)) e.intervalSec = 'Interval 1–60 seconds.';
  return e;
}
export function saveProfile(cfg: FirewallConfig, p: PathProfile): Result {
  const x = { ...p, id: p.id || uid() };
  const profiles = cfg.sdwan.profiles.some((y) => y.id === x.id) ? cfg.sdwan.profiles.map((y) => (y.id === x.id ? x : y)) : [...cfg.sdwan.profiles, x];
  return { next: { ...cfg, sdwan: { ...cfg.sdwan, profiles } }, audit: [{ category: 'Network', action: `Path selection profile ${x.name} saved`, detail: `Group ${x.group}, probe ${x.probe}, SLA ≤${x.maxLatencyMs} ms / ≤${x.maxLossPct}% loss, backup ${x.backup || 'none'}` }] };
}
export function validateProfile(cfg: FirewallConfig, p: PathProfile): Errors {
  const e: Errors = {};
  if (!p.name.trim()) e.name = 'Enter a profile name.';
  else if (cfg.sdwan.profiles.some((y) => y.name === p.name && y.id !== p.id)) e.name = 'Already exists.';
  if (!cfg.sdwan.groups.some((g) => g.name === p.group)) e.group = 'Choose an SD-WAN group.';
  if (!cfg.sdwan.probes.some((g) => g.name === p.probe)) e.probe = 'Choose an SLA probe.';
  if (!(p.maxLatencyMs >= 1)) e.maxLatencyMs = 'Enter the latency threshold.';
  return e;
}

/* ------------------------------ Certificates ------------------------------ */

export function importCertificate(cfg: FirewallConfig, name: string, subject: string): Result {
  const c = { name, type: 'Local' as const, subject, issuer: 'AERO Internal Root CA (lab)', expires: '2028-12-31', builtIn: false };
  return { next: { ...cfg, certificates: [...cfg.certificates.filter((x) => x.name !== name), c] }, audit: [{ category: 'System', action: `Certificate ${name} imported`, detail: `${subject}, issued by ${c.issuer}` }] };
}
