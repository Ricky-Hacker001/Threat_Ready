/** Access rules, NAT policies and route policies: validation, ordering, save, delete. */
import type { AccessRule, FirewallConfig, NatRule, RoutePolicy } from '../state/types';
import type { AuditInput } from '../state/store';
import { allAddressNames, allServiceNames, findAddress } from '../engine/objects';
import { hasAddress } from '../engine/network';
import { inSubnet, isIPv4 } from '../lib/ip';
import { uid } from '../lib/hash';

type Errors = Record<string, string>;
type Result = { next: FirewallConfig; audit: AuditInput[] };
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()>→-]{0,63}$/;

const addrOk = (cfg: FirewallConfig, n: string) => n === 'Any' || allAddressNames(cfg).includes(n);
const svcOk = (cfg: FirewallConfig, n: string) => n === 'Any' || allServiceNames(cfg).includes(n);
const groupOk = (cfg: FirewallConfig, n: string, any: string) => n === any || cfg.users.groups.some((g) => g.name === n);

/* ------------------------------ Access rules ------------------------------ */

export const blankRule = (from: string, to: string): AccessRule => ({
  id: '', name: '', fromZone: from, toZone: to, action: 'allow', src: 'Any', dst: 'Any', service: 'Any', schedule: 'Always', usersIncl: 'All', usersExcl: 'None',
  logging: true, enabled: true, builtIn: false, auto: null, hits: 0, lastHit: null, comment: '',
});

export function validateRule(cfg: FirewallConfig, r: AccessRule, originalId: string | null): Errors {
  const e: Errors = {};
  if (!r.name.trim() || !NAME_RE.test(r.name.trim())) e.name = 'Enter a rule name, e.g. LAN-Web-Out.';
  else if (cfg.accessRules.some((x) => x.name.toLowerCase() === r.name.trim().toLowerCase() && x.id !== originalId)) e.name = `A rule named “${r.name}” already exists.`;
  if (!cfg.zones.some((z) => z.name === r.fromZone)) e.fromZone = 'Choose the source zone.';
  if (!cfg.zones.some((z) => z.name === r.toZone)) e.toZone = 'Choose the destination zone.';
  if (!addrOk(cfg, r.src)) e.src = `Address “${r.src}” does not exist.`;
  if (!addrOk(cfg, r.dst)) e.dst = `Address “${r.dst}” does not exist.`;
  if (!svcOk(cfg, r.service)) e.service = `Service “${r.service}” does not exist.`;
  if (r.schedule !== 'Always' && !cfg.schedules.some((s) => s.name === r.schedule)) e.schedule = `Schedule “${r.schedule}” does not exist.`;
  if (!groupOk(cfg, r.usersIncl, 'All')) e.usersIncl = 'Unknown user group.';
  if (!groupOk(cfg, r.usersExcl, 'None')) e.usersExcl = 'Unknown user group.';
  return e;
}

/** Warnings that do not block saving but deserve a second look. */
export function ruleWarnings(cfg: FirewallConfig, r: AccessRule): string[] {
  const w: string[] = [];
  if (r.action === 'allow' && r.fromZone === 'WAN' && r.src === 'Any' && r.dst === 'Any' && r.service === 'Any') w.push('This allows ANY traffic from the internet. Restrict destination and service.');
  if (r.action === 'allow' && r.service === 'Any' && r.fromZone !== r.toZone) w.push('Service “Any” allows every port. Least privilege means listing only what is needed.');
  const sa = findAddress(cfg, r.src);
  if (sa && sa.type !== 'fqdn' && sa.zone && sa.zone !== r.fromZone) w.push(`Source ${r.src} is in zone ${sa.zone}, but the rule is from ${r.fromZone}. It will probably never match.`);
  const da = findAddress(cfg, r.dst);
  if (da && da.type !== 'fqdn' && da.zone && da.zone !== r.toZone && !(r.fromZone === 'WAN' && da.zone === 'WAN')) w.push(`Destination ${r.dst} is in zone ${da.zone}, but the rule is to ${r.toZone}.`);
  return w;
}

const pairIdx = (list: AccessRule[], r: AccessRule) => list.map((x, i) => [x, i] as const).filter(([x]) => x.fromZone === r.fromZone && x.toZone === r.toZone);

