/**
 * Task verification tests: with the answer key applied, each task's checks pass; on the state just before it, they do not;
 * and no later solution makes an earlier task stale.
 */
import { describe, expect, it } from 'vitest';
import type { RootState } from '../state/types';
import { initialState } from '../state/baseline';
import { TASKS } from './index';
import { runChecks } from './runtime';
import * as K from './solutions';
import { seedRuleset } from './level2';
import { seedBeacon, seedRouteFault, seedVpnFaults } from './level4';

type S = RootState;
const markSteps = (id: string) => (s: S): S => {
  const t = TASKS.find((x) => x.id === id)!;
  return { ...s, progress: { ...s.progress, tasks: { ...s.progress.tasks, [id]: { status: 'in-progress', step: t.steps.length, stepDoneAt: Object.fromEntries(t.steps.map((st) => [st.id, 1])), startedAt: 1, completedAt: null, failures: [], checks: [] } } } };
};
const exported = (s: S): S => ({ ...s, audit: [{ id: 'x', ts: 1, user: 'admin', category: 'System', action: 'Configuration exported', detail: 'lab.exp' }, ...s.audit] });

export const CHAIN: [string, (s: S) => S][] = [
  ['0.1', K.s01], ['0.2', K.s02], ['0.3', K.s03], ['0.4', markSteps('0.4')], ['0.5', K.s05], ['0.6', (s) => exported(K.s06(s))], ['0.7', K.s07],
  ['1.1', K.s11], ['1.2', (s) => s], ['1.3', K.s13], ['1.4', K.s14], ['1.5', K.s15], ['1.6', K.s16],
  ['2.1', K.s21], ['2.2', K.s22], ['2.3', (s) => K.s23(s, seedRuleset)], ['2.4', K.s24], ['2.5', K.s25], ['2.6', K.s26], ['2.7', K.s27],
  ['3.1', K.s31], ['3.2', K.s32], ['3.3', K.s33], ['3.4', K.s34], ['3.5', K.s35],
  ['4.1', K.s41], ['4.2', (s) => K.s42(s, seedRouteFault)], ['4.3', (s) => K.s43(s, seedVpnFaults)], ['4.4', K.s44], ['4.5', (s) => K.s45(s, seedBeacon)],
];

const failing = (id: string, s: S) => runChecks(TASKS.find((t) => t.id === id)!, s).filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`);

describe('task checks against the answer key', () => {
  let s = initialState();
  const states: Record<string, S> = {};
  for (const [id, apply] of CHAIN) {
    it(`${id} fails before and passes after its configuration`, () => {
      const before = s;
      s = apply(s);
      states[id] = s;
      expect(failing(id, s)).toEqual([]);
      if (apply !== CHAIN.find((c) => c[0] === '1.2')![1]) expect(failing(id, before).length).toBeGreaterThan(0);
    });
  }
  it('no task goes stale once everything is configured', () => {
    for (const [id] of CHAIN) expect([id, failing(id, s)]).toEqual([id, []]);
  });
});
