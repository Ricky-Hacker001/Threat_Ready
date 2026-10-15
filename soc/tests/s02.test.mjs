import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, api, seen, findLeaks, waitForAlert, solveStage, engine, getScenario } from './helpers.mjs';

const scn = getScenario('s02-authfail');
before(start);
after(stop);

async function open(analyst) {
  const { body } = await api('POST', '/api/cases', { scenarioId: 's02-authfail', analyst });
  await waitForAlert(body.id);
  const ack = await api('POST', `/api/cases/${body.id}/ack`);
  assert.equal(ack.body.stage, 'l1_triage');
  return body.id;
}

test('benign true positive: closed at Tier 1, L2 never involved', async () => {
  const id = await open('fp-perfect');
  const c0 = (await api('GET', `/api/cases/${id}`)).body;
  assert.equal(c0.alert.rule, 'AUTH-0031');
  assert.match(c0.alert.description, /36 failed network logons against 6 hosts/);
  assert.equal(c0.alert.entity.host, null, 'the alert reports an address; identifying the host is the analyst\'s job');

  const ch = await api('POST', `/api/cases/${id}/tools/change`, { input: 'scan' });
  const rec = ch.body.result.items.find((x) => x.id === 'CHG-4471');
  assert.ok(rec && rec.start < Date.now() && rec.end > Date.now(), 'the change window is open now');

  const q = await api('GET', `/api/cases/${id}/logs?limit=500&q=${encodeURIComponent('event_id:4625 src_ip:10.10.0.60')}`);
  assert.equal(q.body.total, 36);
  assert.equal(new Set(q.body.events.map((e) => e.fields.target_user)).size, 6);

  let r = await api('POST', `/api/cases/${id}/submit`, await solveStage(id, scn, 'l1_triage'));
  assert.equal(r.body.case.stage, 'closure');
  assert.equal(r.body.case.stages.find((s) => s.id === 'l2_review').status, 'skipped');
  assert.equal(r.body.case.stages.find((s) => s.id === 'l1_triage').score.pct, 100);

  assert.deepEqual(seen.flatMap((x) => findLeaks(x.json)), []);

  r = await api('POST', `/api/cases/${id}/submit`, await solveStage(id, scn, 'closure'));
  assert.equal(r.body.case.status, 'closed');
  assert.equal(r.body.case.report.score, 100);
  assert.ok(r.body.case.report.stages.find((s) => s.id === 'l2_review').skipped);

  // The scan keeps running after the alert: two more hosts are scanned live.
  const c = engine.getCase(id);
  const s = engine.streamFor(c);
  const liveFails = s.events.filter((e) => (e._tags || []).includes('scan_fail') && e.ts > c.t0);
  assert.ok(liveFails.length <= 12);
});

test('unnecessary escalation goes through L2 review and costs credit', async () => {
  const id = await open('fp-escalate');
  const s = await solveStage(id, scn, 'l1_triage');
  s.values.verdict = 'tp';
  s.values.severity = 'high';
  s.values.category = 'spray';
  s.values.decision = 'escalate';
  // v2: Foundations allows three rounds; finalise the wrong decision now.
  let r = await api('POST', `/api/cases/${id}/submit`, { ...s, finalize: true });
  assert.equal(r.body.case.stage, 'l2_review');
  assert.equal(r.body.case.tier, 'L2');
  assert.equal(r.body.case.stages.find((x) => x.id === 'l1_triage').result, 'Escalated');

  r = await api('POST', `/api/cases/${id}/submit`, await solveStage(id, scn, 'l2_review'));
  assert.equal(r.body.case.stage, 'closure');
  assert.ok(r.body.case.history.some((h) => /Returned to Tier 1/.test(h.text)));

  r = await api('POST', `/api/cases/${id}/submit`, await solveStage(id, scn, 'closure'));
  assert.equal(r.body.case.status, 'closed');
  assert.ok(r.body.case.report.score < 80 && r.body.case.report.score > 40, `score ${r.body.case.report.score}`);
  assert.equal(r.body.case.report.stages.length, 3);
});

test('response actions are not available in a scenario with no response stage', async () => {
  const id = await open('fp-actions');
  const r = await api('POST', `/api/cases/${id}/actions`, { type: 'isolate_host', target: 'SCAN01' });
  assert.equal(r.status, 403);
});