export function saveRule(cfg: FirewallConfig, input: AccessRule, originalId: string | null, position: 'top' | 'bottom' = 'top'): Result {
  const r: AccessRule = { ...input, name: input.name.trim(), id: input.id || uid() };
  const detail = `${r.fromZone}→${r.toZone} ${r.action.toUpperCase()} src ${r.src} dst ${r.dst} svc ${r.service}${r.schedule !== 'Always' ? ` sched ${r.schedule}` : ''}${r.usersIncl !== 'All' ? ` users ${r.usersIncl}` : ''}${r.enabled ? '' : ' (disabled)'}`;
  if (originalId) {
    const before = cfg.accessRules.find((x) => x.id === originalId);
    let list = cfg.accessRules.map((x) => (x.id === originalId ? { ...r, hits: x.hits, lastHit: x.lastHit } : x));
    // zone pair changed: move into the new pair, above its defaults
    if (before && (before.fromZone !== r.fromZone || before.toZone !== r.toZone)) {
      list = list.filter((x) => x.id !== originalId);
      list = insertInPair(list, { ...r, hits: 0, lastHit: null }, 'top');
    }
    return { next: { ...cfg, accessRules: list }, audit: [{ category: 'Policy', action: `Access rule ${r.name} modified`, detail }] };
  }
  return { next: { ...cfg, accessRules: insertInPair(cfg.accessRules, r, position) }, audit: [{ category: 'Policy', action: `Access rule ${r.name} added`, detail }] };
}

/** New custom rules go above the pair's built-in default (or at the bottom of the custom rules). */
function insertInPair(list: AccessRule[], r: AccessRule, position: 'top' | 'bottom'): AccessRule[] {
  const pair = pairIdx(list, r);
  let at: number;
  if (!pair.length) at = list.length;
  else if (position === 'top') at = pair[0][1];
  else { const firstDefault = pair.find(([x]) => x.builtIn); at = firstDefault ? firstDefault[1] : pair[pair.length - 1][1] + 1; }
  return [...list.slice(0, at), r, ...list.slice(at)];
}

/** Move a rule one place up/down within its zone pair (priority). */
export function moveRule(cfg: FirewallConfig, id: string, dir: -1 | 1): Result | null {
  const r = cfg.accessRules.find((x) => x.id === id);
  if (!r) return null;
  const pair = pairIdx(cfg.accessRules, r);
  const k = pair.findIndex(([x]) => x.id === id);
  const other = pair[k + dir];
  if (!other) return null;
  const list = [...cfg.accessRules];
  const i = pair[k][1];
  const j = other[1];
  [list[i], list[j]] = [list[j], list[i]];
  const prio = pair.findIndex(([x]) => x.id === other[0].id) + 1;
  return { next: { ...cfg, accessRules: list }, audit: [{ category: 'Policy', action: `Access rule ${r.name} moved ${dir < 0 ? 'up' : 'down'}`, detail: `${r.fromZone}→${r.toZone}: now priority ${prio}` }] };
}

/** Move a rule to an exact priority (1-based) within its zone pair. */
export function setPriority(cfg: FirewallConfig, id: string, prio: number): Result | null {
  const r = cfg.accessRules.find((x) => x.id === id);
  if (!r) return null;
  const pair = pairIdx(cfg.accessRules, r).map(([x]) => x);
  const without = pair.filter((x) => x.id !== id);
  const p = Math.max(1, Math.min(prio, pair.length));
  without.splice(p - 1, 0, r);
  let n = 0;
  const list = cfg.accessRules.map((x) => (x.fromZone === r.fromZone && x.toZone === r.toZone ? without[n++] : x));
  return { next: { ...cfg, accessRules: list }, audit: [{ category: 'Policy', action: `Access rule ${r.name} priority changed`, detail: `${r.fromZone}→${r.toZone}: now priority ${p}` }] };
}

export function toggleRule(cfg: FirewallConfig, id: string, enabled: boolean): Result {
  const r = cfg.accessRules.find((x) => x.id === id)!;
  return { next: { ...cfg, accessRules: cfg.accessRules.map((x) => (x.id === id ? { ...x, enabled } : x)) }, audit: [{ category: 'Policy', action: `Access rule ${r.name} ${enabled ? 'enabled' : 'disabled'}`, detail: `${r.fromZone}→${r.toZone}` }] };
}

