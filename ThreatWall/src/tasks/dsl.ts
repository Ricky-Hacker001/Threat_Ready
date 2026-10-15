/** Small helpers so 250+ task steps stay short and consistent. */
import type { RootState } from '../state/types';
import type { StepCtx, StepDef, CheckResult } from './types';
import type { Verdict } from '../engine/traffic';
import { evaluate, type FlowSpec } from '../engine/traffic';

const VIEW_LABEL: Record<string, string> = { home: 'HOME', monitor: 'MONITOR', device: 'DEVICE', network: 'NETWORK', object: 'OBJECT', policy: 'POLICY' };

export function pathLabel(path: string, labels?: [string, string]): string {
  const [v] = path.split('/');
  return labels ? `${VIEW_LABEL[v]} › ${labels[0]} › ${labels[1]}` : VIEW_LABEL[v] ?? path;
}

/** Navigate to a page. */
export function nav(id: string, path: string, crumbs: [string, string], why?: string, beginner?: string): StepDef {
  return {
    id, title: `Open ${pathLabel(path, crumbs)}`, route: path, why, beginner,
    target: `[data-guide="nav:${path}"]`,
    done: (c) => c.ui.route === path || c.events.some((e) => e.type === 'nav' && e.data.path === path),
  };
}

/** Open a dialog / editor — detected by its draft being published. */
export function open(id: string, title: string, draftKey: string, route: string, target: string, opts: Partial<StepDef> & { match?: (d: Record<string, unknown>) => boolean } = {}): StepDef {
  const { match, ...rest } = opts;
  return {
    id, title, route, target, ...rest,
    done: (c) => { const d = c.draft(draftKey); return !!d && (!match || match(d)); },
  };
}

const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : JSON.stringify(v));

/** Fill one field of an open form. Also satisfied if the saved state already has the value. */
export function field(id: string, title: string, draftKey: string, get: (d: Record<string, unknown>) => unknown, want: unknown | unknown[],
  route: string, target: string, opts: Partial<StepDef> & { saved?: (s: RootState) => boolean } = {}): StepDef {
  const wants = Array.isArray(want) ? want : [want];
  const { saved, ...rest } = opts;
  return {
    id, title, route, target, ...rest,
    done: (c) => {
      const d = c.draft(draftKey);
      if (d && wants.some((w) => norm(get(d)) === norm(w))) return true;
      return !!saved?.(c.s);
    },
    hint: (c) => {
      const d = c.draft(draftKey) ?? (saved && !saved(c.s) ? c.draft(`${draftKey}:last`) : undefined);
      if (!d) return null;
      const cur = get(d);
      if (cur === undefined || cur === '' || (Array.isArray(cur) && !cur.length)) return null;
      return wants.some((w) => norm(cur) === norm(w)) ? null : `Currently “${Array.isArray(cur) ? cur.join(', ') : String(cur)}”. Expected: ${wants.map(String).join(' or ')}.`;
    },
  };
}

/** Save: satisfied by saved configuration only. */
export function save(id: string, title: string, route: string, target: StepDef['target'], ok: (s: RootState) => boolean, hint?: (s: RootState) => string | null, opts: Partial<StepDef> = {}): StepDef {
  return { id, title, route, target, ...opts, done: (c) => ok(c.s), hint: hint ? (c) => hint(c.s) : undefined };
}

/** Run a simulated traffic test from Lab Tools and get the expected result. */
export function test(id: string, title: string, match: (d: Record<string, unknown>) => boolean, verdicts: Verdict[], opts: Partial<StepDef> = {}): StepDef {
  return {
    id, title, lab: 'traffic', target: '[data-guide="lt-send"]', ...opts,
    done: (c) => c.events.some((e) => e.type === 'test' && match(e.data) && verdicts.includes(e.data.verdict as Verdict)),
    hint: (c) => {
      const last = [...c.events].reverse().find((e) => e.type === 'test' && match(e.data));
      if (!last || verdicts.includes(last.data.verdict as Verdict)) return null;
      return `Your last test returned “${String(last.data.verdict)}” (${String(last.data.reason)}). Expected: ${verdicts.join(' or ')}.`;
    },
  };
}

/** Any event of a type (optionally matching data) since the step started. */
export function event(id: string, title: string, type: string, match: (d: Record<string, unknown>) => boolean = () => true, opts: Partial<StepDef> = {}): StepDef {
  return { id, title, ...opts, done: (c) => c.events.some((e) => e.type === type && match(e.data)) };
}

/** Informational step acknowledged with "Got it". */
export function info(id: string, title: string, opts: Partial<StepDef> = {}): StepDef {
  return { id, title, info: true, ...opts, done: (c) => c.events.some((e) => e.type === 'ack' && e.data.step === id) };
}

/* ---------- checks ---------- */

export const pass = (detail = ''): CheckResult => ({ ok: true, detail });
export const fail = (detail: string): CheckResult => ({ ok: false, detail });

/** Re-run a flow purely on current state (no side effects) — verification never trusts stored UI flags. */
export function flowIs(s: RootState, spec: FlowSpec, verdicts: Verdict[], at?: number): CheckResult {
  const r = evaluate(s, spec, { at }).result;
  return verdicts.includes(r.verdict) ? pass(`${r.srcName} → ${r.dstName} ${r.service}: ${r.verdict}`) : fail(`${r.srcName} → ${r.dstName} ${r.service} is “${r.verdict}”: ${r.reason}`);
}

export const eq = (a: unknown, b: unknown) => norm(a) === norm(b);
export const evOf = (c: StepCtx, type: string) => c.events.filter((e) => e.type === type);

/** Fill several fields of one open form in a single step. Done when every field matches (or `saved` is already true). */
export function form(id: string, title: string, draftKey: string, want: Record<string, unknown>, route: string, target: string,
  opts: Partial<StepDef> & { saved?: (s: RootState) => boolean; get?: (d: Record<string, unknown>, k: string) => unknown; labels?: Record<string, string> } = {}): StepDef {
  const { saved, get = (d, k) => d[k], labels = {}, hint: customHint, ...rest } = opts;
  const diff = (d: Record<string, unknown>) => Object.entries(want).filter(([k, v]) => {
    const cur = get(d, k);
    return Array.isArray(v) ? !(Array.isArray(cur) && v.every((x) => cur.includes(x))) : norm(cur) !== norm(v);
  });
  return {
    id, title, route, target, expect: Object.entries(want).map(([k, v]) => `${labels[k] ?? k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · '), ...rest,
    done: (c) => { const d = c.draft(draftKey); return (!!d && diff(d).length === 0) || !!saved?.(c.s); },
    hint: (c) => {
      const custom = customHint?.(c);
      if (custom) return custom;
      const live = c.draft(draftKey);
      const last = !live && saved && !saved(c.s) ? c.draft(`${draftKey}:last`) : undefined;
      const d = live ?? last;
      if (!d) return null;
      const bad = diff(d).filter(([k]) => { const cur = get(d, k); return cur !== '' && cur !== undefined && !(Array.isArray(cur) && !cur.length); });
      return bad.length ? (last ? 'You saved: ' : '') + bad.map(([k, v]) => `${labels[k] ?? k} is “${String(get(d, k))}”, expected “${Array.isArray(v) ? v.join(', ') : String(v)}”`).join('; ') + '.' : null;
    },
  };
}

/** Target that follows a confirmation dialog if one is open. */
export const orConfirm = (sel: string) => () => (typeof document !== 'undefined' && document.querySelector('[data-guide="confirm"]') ? '[data-guide="confirm"]' : sel);
