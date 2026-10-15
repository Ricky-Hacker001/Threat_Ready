/**
 * Task progression engine (pure). Given state + UI snapshot, advances steps, verifies tasks, unlocks the next,
 * and flags completed tasks whose checks no longer pass ("stale").
 */
import type { Progress, RootState, TaskProgress } from '../state/types';
import type { StepCtx, TaskDef, UiSnapshot, CheckResult } from './types';

export const blankProgress = (): TaskProgress => ({ status: 'locked', step: 0, stepDoneAt: {}, startedAt: null, completedAt: null, failures: [], checks: [] });

export function runChecks(t: TaskDef, s: RootState): { id: string; ok: boolean; detail: string; label: string }[] {
  return t.checks.map((c) => {
    let r: CheckResult;
    try { r = c.test(s); } catch (e) { r = { ok: false, detail: `Check error: ${(e as Error).message}` }; }
    return { id: c.id, label: c.label, ok: r.ok, detail: r.detail };
  });
}

export function stepCtx(s: RootState, ui: UiSnapshot, since: number): StepCtx {
  return {
    s, ui, since,
    events: s.progress.events.filter((e) => e.ts >= since),
    draft: <T,>(key: string) => ui.drafts[key] as T | undefined,
  };
}

export const STEP_GRACE_MS = 2000;

export function stepSince(tp: TaskProgress, t: TaskDef, i: number): number {
  // Grace window: an action taken a moment before the previous step was detected as done still counts.
  if (i === 0) return (tp.startedAt ?? 0) - STEP_GRACE_MS;
  return (tp.stepDoneAt[t.steps[i - 1].id] ?? tp.startedAt ?? 0) - STEP_GRACE_MS;
}

/** Returns a new Progress if anything changed, else null. */
export function advance(s: RootState, ui: UiSnapshot, defs: TaskDef[], now = Date.now()): Progress | null {
  const prev = s.progress;
  const tasks: Record<string, TaskProgress> = {};
  let unlockedSoFar = true;

  for (const t of defs) {
    const tp: TaskProgress = { ...(prev.tasks[t.id] ?? blankProgress()) };
    tp.stepDoneAt = { ...tp.stepDoneAt };
    tp.failures = [...tp.failures];

    if (tp.status === 'locked' && unlockedSoFar) tp.status = 'available';
    if (!unlockedSoFar && tp.status !== 'completed' && tp.status !== 'stale') tp.status = 'locked';

    // Guided start: the current task begins as soon as it is unlocked (scenario tasks wait for the learner).
    if (tp.status === 'available' && prev.current === t.id && !t.scenario) { tp.status = 'in-progress'; tp.startedAt = now; tp.step = 0; }

    if (tp.status === 'in-progress') {
      let i = tp.step;
      let guard = 0;
      while (i < t.steps.length && guard++ < 60) {
        const st = t.steps[i];
        const ctx = stepCtx(s, ui, stepSince(tp, t, i));
        let ok = false;
        try { ok = st.done(ctx); } catch { ok = false; }
        if (!ok) {
          // Record a failure when a save/test happened during this step but did not satisfy it.
          // Only actions taken after this step became active count (not the grace window), and never for incremental steps.
          const triggers = ctx.events.filter((e) => (e.type === 'save' || e.type === 'test') && e.ts > ctx.since + STEP_GRACE_MS);
          if (triggers.length && st.hint && !st.noFail) {
            let why: string | null = null;
            try { why = st.hint(ctx); } catch { why = null; }
            const last = triggers[triggers.length - 1];
            if (why && !tp.failures.some((f) => f.stepId === st.id && f.at === last.ts)) tp.failures.push({ stepId: st.id, reason: why, at: last.ts });
          }
          break;
        }
        tp.stepDoneAt[st.id] = now;
        i++;
      }
      tp.step = i;
      if (i >= t.steps.length) {
        const checks = runChecks(t, s);
        tp.checks = checks.map(({ id, ok, detail }) => ({ id, ok, detail }));
        if (checks.every((c) => c.ok)) { tp.status = 'completed'; tp.completedAt = now; }
      }
    } else if (tp.status === 'completed' || tp.status === 'stale') {
      const checks = runChecks(t, s);
      tp.checks = checks.map(({ id, ok, detail }) => ({ id, ok, detail }));
      tp.status = checks.every((c) => c.ok) ? 'completed' : 'stale';
    }

    tasks[t.id] = tp;
    if (tp.status !== 'completed' && tp.status !== 'stale') unlockedSoFar = false;
  }

  // Move the panel to the next task automatically when the current one completes.
  let current = prev.current;
  const cur = tasks[current];
  if (cur?.status === 'completed' && prev.tasks[current]?.status !== 'completed') {
    const idx = defs.findIndex((t) => t.id === current);
    const next = defs[idx + 1];
    if (next && tasks[next.id].status !== 'locked') {
      current = next.id;
      if (tasks[next.id].status === 'available' && !next.scenario) tasks[next.id] = { ...tasks[next.id], status: 'in-progress', startedAt: now, step: 0 };
    }
  }

  const next: Progress = { ...prev, tasks, current };
  return sameProgress(prev, next) ? null : next;
}

function sameProgress(a: Progress, b: Progress): boolean {
  if (a.current !== b.current) return false;
  const ka = Object.keys(b.tasks);
  for (const k of ka) {
    const x = a.tasks[k];
    const y = b.tasks[k];
    if (!x) return false;
    if (x.status !== y.status || x.step !== y.step || x.failures.length !== y.failures.length) return false;
    if (JSON.stringify(x.checks) !== JSON.stringify(y.checks)) return false;
  }
  return true;
}

export function levelComplete(defs: TaskDef[], p: Progress, level: number): boolean {
  return defs.filter((t) => t.level === level).every((t) => p.tasks[t.id]?.status === 'completed');
}

export function allComplete(defs: TaskDef[], p: Progress): boolean {
  return defs.every((t) => p.tasks[t.id]?.status === 'completed');
}
