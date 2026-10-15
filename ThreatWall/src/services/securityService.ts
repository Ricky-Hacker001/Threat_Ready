/** Security services: content filter, application control, IPS, gateway AV, DPI-SSL, botnet. */
import type { AppAction, AppCategory, CfsProfile, CfsRule, FirewallConfig, SecurityConfig } from '../state/types';
import type { AuditInput } from '../state/store';
import { uid } from '../lib/hash';
import { CFS_CATEGORIES, SIGNATURES } from '../engine/world';

type Errors = Record<string, string>;
type Result = { next: FirewallConfig; audit: AuditInput[] };
const sec = (cfg: FirewallConfig, patch: Partial<SecurityConfig>): FirewallConfig => ({ ...cfg, security: { ...cfg.security, ...patch } });
export const licensed = (cfg: FirewallConfig, id: string) => cfg.licensing.services.some((x) => x.id === id && x.status === 'licensed');

/* ------------------------------ Content filter ------------------------------ */

export function saveCfsSettings(cfg: FirewallConfig, p: Partial<Pick<SecurityConfig['cfs'], 'enabled' | 'blockIfUnavailable' | 'excludeAdmin'>>): Result {
  const cfs = { ...cfg.security.cfs, ...p };
  return { next: sec(cfg, { cfs }), audit: [{ category: 'Security', action: 'Content filter settings modified', detail: `CFS ${cfs.enabled ? 'enabled' : 'disabled'}${cfs.blockIfUnavailable ? ', block if server unavailable' : ''}` }] };
}

export const blankProfile = (): CfsProfile => ({ id: '', name: '', blocked: [], allowList: [] });

export function validateProfile(cfg: FirewallConfig, p: CfsProfile, originalId: string | null): Errors {
  const e: Errors = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(p.name)) e.name = 'Enter a profile name, e.g. CFS_Staff.';
  else if (cfg.security.cfs.profiles.some((x) => x.name.toLowerCase() === p.name.toLowerCase() && x.id !== originalId)) e.name = `“${p.name}” already exists.`;
  if (p.blocked.some((c) => !CFS_CATEGORIES.includes(c))) e.blocked = 'Unknown category.';
  if (p.allowList.some((a) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(a.trim()))) e.allowList = 'Allow list entries must be domain names, one per line.';
  return e;
}

export function saveProfile(cfg: FirewallConfig, input: CfsProfile, originalId: string | null): Result {
  const p = { ...input, id: input.id || uid(), allowList: input.allowList.map((a) => a.trim().toLowerCase()).filter(Boolean) };
  const profiles = originalId ? cfg.security.cfs.profiles.map((x) => (x.id === originalId ? p : x)) : [...cfg.security.cfs.profiles, p];
  let rules = cfg.security.cfs.rules;
  const before = cfg.security.cfs.profiles.find((x) => x.id === originalId);
  if (before && before.name !== p.name) rules = rules.map((r) => (r.profile === before.name ? { ...r, profile: p.name } : r));
  return { next: sec(cfg, { cfs: { ...cfg.security.cfs, profiles, rules } }), audit: [{ category: 'Security', action: `CFS profile ${p.name} ${originalId ? 'modified' : 'added'}`, detail: `Blocked: ${p.blocked.join(', ') || 'none'}; allow list: ${p.allowList.join(', ') || 'none'}` }] };
}

export function deleteProfile(cfg: FirewallConfig, id: string): Result & { error?: string } {
  const p = cfg.security.cfs.profiles.find((x) => x.id === id)!;
  if (cfg.security.cfs.rules.some((r) => r.profile === p.name)) return { next: cfg, audit: [], error: `${p.name} is used by a content filter rule.` };
  return { next: sec(cfg, { cfs: { ...cfg.security.cfs, profiles: cfg.security.cfs.profiles.filter((x) => x.id !== id) } }), audit: [{ category: 'Security', action: `CFS profile ${p.name} deleted`, detail: '' }] };
}

export const blankCfsRule = (): CfsRule => ({ id: '', name: '', srcZone: 'LAN', dstZone: 'WAN', users: 'All', profile: '', enabled: true, hits: 0 });

export function validateCfsRule(cfg: FirewallConfig, r: CfsRule, originalId: string | null): Errors {
  const e: Errors = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(r.name)) e.name = 'Enter a rule name.';
  else if (cfg.security.cfs.rules.some((x) => x.name.toLowerCase() === r.name.toLowerCase() && x.id !== originalId)) e.name = `“${r.name}” already exists.`;
  if (!cfg.security.cfs.profiles.some((p) => p.name === r.profile)) e.profile = 'Choose a profile.';
  if (r.srcZone !== 'Any' && !cfg.zones.some((z) => z.name === r.srcZone)) e.srcZone = 'Unknown zone.';
  return e;
}