export function deleteRules(cfg: FirewallConfig, ids: string[]): Result & { error?: string } {
  const bi = cfg.accessRules.filter((r) => ids.includes(r.id) && r.builtIn);
  if (bi.length) return { next: cfg, audit: [], error: `Default rules cannot be deleted (disable them instead): ${bi.map((r) => r.name).join(', ')}.` };
  const gone = cfg.accessRules.filter((r) => ids.includes(r.id));
  return { next: { ...cfg, accessRules: cfg.accessRules.filter((r) => !ids.includes(r.id)) }, audit: gone.map((r) => ({ category: 'Policy' as const, action: `Access rule ${r.name} deleted`, detail: `${r.fromZone}→${r.toZone}` })) };
}

export function resetHits(cfg: FirewallConfig): Result {
  return { next: { ...cfg, accessRules: cfg.accessRules.map((r) => ({ ...r, hits: 0, lastHit: null })) }, audit: [{ category: 'Policy', action: 'Access rule statistics cleared', detail: '' }] };
}

/* ------------------------------ NAT ------------------------------ */

export const blankNat = (): NatRule => ({
  id: '', name: '', origSrc: 'Any', transSrc: 'Original', origDst: 'Any', transDst: 'Original', origSvc: 'Any', transSvc: 'Original', inIface: 'Any', outIface: 'Any',
  enabled: true, builtIn: false, hits: 0, comment: '',
});

export interface BuiltInNat { id: string; name: string; origSrc: string; transSrc: string; origDst: string; transDst: string; origSvc: string; transSvc: string; inIface: string; outIface: string; enabled: boolean; wan: string }

/** Default outbound NAT per WAN interface (private sources leave as the WAN address). */
export function builtInNat(cfg: FirewallConfig): BuiltInNat[] {
  return cfg.interfaces.filter((i) => i.zone === 'WAN' && hasAddress(i)).map((i) => ({
    id: `nat-default-${i.name}`, name: `Default NAT Policy (${i.name})`, origSrc: 'Any (private)', transSrc: `${i.name} IP`, origDst: 'Any', transDst: 'Original',
    origSvc: 'Any', transSvc: 'Original', inIface: 'Any', outIface: i.name, enabled: !cfg.natDefaultsDisabled.includes(i.name), wan: i.name,
  }));
}

export function validateNat(cfg: FirewallConfig, n: NatRule, originalId: string | null): Errors {
  const e: Errors = {};
  if (!n.name.trim() || !NAME_RE.test(n.name.trim())) e.name = 'Enter a NAT policy name.';
  else if (cfg.natRules.some((x) => x.name.toLowerCase() === n.name.trim().toLowerCase() && x.id !== originalId)) e.name = `“${n.name}” already exists.`;
  for (const k of ['origSrc', 'origDst'] as const) if (!addrOk(cfg, n[k])) e[k] = `Address “${n[k]}” does not exist.`;
  for (const k of ['transSrc', 'transDst'] as const) if (n[k] !== 'Original' && !addrOk(cfg, n[k])) e[k] = `Address “${n[k]}” does not exist.`;
  if (!svcOk(cfg, n.origSvc)) e.origSvc = `Service “${n.origSvc}” does not exist.`;
  if (n.transSvc !== 'Original' && !svcOk(cfg, n.transSvc)) e.transSvc = `Service “${n.transSvc}” does not exist.`;
  const ifaceOk = (x: string) => x === 'Any' || cfg.interfaces.some((i) => i.name === x);
  if (!ifaceOk(n.inIface)) e.inIface = 'Unknown interface.';
  if (!ifaceOk(n.outIface)) e.outIface = 'Unknown interface.';
  if (n.transDst !== 'Original') {
    const t = findAddress(cfg, n.transDst);
    if (t && t.type !== 'host') e.transDst = 'Translated destination must be a single host.';
  }
  if (n.origDst === 'Any' && n.transDst !== 'Original') e.origDst = 'An inbound (destination) translation needs a specific original destination, e.g. webserver_public_ip.';
  return e;
}

export function saveNat(cfg: FirewallConfig, input: NatRule, originalId: string | null): Result {
  const n = { ...input, name: input.name.trim(), id: input.id || uid() };
  const detail = `src ${n.origSrc}→${n.transSrc}, dst ${n.origDst}→${n.transDst}, svc ${n.origSvc}, in ${n.inIface}, out ${n.outIface}`;
  if (originalId) return { next: { ...cfg, natRules: cfg.natRules.map((x) => (x.id === originalId ? { ...n, hits: x.hits } : x)) }, audit: [{ category: 'Policy', action: `NAT policy ${n.name} modified`, detail }] };
  return { next: { ...cfg, natRules: [...cfg.natRules, n] }, audit: [{ category: 'Policy', action: `NAT policy ${n.name} added`, detail }] };
}

