// Level rules and scoring (Build specification, sections 5.1, 6.4 and 7.1).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, api, solveStage, engine, getScenario, registerOwner, grantLevels } from './helpers.mjs';

before(start);
after(stop);

async function open(user, scenarioId) {
  const a = await api('POST', '/api/attempts', { scenarioId, canonical: true }, { user });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  registerOwner(a.body.caseId, user);
  const id = a.body.caseId;
  for (let i = 0; i < 40; i++) { if ((await api('GET', `/api/cases/${id}`)).body.alert) break; await new Promise((r) => setTimeout(r, 400)); }
  await api('POST', `/api/cases/${id}/ack`);
  return { id, attemptId: a.body.attemptId };
}

test('scenario score: weighted, skipped stages excluded, missed stages count zero, half rounds up', () => {
  const c = { scenarioId: 'F3', stages: {
    monitoring: { status: 'done' },
    l1_triage: { status: 'done', score: { earned: 30, max: 60 } },
    l2_review: { status: 'skipped' },
    closure: { status: 'done', score: { earned: 18, max: 18 } },
  } };
  assert.equal(engine.totalScore(c), 70); // (60*50 + 40*100) / 100
  c.stages.l2_review.missed = true;
  assert.equal(engine.totalScore(c), 61); // (3000 + 0 + 4000) / 115 = 60.87
  delete c.stages.l2_review.missed;
  c.stages.closure.score = { earned: 51.25, max: 100 };
  assert.equal(engine.totalScore(c), 51); // (3000 + 2050) / 100 = 50.5 -> 51
  assert.equal(engine.stagePct({ score: { earned: 8, max: 10 }, collateralPenalty: 20 }), 60);
  assert.equal(engine.stagePct({ score: { earned: 1, max: 10 }, collateralPenalty: 20 }), 0);
});

test('Foundations: three rounds, 100/70/40 decay, automatic hint under a wrong answer', async () => {
  const scn = getScenario('F3');
  const { id } = await open('sc.found', 'F3');
  const good = await solveStage(id, scn, 'l1_triage');
  let r = await api('POST', `/api/cases/${id}/submit`, { ...good, values: { ...good.values, category: 'brute' } });
  assert.equal(r.body.outcome.complete, false);
  assert.equal(r.body.outcome.attemptsLeft, 2);
  assert.equal(r.body.case.current.attempts, 3);
  r = await api('POST', `/api/cases/${id}/submit`, { ...good, values: { ...good.values, category: 'spray' } });
  assert.equal(r.body.outcome.attemptsLeft, 1);
  r = await api('POST', `/api/cases/${id}/submit`, good);
  assert.equal(r.body.outcome.complete, true);
  r = await api('POST', `/api/cases/${id}/submit`, await solveStage(id, scn, 'closure'));
  const f = r.body.case.report.stages.find((s) => s.id === 'l1_triage').fields.find((x) => x.label === 'What the activity is');
  assert.equal(f.earned, 2.4); // 6 points x 40% (third round)
  const att = (await api('GET', `/api/attempts/${r.body.attempt.attemptId}`, undefined, { user: 'sc.found' })).body;
  const q = att.questions.find((x) => x.field === 'category');
  assert.equal(q.credit, 0.4);
  assert.equal(att.metrics.firstRoundRate < 1, true);
  assert.ok(att.metrics.hintsUsed >= 0);
  const h = await api('POST', `/api/cases/${id}/hint`, { stageId: 'l1_triage', fieldId: 'category' });
  assert.equal(h.status, 409); // closed case: nothing to hint
});

