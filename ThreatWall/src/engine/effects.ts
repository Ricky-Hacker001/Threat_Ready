import type { RootState, LogEntry, Packet } from '../state/types';
import type { Effects } from './traffic';
import { uid } from '../lib/hash';

const MAX_LOGS = 1500;
const MAX_PKTS = 400;

/** Apply side effects of learner-sent traffic: counters, logs, captured packets. Pure. */
export function applyEffects(s: RootState, fx: Effects): RootState {
  const now = Date.now();
  const bump = <T extends { id: string; hits: number; lastHit?: number | null }>(list: T[], ids: string[]): T[] =>
    ids.length ? list.map((r) => { const n = ids.filter((x) => x === r.id).length; return n ? { ...r, hits: r.hits + n, ...('lastHit' in r ? { lastHit: now } : {}) } : r; }) : list;
  const cfg = s.config;
  return {
    ...s,
    config: {
      ...cfg,
      accessRules: bump(cfg.accessRules, fx.ruleHits),
      natRules: bump(cfg.natRules, fx.natHits),
      routes: bump(cfg.routes, fx.routeHits),
      security: { ...cfg.security, cfs: { ...cfg.security.cfs, rules: bump(cfg.security.cfs.rules, fx.cfsHits) } },
    },
    logs: [...fx.logs.map((l) => ({ ...l, id: uid() } as LogEntry)).reverse(), ...s.logs].slice(0, MAX_LOGS),
    pm: fx.packets.length ? { ...s.pm, packets: [...s.pm.packets, ...fx.packets.map((p) => ({ ...p, id: uid() } as Packet))].slice(-MAX_PKTS) } : s.pm,
  };
}

export function addLogs(s: RootState, logs: Omit<LogEntry, 'id'>[]): RootState {
  if (!logs.length) return s;
  return { ...s, logs: [...logs.map((l) => ({ ...l, id: uid() } as LogEntry)).reverse(), ...s.logs].slice(0, MAX_LOGS) };
}