export function deleteNat(cfg: FirewallConfig, id: string): Result {
  const n = cfg.natRules.find((x) => x.id === id)!;
  return { next: { ...cfg, natRules: cfg.natRules.filter((x) => x.id !== id) }, audit: [{ category: 'Policy', action: `NAT policy ${n.name} deleted`, detail: '' }] };
}

export function toggleNat(cfg: FirewallConfig, id: string, enabled: boolean): Result {
  const bi = builtInNat(cfg).find((x) => x.id === id);
  if (bi) {
    const dis = enabled ? cfg.natDefaultsDisabled.filter((w) => w !== bi.wan) : [...new Set([...cfg.natDefaultsDisabled, bi.wan])];
    return { next: { ...cfg, natDefaultsDisabled: dis }, audit: [{ category: 'Policy', action: `${bi.name} ${enabled ? 'enabled' : 'disabled'}`, detail: '' }] };
  }
  const n = cfg.natRules.find((x) => x.id === id)!;
  return { next: { ...cfg, natRules: cfg.natRules.map((x) => (x.id === id ? { ...x, enabled } : x)) }, audit: [{ category: 'Policy', action: `NAT policy ${n.name} ${enabled ? 'enabled' : 'disabled'}`, detail: '' }] };
}

/* ------------------------------ Route policies ------------------------------ */

export const blankRoute = (): RoutePolicy => ({ id: '', name: '', src: 'Any', dst: 'Any', service: 'Any', type: 'standard', iface: 'X1', gateway: '', pathProfile: '', metric: 1, enabled: true, hits: 0, comment: '' });

export function validateRoute(cfg: FirewallConfig, r: RoutePolicy, originalId: string | null): Errors {
  const e: Errors = {};
  if (!r.name.trim() || !NAME_RE.test(r.name.trim())) e.name = 'Enter a route name.';
  else if (cfg.routes.some((x) => x.name.toLowerCase() === r.name.trim().toLowerCase() && x.id !== originalId)) e.name = `“${r.name}” already exists.`;
  if (!addrOk(cfg, r.src)) e.src = `Address “${r.src}” does not exist.`;
  if (!addrOk(cfg, r.dst)) e.dst = `Address “${r.dst}” does not exist.`;
  if (!svcOk(cfg, r.service)) e.service = `Service “${r.service}” does not exist.`;
  if (!(r.metric >= 1 && r.metric <= 255)) e.metric = 'Metric must be 1–255.';
  if (r.type === 'standard') {
    const i = cfg.interfaces.find((x) => x.name === r.iface);
    if (!i || !hasAddress(i)) e.iface = 'Choose an interface that has an IP address.';
    if (r.gateway && r.gateway !== '0.0.0.0') {
      if (!isIPv4(r.gateway)) e.gateway = 'Enter the next-hop IP address, or leave it empty for a connected network.';
      else if (i && hasAddress(i) && !inSubnet(r.gateway, i.ip, i.mask)) e.gateway = `Gateway ${r.gateway} is not in ${i.name}’s subnet (${i.ip}/${i.mask}), so it can never be reached.`;
    }
  } else if (!cfg.sdwan.profiles.some((p) => p.name === r.pathProfile)) e.pathProfile = 'Choose an SD-WAN path selection profile.';
  return e;
}

export function saveRoute(cfg: FirewallConfig, input: RoutePolicy, originalId: string | null): Result {
  const r = { ...input, name: input.name.trim(), id: input.id || uid(), gateway: input.gateway || '0.0.0.0' };
  const detail = r.type === 'sdwan' ? `${r.src}→${r.dst} via SD-WAN profile ${r.pathProfile}` : `${r.src}→${r.dst} via ${r.iface} gateway ${r.gateway} metric ${r.metric}`;
  if (originalId) return { next: { ...cfg, routes: cfg.routes.map((x) => (x.id === originalId ? { ...r, hits: x.hits } : x)) }, audit: [{ category: 'Network', action: `Route policy ${r.name} modified`, detail }] };
  return { next: { ...cfg, routes: [...cfg.routes, r] }, audit: [{ category: 'Network', action: `Route policy ${r.name} added`, detail }] };
}

export function deleteRoute(cfg: FirewallConfig, id: string): Result {
  const r = cfg.routes.find((x) => x.id === id)!;
  return { next: { ...cfg, routes: cfg.routes.filter((x) => x.id !== id) }, audit: [{ category: 'Network', action: `Route policy ${r.name} deleted`, detail: '' }] };
}
