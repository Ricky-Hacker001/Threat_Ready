import type { Progress } from '../state/types';
import { TASKS } from '../tasks';
import type { TaskDef } from '../tasks/types';
import { DEFAULT_ROUTE, routeFor } from '../shell/nav';

export type LevelState = 'locked' | 'open' | 'in-progress' | 'complete';

export interface LevelSummary {
  level: number; total: number; done: number; stale: number; fails: number; minutes: number;
  first: string; last: string; state: LevelState;
}

const st = (p: Progress, id: string) => p.tasks[id]?.status ?? 'locked';

export function levelSummary(p: Progress, level: number): LevelSummary {
  const ts = TASKS.filter((t) => t.level === level);
  const done = ts.filter((t) => st(p, t.id) === 'completed').length;
  const stale = ts.filter((t) => st(p, t.id) === 'stale').length;
  const fails = ts.reduce((a, t) => a + (p.tasks[t.id]?.failures.length ?? 0), 0);
  const touched = ts.some((t) => p.tasks[t.id]?.startedAt);
  const state: LevelState = done === ts.length ? 'complete' : st(p, ts[0].id) === 'locked' ? 'locked' : touched ? 'in-progress' : 'open';
  return { level, total: ts.length, done, stale, fails, minutes: ts.reduce((a, t) => a + t.minutes, 0), first: ts[0].id, last: ts[ts.length - 1].id, state };
}

/** The first task that is unlocked and not yet verified (re-verify counts), in track order. */
export function nextTask(p: Progress): TaskDef | null {
  return TASKS.find((t) => { const s = st(p, t.id); return s !== 'completed' && s !== 'locked'; }) ?? null;
}

export const LAST_ROUTE_KEY = 'tw-last-route';

/** Where "Continue" returns to: the last appliance page the learner had open. */
export function lastRoute(): string {
  try {
    const r = localStorage.getItem(LAST_ROUTE_KEY);
    if (r && routeFor(r)) return r;
  } catch { /* storage unavailable */ }
  return DEFAULT_ROUTE;
}

