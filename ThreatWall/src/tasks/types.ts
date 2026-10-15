import type { LabEvent, RootState } from '../state/types';

export interface UiSnapshot { route: string; labOpen: boolean; labTab: string; drafts: Record<string, unknown> }

export interface StepCtx {
  s: RootState;
  ui: UiSnapshot;
  since: number;              // when this step became active
  events: LabEvent[];         // events since the step became active
  draft: <T = Record<string, unknown>>(key: string) => T | undefined;
}

export interface StepDef {
  id: string;
  title: string;              // the single action to perform
  expect?: string;            // exact value(s)
  why?: string;
  beginner?: string;          // plain-English explanation of the field / concept
  route?: string;             // page where the action happens
  lab?: string;               // Lab Tools tab where the action happens
  target?: string | ((c: StepCtx) => string | null);  // CSS selector to highlight
  tab?: string;               // page tab the target lives on (guide points at the tab first)
  info?: boolean;             // informational: learner acknowledges with "Got it"
  noFail?: boolean;           // incremental step (e.g. moving a rule one place at a time): never record a failed attempt
  prefill?: Record<string, unknown>;                 // Lab Tools test the learner can load (they still press Send)
  done: (c: StepCtx) => boolean;
  hint?: (c: StepCtx) => string | null;               // what is wrong right now, if anything
}

export interface CheckResult { ok: boolean; detail: string }
export interface CheckDef { id: string; label: string; test: (s: RootState) => CheckResult }

export interface TaskDef {
  id: string;
  level: 0 | 1 | 2 | 3 | 4;
  title: string;
  minutes: number;
  difficulty: 'Fresher' | 'Junior' | 'Advanced' | 'Expert';
  what: string;
  whatWeDo: string;
  why: string;
  prerequisites: string[];
  expected: { label: string; value: string }[];
  steps: StepDef[];
  checks: CheckDef[];
  verify: string;             // how the learner proves it
  mistakes: string[];
  troubleshooting: string[];
  scenario?: { label: string; apply: (s: RootState) => RootState };
  notes?: { key: string; label: string; placeholder: string; rows?: number }[];   // free-text evidence (RCA, report)
}

export const LEVELS = [
  { id: 0, name: 'Level 0 — Access', tagline: 'From the box to the first login' },
  { id: 1, name: 'Level 1 — Fresher', tagline: 'A safe, working office LAN' },
  { id: 2, name: 'Level 2 — Junior engineer', tagline: 'Publish, segment, control' },
  { id: 3, name: 'Level 3 — Advanced', tagline: 'Inspect threats, connect sites and people' },
  { id: 4, name: 'Level 4 — Expert', tagline: 'Run it in production' },
] as const;
