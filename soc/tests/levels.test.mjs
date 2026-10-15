// Unlocking, best attempt, internal badges (Build specification, section 5).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, api, repo, waitForAlert, solveStage, getScenario, grantLevels } from './helpers.mjs';

before(start);
after(stop);

const fakeClosed = (uid, scenarioId, level, score, passMark, when = '2026-10-14T08:00:00.000Z') => repo.createAttempt({
  schema: 'soc-attempt/1', attemptId: `att_FAKE${uid}${scenarioId}${score}${when.slice(11, 13)}`, caseId: null, ticket: null, userId: uid, userName: uid,
  scenarioId, level, scenarioVersion: 1, keyVersion: 1, seed: 1, status: 'closed', startedAt: when, closedAt: when, activeSeconds: 60,
  stages: [], answers: {}, questions: [], score, passMark, passed: score >= passMark, skills: {}, metrics: {},
});

async function perfectF3(user) {
  const scn = getScenario('F3');
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user });
  assert.equal(a.status, 201);
  const id = a.body.caseId;
  // canonical attempts run unrenamed, so the solver's canonical answers apply
  const opts = { user };
  for (let i = 0; i < 40; i++) { if ((await api('GET', `/api/cases/${id}`, undefined, opts)).body.alert) break; await new Promise((r) => setTimeout(r, 400)); }
  await api('POST', `/api/cases/${id}/ack`, undefined, opts);
  let r = await api('POST', `/api/cases/${id}/submit`, await solveAs(user, id, scn, 'l1_triage'), opts);
  r = await api('POST', `/api/cases/${id}/submit`, await solveAs(user, id, scn, 'closure'), opts);
  return { a: a.body, r };
}

// solveStage pins through the shared helper; the case owner header is set by helpers' owner map.
async function solveAs(user, id, scn, stage) {
  const { registerOwner } = await import('./helpers.mjs');
  registerOwner(id, user);
  return solveStage(id, scn, stage);
}

test('a new user sees Foundations open and the other levels locked', async () => {
  const r = await api('GET', '/api/levels', undefined, { user: 'lv.new' });
  assert.deepEqual(r.body.map((l) => [l.id, l.state]), [['foundations', 'open'], ['intermediate', 'locked'], ['expert', 'locked']]);
  assert.equal(r.body[1].unlockAfterName, 'Foundations');
  const d = await api('GET', '/api/levels/expert', undefined, { user: 'lv.new' });
  assert.equal(d.body.level.state, 'locked');
  assert.ok(d.body.scenarios.length >= 1, 'locked levels still list their scenarios');
  const e = await api('POST', '/api/attempts', { scenarioId: 'E1' }, { user: 'lv.new' });
  assert.equal(e.status, 403);
  assert.equal(e.body.error, 'level_locked');
  const i = await api('POST', '/api/attempts', { scenarioId: 'I1' }, { user: 'lv.new' });
  assert.equal(i.body.error, 'level_locked');
  assert.equal((await api('GET', '/api/levels/nope', undefined, { user: 'lv.new' })).status, 404);
});

test('one open attempt per scenario; abandon scores 0 and frees the scenario', async () => {
  const u = { user: 'lv.open' };
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3' }, u);
  const again = await api('POST', '/api/attempts', { scenarioId: 'F3' }, u);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'attempt_open');
  assert.equal(again.body.attemptId, a.body.attemptId);
  const ab = await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, u);
  assert.equal(ab.body.status, 'abandoned');
  assert.equal(ab.body.score, 0);
  assert.equal((await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, u)).status, 409);
  const b = await api('POST', '/api/attempts', { scenarioId: 'F3' }, u);
  assert.equal(b.status, 201);
  assert.notEqual(b.body.attemptId, a.body.attemptId);
  const list = await api('GET', '/api/attempts', undefined, u);
  assert.deepEqual(list.body.attempts.map((x) => x.status), ['open', 'abandoned']);
  const d = await api('GET', '/api/levels/foundations', undefined, u);
  assert.equal(d.body.scenarios.find((s) => s.code === 'F3').state, 'in_progress');
  await api('POST', `/api/attempts/${b.body.attemptId}/abandon`, undefined, u);
  const d2 = await api('GET', '/api/levels/foundations', undefined, u);
  assert.equal(d2.body.scenarios.find((s) => s.code === 'F3').state, 'abandoned');
});

