/** Access-rule evaluation (first match per zone pair) + rules auto-created by VPN features. */
import type { AccessRule, FirewallConfig, Proto, RootState } from '../state/types';
import { addrMatches, scheduleActive, serviceMatches } from './objects';

/** Rules SonicOS-style features add on their own. Computed, never stored, so they can't drift from the feature config. */
export function autoRules(cfg: FirewallConfig): AccessRule[] {
  const out: AccessRule[] = [];
  const base = { action: 'allow' as const, service: 'Any', schedule: 'Always', usersIncl: 'All', usersExcl: 'None', logging: false, enabled: true, builtIn: true, hits: 0, lastHit: null };
  for (const p of cfg.ipsec) {
    if (p.kind !== 'site' || !p.enabled || p.suppressAutoRules) continue;
    out.push({ ...base, id: `auto-ipsec-out-${p.id}`, name: `VPN ${p.name} (outbound)`, fromZone: 'LAN', toZone: 'VPN', src: p.localNet, dst: p.remoteNet, auto: `ipsec:${p.id}`, comment: 'Auto-added for VPN policy' });
    out.push({ ...base, id: `auto-ipsec-in-${p.id}`, name: `VPN ${p.name} (inbound)`, fromZone: 'VPN', toZone: 'LAN', src: p.remoteNet, dst: p.localNet, auto: `ipsec:${p.id}`, comment: 'Auto-added for VPN policy' });
  }
  if (cfg.sslvpn.zones.WAN && cfg.sslvpn.pool) {
    const routes = cfg.sslvpn.tunnelAll ? ['Any'] : cfg.sslvpn.clientRoutes;
    routes.forEach((r, n) => {
      const zone = r === 'Any' ? 'LAN' : (cfg.addresses.find((a) => a.name === r)?.zone ?? 'LAN');
      out.push({ ...base, id: `auto-sslvpn-${n}`, name: `SSL VPN → ${r}`, fromZone: 'SSLVPN', toZone: zone, src: cfg.sslvpn.pool, dst: r, auto: 'sslvpn', comment: 'Auto-added for SSL VPN client routes' });
    });
  }
  return out;
}

export function rulesForPair(cfg: FirewallConfig, from: string, to: string): AccessRule[] {
  return [...cfg.accessRules, ...autoRules(cfg)].filter((r) => r.fromZone === from && r.toZone === to);
}

export function userInGroup(cfg: FirewallConfig, user: string, group: string): boolean {
  if (group === 'All' || group === 'Everyone') return true;
  return !!cfg.users.local.find((u) => u.name === user)?.groups.includes(group);
}

export interface RuleDecision {
  rule: AccessRule | null;
  skippedBySchedule: AccessRule | null;
  needsAuth: AccessRule | null;
  implicit: 'trust' | 'deny' | null;
}

export function decide(s: RootState, p: {
  fromZone: string; toZone: string; src: string; dst: string; dstAlt?: string; proto: Proto; port: number; user: string | null; ts: number;
}): RuleDecision {
  const cfg = s.config;
  let skippedBySchedule: AccessRule | null = null;
  let needsAuth: AccessRule | null = null;
  for (const r of rulesForPair(cfg, p.fromZone, p.toZone)) {
    if (!r.enabled) continue;
    if (!addrMatches(cfg, r.src, p.src)) continue;
    if (!addrMatches(cfg, r.dst, p.dst) && !(p.dstAlt && addrMatches(cfg, r.dst, p.dstAlt))) continue;
    if (!serviceMatches(cfg, r.service, p.proto, p.port)) continue;
    if (!scheduleActive(cfg, r.schedule, p.ts)) { skippedBySchedule ??= r; continue; }
    if (r.usersIncl !== 'All') {
      if (!p.user) { if (r.action === 'allow') { needsAuth ??= r; } continue; }
      if (!userInGroup(cfg, p.user, r.usersIncl)) continue;
    }
    if (r.usersExcl !== 'None' && p.user && userInGroup(cfg, p.user, r.usersExcl)) continue;
    return { rule: r, skippedBySchedule, needsAuth, implicit: null };
  }
  const zone = cfg.zones.find((z) => z.name === p.fromZone);
  if (p.fromZone === p.toZone && zone?.interfaceTrust && !rulesForPair(cfg, p.fromZone, p.toZone).length) {
    return { rule: null, skippedBySchedule, needsAuth, implicit: 'trust' };
  }
  return { rule: null, skippedBySchedule, needsAuth, implicit: 'deny' };
}

/** Shadow analysis for task 2.3: a rule is shadowed when an earlier enabled rule of the same pair covers it completely. */
export function shadowedBy(cfg: FirewallConfig, rule: AccessRule): AccessRule | null {
  const list = cfg.accessRules.filter((r) => r.fromZone === rule.fromZone && r.toZone === rule.toZone);
  const idx = list.findIndex((r) => r.id === rule.id);
  for (const r of list.slice(0, idx)) {
    if (!r.enabled) continue;
    const covers = (a: string, b: string) => a === 'Any' || a === b;
    if (covers(r.src, rule.src) && covers(r.dst, rule.dst) && covers(r.service, rule.service) && (r.schedule === 'Always' || r.schedule === rule.schedule)
      && r.usersIncl === 'All') return r;
  }
  return null;
}