export function saveCfsRule(cfg: FirewallConfig, input: CfsRule, originalId: string | null): Result {
  const r = { ...input, id: input.id || uid() };
  const rules = originalId ? cfg.security.cfs.rules.map((x) => (x.id === originalId ? { ...r, hits: x.hits } : x)) : [...cfg.security.cfs.rules, r];
  return { next: sec(cfg, { cfs: { ...cfg.security.cfs, rules } }), audit: [{ category: 'Security', action: `Content filter rule ${r.name} ${originalId ? 'modified' : 'added'}`, detail: `${r.srcZone}→${r.dstZone}, users ${r.users}, profile ${r.profile}${r.enabled ? '' : ' (disabled)'}` }] };
}

export function deleteCfsRule(cfg: FirewallConfig, id: string): Result {
  const r = cfg.security.cfs.rules.find((x) => x.id === id)!;
  return { next: sec(cfg, { cfs: { ...cfg.security.cfs, rules: cfg.security.cfs.rules.filter((x) => x.id !== id) } }), audit: [{ category: 'Security', action: `Content filter rule ${r.name} deleted`, detail: '' }] };
}

/* ------------------------------ App control ------------------------------ */

export function saveAppControl(cfg: FirewallConfig, ac: SecurityConfig['appControl']): Result {
  const cats = (Object.entries(ac.categories) as [AppCategory, AppAction][]).filter(([, v]) => v !== 'none').map(([k, v]) => `${k}: ${v}`).join(', ') || 'no category actions';
  return { next: sec(cfg, { appControl: ac }), audit: [{ category: 'Security', action: 'App Control settings modified', detail: `${ac.enabled ? 'Enabled' : 'Disabled'}; ${cats}` }] };
}

/* ------------------------------ IPS / GAV / botnet ------------------------------ */

export function saveIps(cfg: FirewallConfig, ips: SecurityConfig['ips']): Result {
  const lv = (k: 'high' | 'medium' | 'low') => `${k} ${ips[k].prevent ? 'prevent' : ''}${ips[k].prevent && ips[k].detect ? '+' : ''}${ips[k].detect ? 'detect' : ''}${!ips[k].prevent && !ips[k].detect ? 'off' : ''}`;
  return { next: sec(cfg, { ips }), audit: [{ category: 'Security', action: 'Intrusion Prevention settings modified', detail: `${ips.enabled ? 'Enabled' : 'Disabled'}; ${lv('high')}, ${lv('medium')}, ${lv('low')}; exclusions ${ips.exclusions.join(', ') || 'none'}` }] };
}

export function validateExclusion(cfg: FirewallConfig, id: string): string {
  const n = Number(id);
  if (!/^\d+$/.test(id) || !SIGNATURES[n]) return 'Enter a signature ID from the IPS log (e.g. the one that fired on the business app).';
  if (cfg.security.ips.exclusions.includes(n)) return 'Already excluded.';
  return '';
}

export function saveGav(cfg: FirewallConfig, gav: SecurityConfig['gav']): Result {
  return { next: sec(cfg, { gav }), audit: [{ category: 'Security', action: 'Gateway Anti-Virus settings modified', detail: `${gav.enabled ? 'Enabled' : 'Disabled'}; inbound ${Object.entries(gav.protocols).filter(([, v]) => v.inbound).map(([k]) => k).join(', ')}` }] };
}

export function saveBotnet(cfg: FirewallConfig, enabled: boolean): Result {
  return { next: sec(cfg, { botnet: { enabled } }), audit: [{ category: 'Security', action: `Botnet filter ${enabled ? 'enabled' : 'disabled'}`, detail: '' }] };
}

export function saveDpi(cfg: FirewallConfig, dpiSsl: SecurityConfig['dpiSsl']): Result {
  return { next: sec(cfg, { dpiSsl }), audit: [{ category: 'Security', action: 'DPI-SSL client settings modified', detail: `${dpiSsl.clientEnabled ? 'Enabled' : 'Disabled'}; inspect ${Object.entries(dpiSsl.inspect).filter(([, v]) => v).map(([k]) => k).join(', ')}; excluded categories ${dpiSsl.excludedCategories.join(', ') || 'none'}; excluded names ${dpiSsl.excludedNames.join(', ') || 'none'}` }] };
}
