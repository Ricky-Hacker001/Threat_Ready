// Scoring (SEC-3 / BIZ-10): the Expert speed bonus is measured on wall-clock time; active time is information only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { activeMs, score, wallMs } = await import('../src/engine/lab.ts');

const MIN = 60000;
const def = {
  minutes: 20,
  objectives: [
    { id: 'a', check: () => true },
    { id: 'b', check: () => true },
  ],
};
const attempt = (o) => ({ achieved: ['a', 'b'], hintsUsed: [], startedAt: 0, completedAt: null, pausedMs: 0, awayAt: null, ...o });

test('finishing within the time limit earns the speed bonus', () => {
  const s = attempt({ completedAt: 15 * MIN });
  assert.deepEqual(score(def, s, 'expert'), { score: 120, max: 120 });
});

test('time away still counts towards the speed bonus', () => {
  // 40 minutes from start to finish, 35 of them in another tab: 5 active minutes, but no bonus.
  const s = attempt({ completedAt: 40 * MIN, pausedMs: 35 * MIN });
  assert.equal(activeMs(s), 5 * MIN);
  assert.equal(wallMs(s), 40 * MIN);
  assert.deepEqual(score(def, s, 'expert'), { score: 100, max: 120 });
});

test('the bonus needs a completed attempt and Expert mode', () => {
  assert.equal(score(def, attempt({}), 'expert').score, 100);
  assert.equal(score(def, attempt({ completedAt: 5 * MIN }), 'standard').score, 100);
});

test('wall-clock time runs on while the attempt is open; active time stops while away', () => {
  const s = attempt({ awayAt: 10 * MIN, pausedMs: 0 });
  assert.equal(wallMs(s, 30 * MIN), 30 * MIN);
  assert.equal(activeMs(s, 30 * MIN), 10 * MIN);
});