test('the tenth distinct pass earns the badge in the same response and opens the next level', async () => {
  const uid = 'lv.badge';
  // Nine other Foundations scenarios already passed (one of them twice).
  const codes = ['F1', 'F2', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'];
  codes.forEach((c, i) => fakeClosed(uid, c, 'foundations', 70 + i, 60));
  fakeClosed(uid, 'F1', 'foundations', 95, 60, '2026-10-14T09:00:00.000Z');
  fakeClosed(uid, 'F11', 'foundations', 40, 60); // not passed: does not count
  let lv = (await api('GET', '/api/levels', undefined, { user: uid })).body;
  assert.equal(lv[0].passed, 9);
  assert.equal(lv[1].state, 'locked');

  const { r } = await perfectF3(uid);
  assert.equal(r.body.case.status, 'closed');
  assert.equal(r.body.attempt.score, 100);
  assert.equal(r.body.attempt.passed, true);
  assert.equal(r.body.awards.length, 1);
  const b = r.body.awards[0];
  assert.equal(b.level, 'foundations');
  assert.equal(b.passedCount, 10);
  assert.equal(b.internal, true);
  assert.equal(b.nextLevel.id, 'intermediate');
  // mean of best scores of the passed scenarios: F1 best 95, others 71..78, F3 100
  const expected = Math.round((95 + 71 + 72 + 73 + 74 + 75 + 76 + 77 + 78 + 100) / 10);
  assert.equal(b.average, expected);
  assert.doesNotMatch(JSON.stringify(r.body.awards), /certif/i);

  lv = (await api('GET', '/api/levels', undefined, { user: uid })).body;
  assert.equal(lv[0].state, 'completed');
  assert.equal(lv[1].state, 'open');
  assert.equal(lv[2].state, 'locked');

  // A further pass never creates a second badge, and the badge average stays frozen.
  fakeClosed(uid, 'F12', 'foundations', 100, 60);
  const { r: r2 } = await perfectF3(uid);
  assert.equal(r2.body.awards.length, 0);
  assert.equal(r2.body.attempt.newBest, false);
  const aw = (await api('GET', '/api/awards', undefined, { user: uid })).body.badges;
  assert.equal(aw.length, 1);
  assert.equal(aw[0].average, expected);
  const live = (await api('GET', '/api/levels', undefined, { user: uid })).body[0];
  assert.notEqual(live.bestAverage, null);
});

test('best attempt: highest score, earlier wins a tie; demo never counts', async () => {
  const uid = 'lv.best';
  fakeClosed(uid, 'F1', 'foundations', 55, 60, '2026-10-14T08:00:00.000Z');
  fakeClosed(uid, 'F1', 'foundations', 82, 60, '2026-10-14T09:00:00.000Z');
  fakeClosed(uid, 'F1', 'foundations', 82, 60, '2026-10-14T10:00:00.000Z');
  const { bestAttempt } = await import('../server/attempts.js');
  const best = bestAttempt(repo.listAttempts(uid));
  assert.equal(best.score, 82);
  assert.equal(best.closedAt, '2026-10-14T09:00:00.000Z');
  const demo = await api('POST', '/api/demo/start', { nonce: 'lv-demo' }, { user: uid });
  assert.equal(demo.status, 201);
  const lv = (await api('GET', '/api/levels', undefined, { user: uid })).body[0];
  assert.equal(lv.passed, 1);
  assert.equal(lv.attempted, 1);
});

test('levels never re-lock; only the daily wipe removes records', async () => {
  const uid = 'lv.wipe';
  grantLevels(uid, ['foundations']);
  assert.equal((await api('GET', '/api/levels', undefined, { user: uid })).body[1].state, 'open');
  const a = await api('POST', '/api/attempts', { scenarioId: 'I1' }, { user: uid });
  assert.equal(a.status, 201);
  const { msToMidnightUtc } = await import('../server/index.js');
  assert.equal(msToMidnightUtc(Date.UTC(2026, 9, 14, 23, 59, 0)), 60000);
  assert.equal(msToMidnightUtc(Date.UTC(2026, 9, 15, 0, 0, 0)), 86400000);
  repo.wipeAll();
  assert.equal((await api('GET', '/api/levels', undefined, { user: uid })).body[1].state, 'locked');
  assert.equal((await api('GET', '/api/attempts', undefined, { user: uid })).body.total, 0);
  assert.equal((await api('GET', `/api/cases/${a.body.caseId}`, undefined, { user: uid })).status, 404);
});