test('Intermediate: two rounds, hint on request caps the question at 80%', async () => {
  grantLevels('sc.inter', ['foundations']);
  const scn = getScenario('I1');
  const { id } = await open('sc.inter', 'I1');
  const c = (await api('GET', `/api/cases/${id}`)).body;
  assert.equal(c.current.attempts, 2);
  assert.equal(c.current.hintPolicy, 'request');
  const withHint = c.current.fields.find((f) => f.hintAvailable);
  assert.ok(withHint, 'questions offer a hint');
  assert.equal(withHint.hintText, undefined, 'hint text is not sent until requested');
  const h = await api('POST', `/api/cases/${id}/hint`, { stageId: c.current.id, fieldId: withHint.id });
  assert.equal(h.status, 200);
  assert.ok(h.body.hint.length > 10);
  assert.equal(h.body.cap, 0.8);
  const after = (await api('GET', `/api/cases/${id}`)).body.current.fields.find((f) => f.id === withHint.id);
  assert.equal(after.hintText, h.body.hint);
  const r = await api('POST', `/api/cases/${id}/submit`, await solveStage(id, scn, c.current.id));
  assert.equal(r.body.outcome.complete, true);
  const st = engine.getCase(id).stages[c.current.id];
  assert.equal(st.fields[withHint.id].hinted, true);
  assert.equal(st.fields[withHint.id].best, 0.8);
  assert.equal((await api('POST', `/api/cases/${id}/hint`, { stageId: 'nope', fieldId: withHint.id })).status, 409);
});

test('Foundations and Expert refuse hint requests with hints_off', async () => {
  const { id } = await open('sc.nohint', 'F3');
  const r = await api('POST', `/api/cases/${id}/hint`, { stageId: 'l1_triage', fieldId: 'category' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'hints_off');
  grantLevels('sc.exp');
  const e = await open('sc.exp', 'E1');
  const c = (await api('GET', `/api/cases/${e.id}`)).body;
  assert.equal(c.current.attempts, 1);
  assert.ok(c.current.fields.every((f) => !f.hintAvailable));
  const r2 = await api('POST', `/api/cases/${e.id}/hint`, { stageId: 'l1_triage', fieldId: 'verdict' });
  assert.equal(r2.status, 403);
  assert.equal(r2.body.error, 'hints_off');
});

test('response stage: collateral actions cost 5 points each, capped at 20; metrics and skills are written', async () => {
  grantLevels('sc.resp', ['foundations']);
  const scn = getScenario('I1');
  const { id, attemptId } = await open('sc.resp', 'I1');
  const atk = scn.entities.ips[0];
  let r;
  for (let i = 0; i < 10; i++) {
    const c = (await api('GET', `/api/cases/${id}`)).body;
    if (c.status === 'closed') break;
    assert.ok(c.current, `no current stage: ${c.status} ${c.stage} ${String(JSON.stringify(r?.body)).slice(0, 300)}`);
    if (c.current.kind === 'response') {
      for (const [type, target] of [['block_ip', atk], ['reset_credentials', 'r.delgado'], ['notify', 'ir_lead'], ['notify', 'user_mgr'],
        ['isolate_host', 'WS-FIN-009', true], ['disable_account', 'd.okafor']]) {
        const x = await api('POST', `/api/cases/${id}/actions`, { type, target, confirm: true });
        assert.equal(x.status, 200, JSON.stringify(x.body));
      }
      r = await api('POST', `/api/cases/${id}/submit`, {});
      const st = engine.getCase(id).stages[c.current.id];
      assert.equal(st.collateral, 2);
      assert.equal(st.collateralPenalty, 10);
    } else {
      // Proof-of-containment lines appear in the live feed after the actions.
      if (c.current.id === 'l3_verify') { await new Promise((x) => setTimeout(x, 1100)); engine.streamFor(engine.getCase(id)).ensure(Date.now() + 150000); }
      r = await api('POST', `/api/cases/${id}/submit`, await solveStage(id, scn, c.current.id));
    }
  }
  assert.equal(r.body.case.status, 'closed');
  assert.ok(r.body.attempt.score < 100 && r.body.attempt.score >= 90, `score ${r.body.attempt.score}`);
  const att = (await api('GET', `/api/attempts/${attemptId}`, undefined, { user: 'sc.resp' })).body;
  assert.equal(att.status, 'closed');
  assert.equal(att.metrics.collateralActions, 2);
  assert.equal(att.metrics.missedContainment, 0);
  assert.equal(att.metrics.verdictCorrect, true);
  assert.equal(att.skills['res.proportionality'], 67); // notify objective (2 pts, full) + proportionality (4 pts, 50%)
  assert.equal(att.skills['res.containment'], 100);
  assert.ok(att.questions.length > 10);
  assert.ok(att.questions.every((q) => q.skills.length && q.points > 0));
});
