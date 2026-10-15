import type { RootState } from '../state/types';
import type { StepCtx, StepDef, TaskDef, UiSnapshot } from '../tasks/types';
import { stepCtx, stepSince } from '../tasks/runtime';
import { VIEWS } from '../shell/nav';

export interface Current {
  task: TaskDef | undefined;
  step: StepDef | null;
  index: number;
  ctx: StepCtx | null;
}

export function currentStep(s: RootState, ui: UiSnapshot, defs: TaskDef[]): Current {
  const task = defs.find((t) => t.id === s.progress.current);
  const tp = task ? s.progress.tasks[task.id] : undefined;
  if (!task || !tp || tp.status !== 'in-progress' || tp.step >= task.steps.length) return { task, step: null, index: tp?.step ?? 0, ctx: null };
  const st = task.steps[tp.step];
  return { task, step: st, index: tp.step, ctx: stepCtx(s, ui, stepSince(tp, task, tp.step)) };
}

const VIEW_LABEL: Record<string, string> = { home: 'HOME', monitor: 'MONITOR', device: 'DEVICE', network: 'NETWORK', object: 'OBJECT', policy: 'POLICY' };

/** What to highlight right now: navigation first, then the step's own target. */
export function guideTarget(st: StepDef, ctx: StepCtx, ui: UiSnapshot, loggedIn: boolean, prev?: StepDef): { selector: string; text: string } | null {
  if (st.lab && (!ui.labOpen || ui.labTab !== st.lab)) {
    return ui.labOpen
      ? { selector: `[data-guide="labtab:${st.lab}"]`, text: 'Open this Lab Tools tab' }
      : { selector: '[data-guide="labtools"]', text: 'Open Lab Tools' };
  }
  if (st.route && loggedIn && !st.route.startsWith('browser:') && ui.route !== st.route) {
    const [v, g] = st.route.split('/');
    const curView = ui.route.split('/')[0];
    if (curView !== v) return { selector: `[data-guide="view:${v}"]`, text: `Click ${VIEW_LABEL[v]}` };
    const item = document.querySelector(`[data-guide="nav:${st.route}"]`);
    if (item) {
      const view = VIEWS.find((x) => x.id === v);
      const label = view?.groups.find((x) => x.id === g)?.items.find((i) => `${v}/${g}/${i.id}` === st.route)?.label ?? '';
      return { selector: `[data-guide="nav:${st.route}"]`, text: `Click ${label}` };
    }
    const gl = VIEWS.find((x) => x.id === v)?.groups.find((x) => x.id === g)?.label ?? '';
    return { selector: `[data-guide="group:${v}/${g}"]`, text: `Expand ${gl}` };
  }
  const t = typeof st.target === 'function' ? st.target(ctx) : st.target;
  if (t && st.tab && typeof document !== 'undefined' && !document.querySelector(t)) {
    const tabEl = document.querySelector(`[data-guide="tab:${st.tab}"]`);
    if (tabEl) return { selector: `[data-guide="tab:${st.tab}"]`, text: `Open the ${tabEl.textContent ?? st.tab} tab` };
  }
  // The form this step works in was closed (e.g. saved with a wrong value): point back at the button that opens it.
  if (t && prev && typeof document !== 'undefined' && !document.querySelector(t)) {
    const pt = typeof prev.target === 'function' ? prev.target(ctx) : prev.target;
    if (pt && document.querySelector(pt)) return { selector: pt, text: `Re-open: ${prev.title}` };
  }
  return t ? { selector: t, text: st.expect ? `${st.title} — ${st.expect}` : st.title } : null;
}
