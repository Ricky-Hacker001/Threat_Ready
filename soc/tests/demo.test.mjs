// Newbie Demo Mode and the homepage walkthrough preview, driven over HTTP.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { start, stop, api, findLeaks, waitForAlert, solveStage, engine, getScenario, sleep } from './helpers.mjs';

const DEMO = 'demo-portal-login';
const scn = getScenario(DEMO);
const F = scn.facts;
const guide = await import('../server/demo/guide.js');
const { store } = await import('../server/store.js');
const { dropPreview } = await import('../server/engine/cases.js');

before(start);
after(stop);

const demo = (id, path = '', body) => api(body === undefined && !path.startsWith('!') ? 'GET' : 'POST', `/api/demo/${id}${path.replace(/^!/, '')}`, body);
const check = (id, beat, data, quiet) => api('POST', `/api/demo/${id}/check`, { beat, data, quiet });
const startDemo = (extra = {}) => api('POST', '/api/demo/start', { analyst: 'learner', ...extra });

// Correct quiz answers, known to the test only.
const QUIZ = {
  '2-terms': { q1: 'event', q2: 'alert', q3: 'case', q4: 'incident' },
  '4-fields': { who: 'target_user', from: 'src_ip', what: 'event_id', result: 'failure_reason' },
  '6-compare': { typo: 'a', inv: 'b', obs: ['count', 'pace', 'source'] },
  '7-facts': { who: 'r.delgado', from: F.ATK, to: 'WEB01', result: 'ok', noise: 'logon_id' },
};
const SUMMARY = 'What happened: fourteen failed logons then a success for r.delgado from 203.0.113.253. It is malicious: threat intelligence reports the address. Evidence: pinned 4625 and 4624 events and firewall lines. Likely cause: a guessable password with no lockout. Impact: data transferred from the portal. Still not known: exactly which records were viewed.';

// Do what one task asks, through the public API, and return the data the
// browser would send with its check.
async function perform(id, beatId) {
  const c = () => engine.getCase(id);
  const stream = () => engine.streamFor(c());
  const tagged = (tag) => stream().events.filter((e) => (e._tags || []).includes(tag));
  const pin = (ev) => api('POST', `/api/cases/${id}/pins`, { eventId: ev.id });
  const tool = (t, input) => api('POST', `/api/cases/${id}/tools/${t}`, { input });
  const act = (type, target) => api('POST', `/api/cases/${id}/actions`, { type, target });
  const submitStage = async (stageId) => {
    const sol = await solveStage(id, scn, stageId);
    const r = await api('POST', `/api/cases/${id}/submit`, sol);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome.complete, true, `${stageId}: ${JSON.stringify(r.body.case.current?.feedback)}`);
  };
  switch (beatId) {
    case '2-terms': case '4-fields': case '6-compare': case '7-facts': return { answers: QUIZ[beatId] };
    case '2-ack': await waitForAlert(id); await api('POST', `/api/cases/${id}/ack`); return {};
    case '3-open': return { open: [c().alert.matched[3]] };
    case '5-task': return { search: { q: `event_id:4625 src_ip:${F.ATK}`, source: '' } };
    case '7-open': return { open: [tagged('atk_ok')[0].id] };
    case '8-intel': await tool('reputation', F.ATK); return {};
    case '8-directory': await tool('user', F.USER); await tool('change', ''); return {};
    case '8-classify': return { form: { values: { source: F.ATK, account: F.USER, verdict: 'tp', severity: 'high' } } };
    case '9-pin': await pin(tagged('atk_fail')[0]); await pin(tagged('atk_ok')[0]); return {};
    case '9-select': return { form: { values: { evidence: [tagged('atk_fail')[0].id, tagged('atk_ok')[0].id] } } };
    case '10-decide': await submitStage('l1_triage'); return {};
    case '10-handoff': await submitStage('l2_escalation'); return {};
    case '11-sweep': await tool('sweep', F.ATK); return {};
    case '11-correlate': await pin(tagged('atk_data')[0]); await pin(tagged('legit')[0]); return {};
    case '11-findings': await submitStage('l2_investigation'); return {};
    case '12-summary': return { form: { values: { summary: SUMMARY } } };
    case '12-signoff': await submitStage('l2_validation'); return {};
    case '13-contain': await act('reset_credentials', F.USER); await act('block_ip', F.ATK); return {};
    case '13-notify': await act('notify', 'ir_lead'); await act('notify', 'user_mgr'); return {};
    case '13-declare': { const r = await api('POST', `/api/cases/${id}/submit`, {}); assert.equal(r.status, 200, JSON.stringify(r.body)); return {}; }
    case '14-negative': await sleep(1100); stream().ensure(Date.now() + 150000); await pin(tagged('atk_denied')[0]); return {};
    case '14-positive': await pin(tagged('legit_after')[0]); return {};
    case '14-record': await submitStage('l3_verify'); return {};
    case '15-close': await submitStage('closure'); return {};
    default: return {};
  }
}

test('the demo scenario is hidden from the normal simulation', async () => {
  const list = await api('GET', '/api/scenarios');
  assert.ok(!list.body.some((s) => s.id === DEMO), 'the demo scenario is not listed');
  assert.ok(list.body.every((s) => s.code && s.level), 'every listed scenario is a level scenario');
  const direct = await api('POST', '/api/cases', { scenarioId: DEMO, analyst: 'x' });
  assert.equal(direct.status, 400);
  // A request body cannot turn an assessment case into a demo or preview:
  // v2 refuses direct case creation, and the attempt route ignores `kind`.
  const inj = await api('POST', '/api/cases', { scenarioId: 'F3', analyst: 'x', kind: 'demo', backdateSeconds: 9999 });
  assert.equal(inj.status, 400);
  const att = await api('POST', '/api/attempts', { scenarioId: 'F3', kind: 'demo', backdateSeconds: 9999 }, { user: 'inject.check' });
  assert.equal(att.status, 201);
  const c = await api('GET', `/api/cases/${att.body.caseId}`, undefined, { user: 'inject.check' });
  assert.equal(c.body.kind, undefined);
  assert.match(c.body.ticket, /^INC-/);
  assert.ok(Date.now() - c.body.createdAt < 5000);
  await api('POST', `/api/attempts/${att.body.attemptId}/abandon`, undefined, { user: 'inject.check' });
});

test('starting a demo creates one isolated session', async () => {
  const before = await api('POST', '/api/cases', { scenarioId: 's02-authfail', analyst: 'seq-a' });
  const [a, b] = await Promise.all([startDemo({ nonce: 'n-1' }), startDemo({ nonce: 'n-1' })]);
  assert.equal(a.status, 201);
  assert.equal(a.body.id, b.body.id, 'a double click must not create two sessions');
  assert.match(a.body.ticket, /^DEMO-\d{4}-\d{4}$/);
  const after = await api('POST', '/api/cases', { scenarioId: 's02-authfail', analyst: 'seq-b' });
  const n = (t) => Number(t.split('-')[2]);
  assert.equal(n(after.body.ticket), n(before.body.ticket) + 1, 'demo tickets do not consume assessment ticket numbers');

  const list = await api('GET', '/api/cases');
  assert.ok(!list.body.some((c) => c.id === a.body.id), 'demo sessions are not listed with cases');
  assert.ok(list.body.every((c) => !c.kind));

  const info = await api('GET', '/api/demo/info');
  assert.equal(info.body.title, 'Newbie Demo Mode');
  assert.equal(info.body.steps.length, 16);

  // Demo endpoints refuse anything that is not a demo session.
  assert.equal((await demo(before.body.id)).status, 404);
  assert.equal((await check(before.body.id, '2-ack', {})).status, 404);
  assert.equal((await demo('ffffffffffff')).status, 404);
  assert.match((await demo('ffffffffffff')).body.error, /no longer available/);
  await api('DELETE', `/api/cases/${a.body.id}`);
});

test('the guide sent to the browser carries no answer material', async () => {
  const { body: s } = await startDemo();
  await waitForAlert(s.id);
  const st = await demo(s.id);
  assert.equal(st.status, 200);
  assert.equal(st.body.beats.length, guide.BEATS.length);
  assert.deepEqual(findLeaks(st.body), []);
  const blob = JSON.stringify(st.body);
  for (const f of scn.stages.flatMap((x) => x.fields || [])) {
    const k = f.key || {};
    for (const text of [k.explain, k.reveal, k.hint, ...(k.coach && typeof k.coach === 'object' ? Object.values(k.coach) : [])]) {
      if (text && text.length > 30) assert.ok(!blob.includes(text), `${f.id}: answer text reached the browser`);
    }
  }
  assert.ok(!blob.includes(scn.secret.truth({ t0: 0 }).summary.slice(0, 60)));
  // Every one of the sixteen steps is present and each beat says what, why and how.
  assert.deepEqual([...new Set(st.body.beats.map((b) => b.step))], Array.from({ length: 16 }, (_, i) => i + 1));
  for (const b of st.body.beats) {
    for (const k of ['title', 'focus', 'what', 'why', 'how', 'expect', 'next']) assert.ok(b[k], `${b.id} is missing ${k}`);
    if (b.kind === 'task') assert.ok(b.check?.label, `${b.id} has no check`);
    assert.equal(typeof b.check?.fn, 'undefined');
  }
  for (const b of guide.BEATS.filter((x) => x.kind === 'task')) assert.equal(typeof guide.CHECKS[b.id], 'function', `${b.id} has no server check`);
  // Widgets are built from this case's own logs.
  const w = st.body.beats.find((b) => b.id === '4-fields').widget;
  assert.equal(w.event.fields.event_id, 4625);
  assert.ok(w.example.rows.length > 5);
  // The normal case view of a demo session leaks nothing either.
  assert.deepEqual(findLeaks((await api('GET', `/api/cases/${s.id}`)).body), []);
  await api('DELETE', `/api/cases/${s.id}`);
});

test('tasks cannot be skipped, jumped over or self-certified', async () => {
  const { body: s } = await startDemo();
  const id = s.id;
  // Explanations can be viewed or skipped.
  assert.equal((await check(id, '1-console', {})).body.ok, true);
  assert.equal((await demo(id, '!/skip', { beat: '1-tiers' })).status, 200);
  for (const b of ['2-ticketbar', '2-tabs', '2-workflow']) await check(id, b, {});
  // A task cannot be skipped.
  const skip = await demo(id, '!/skip', { beat: '2-terms' });
  assert.equal(skip.status, 409);
  assert.match(skip.body.error, /cannot be skipped/);
  // Nor jumped over.
  const jump = await demo(id, '!/goto', { beat: '5-task' });
  assert.equal(jump.status, 409);
  assert.equal(jump.body.frontier, '2-terms');
  assert.equal((await check(id, '5-task', { search: { q: 'x' } })).status, 409);
  // A client-side "completed" flag is not evidence.
  const fake = await check(id, '2-terms', { completed: true, ok: true });
  assert.equal(fake.body.ok, false);
  assert.ok(!fake.body.progress.done.includes('2-terms'));
  // Wrong answers get a specific explanation, and can be retried.
  const wrong = await check(id, '2-terms', { answers: { q1: 'alert', q2: 'alert', q3: 'case', q4: 'incident' } });
  assert.equal(wrong.body.ok, false);
  assert.match(wrong.body.items.find((i) => i.id === 'q1').message, /single recorded attempt/);
  assert.equal(wrong.body.items.find((i) => i.id === 'q2').ok, true);
  const right = await check(id, '2-terms', { answers: QUIZ['2-terms'] });
  assert.equal(right.body.ok, true);
  assert.equal(right.body.progress.tries['2-terms'], 3);
  // State-based checks read the case, not the request.
  assert.equal((await check(id, '2-ack', { status: 'open' })).body.ok, false);
  // A quiet (automatic) re-check that fails is not counted as a try.
  const tries = (await check(id, '2-ack', {}, true)).body.progress.tries['2-ack'];
  assert.equal(tries, 1);
  await perform(id, '2-ack');
  assert.equal((await check(id, '2-ack', {}, true)).body.ok, true);
  // Unknown beats are refused.
  assert.equal((await check(id, 'nope', {})).status, 400);
  await api('DELETE', `/api/cases/${id}`);
});

test('search, classification and form feedback coach towards the next step', async () => {
  const { body: s } = await startDemo();
  const id = s.id;
  for (const b of guide.BEATS) {
    if (b.id === '5-task') break;
    const r = await check(id, b.id, await perform(id, b.id));
    assert.equal(r.body.ok, true, `${b.id}: ${r.body.message}`);
  }
  const q = (search) => check(id, '5-task', { search });
  assert.match((await q({ q: '' })).body.message, /empty/);
  assert.match((await q({ q: 'event_id:4625' })).body.message, /Too broad/);
  assert.match((await q({ q: `src_ip:${F.ATK}` })).body.message, /Too broad/);
  assert.match((await q({ q: `event_id:4625 src_ip:${F.ATK} auth_package:Kerberos` })).body.message, /no events/);
  const c = engine.getCase(id);
  const fails = engine.streamFor(c).events.filter((e) => (e._tags || []).includes('atk_fail'));
  assert.match((await q({ q: `event_id:4625 src_ip:${F.ATK}`, from: fails[3].ts })).body.message, /Too narrow.*11 of the 14.*time range/);
  assert.match((await q({ q: `event_id:4625 src_ip:${F.ATK}`, source: 'firewall' })).body.message, /no events/);
  assert.equal((await q({ q: `event_id:4625 src_ip:${F.ATK}` })).body.ok, true);
  // Reviewing a passed task with a wrong answer does not undo it.
  const again = await q({ q: 'event_id:4625' });
  assert.equal(again.body.alreadyDone, true);
  assert.ok(again.body.progress.done.includes('5-task'));

  for (const b of ['5-sources', '6-compare', '7-open', '7-facts', '7-context', '8-defs', '8-intel', '8-directory']) {
    const r = await check(id, b, await perform(id, b));
    assert.equal(r.body.ok, true, `${b}: ${r.body.message}`);
  }
  // Wrong classification: each wrong choice gets its own coaching.
  const bad = await check(id, '8-classify', { form: { values: { source: F.WS_IP, account: F.USER, verdict: 'btp', severity: 'medium' } } });
  assert.equal(bad.body.ok, false);
  const msg = Object.fromEntries(bad.body.items.map((i) => [i.id, i]));
  assert.match(msg.source.message, /own workstation/);
  assert.equal(msg.account.ok, true);
  assert.match(msg.verdict.message, /proof that the activity is allowed/);
  assert.match(msg.severity.message, /default/);
  assert.equal(engine.getCase(id).stages.l1_triage.attempts, undefined, 'a pre-check is not a submission');
  // The same coaching comes back from a real submission, which can be retried without limit.
  const pins = engine.streamFor(c).events.filter((e) => ['atk_fail', 'atk_ok'].some((t) => (e._tags || []).includes(t))).slice(-2);
  for (const e of pins) await api('POST', `/api/cases/${id}/pins`, { eventId: e.id });
  const values = { source: F.ATK, account: F.USER, verdict: 'fp', severity: 'high', evidence: pins.map((e) => e.id), decision: 'close_fp', note: 'x'.repeat(50) };
  for (let i = 1; i <= 3; i++) {
    const r = await api('POST', `/api/cases/${id}/submit`, { values, finalize: true });
    assert.equal(r.body.outcome.complete, false, 'a guided stage cannot be finalised with wrong answers');
    const fb = Object.fromEntries(r.body.case.current.feedback.map((f) => [f.id, f]));
    assert.match(fb.verdict.message, /should not match/);
    assert.equal(/Shown after three tries/.test(fb.verdict.message), i >= 3);
    assert.equal(fb.source.locked, true);
    assert.equal(r.body.case.current.noFinalize, true);
    assert.equal(r.body.case.stage, 'l1_triage');
    assert.deepEqual(findLeaks(r.body), []);
  }
  await api('DELETE', `/api/cases/${id}`);
});

let finished;
test('a full guided run reaches the learning summary', async () => {
  const { body: s } = await startDemo({ nonce: 'full' });
  const id = s.id;
  const early = await demo(id, '/summary');
  assert.equal(early.body.complete, false);
  assert.equal(early.body.guidedResult, null);

  for (const b of guide.BEATS) {
    assert.equal((await demo(id, '!/goto', { beat: b.id })).status, 200, `goto ${b.id}`);
    const data = await perform(id, b.id);
    const r = await check(id, b.id, data);
    assert.equal(r.status, 200, `${b.id}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true, `${b.id}: ${r.body.message} ${JSON.stringify(r.body.items || '')}`);
  }
  const st = await demo(id);
  assert.equal(st.body.progress.status, 'completed');
  assert.equal(st.body.progress.frontier, null);
  assert.equal(st.body.progress.tasksDone, st.body.progress.tasksTotal);

  const cs = (await api('GET', `/api/cases/${id}`)).body;
  assert.equal(cs.status, 'closed');
  assert.equal(cs.kind, 'demo');
  assert.equal(cs.report.score, 100);
  assert.ok(cs.history.some((h) => /reassigned from L1 to L2/.test(h.text)), 'escalation continues the same ticket');
  assert.equal(cs.ticket, s.ticket);

  const sum = (await demo(id, '/summary')).body;
  assert.equal(sum.complete, true);
  assert.match(sum.disclaimer, /not an independent assessment and not a certification/);
  assert.equal(sum.guidedResult, 100);
  assert.equal(sum.steps.length, 16);
  assert.ok(sum.steps.every((x) => x.status === 'Complete'), JSON.stringify(sum.steps.filter((x) => x.status !== 'Complete')));
  assert.equal(sum.checks.open.length, 0);
  assert.equal(sum.checks.retried.length, 0);
  assert.ok(sum.evidence.pins.length >= 6);
  assert.deepEqual(sum.evidence.indicators.map((i) => i.value), [F.ATK]);
  assert.ok(sum.did.length >= 5 && sum.wentWell.length >= 3 && sum.next.length >= 2);
  // Nothing is sent anywhere real: every action is an entry in the simulated action log only.
  assert.ok(engine.getCase(id).actions.every((a) => a.id && a.label));
  assert.ok(!(await api('GET', '/api/cases')).body.some((c) => c.id === id));
  finished = id;
});

test('the response cannot be declared complete, or verified, without doing the work', async () => {
  const { body: s } = await startDemo();
  const id = s.id;
  for (const b of guide.BEATS) {
    if (b.id === '13-contain') break;
    assert.equal((await check(id, b.id, await perform(id, b.id))).body.ok, true, b.id);
  }
  // Declaring complete with nothing done is refused by the server.
  const early = await api('POST', `/api/cases/${id}/submit`, {});
  assert.equal(early.status, 409);
  assert.match(early.body.error, /block the attacker address and reset/);
  // Disabling the account instead of resetting it is noticed.
  await api('POST', `/api/cases/${id}/actions`, { type: 'disable_account', target: F.USER });
  const half = await check(id, '13-contain', {});
  assert.equal(half.body.ok, false);
  assert.match(half.body.items.find((i) => i.id === 'r').message, /disabled instead/);
  await perform(id, '13-contain');
  assert.equal((await check(id, '13-contain', {})).body.ok, true);
  assert.equal((await check(id, '13-notify', await perform(id, '13-notify'))).body.ok, true);
  assert.equal((await check(id, '13-declare', await perform(id, '13-declare'))).body.ok, true);
  // No proof pinned yet: clicking the buttons was not enough.
  const neg = await check(id, '14-negative', {});
  assert.equal(neg.body.ok, false, JSON.stringify(neg.body));
  assert.match(neg.body.message, /No deny line has been logged yet|not pinned/);
  await sleep(1100);
  const stream = engine.streamFor(engine.getCase(id));
  stream.ensure(Date.now() + 150000);
  assert.match((await check(id, '14-negative', {})).body.message, /exists in the logs but is not pinned/);
  assert.equal((await check(id, '14-negative', await perform(id, '14-negative'))).body.ok, true);
  // The account is disabled, so the positive test cannot pass and the learner is told why.
  const pos = await check(id, '14-positive', {});
  assert.equal(pos.body.warn, true, JSON.stringify(pos.body));
  assert.match(pos.body.message, /Positive test failed: the account was disabled/);
  const sum = (await demo(id, '/summary')).body;
  assert.ok(sum.improve.some((x) => /Positive test failed/.test(x)), 'a failed test is reported, not hidden');
  assert.ok(!sum.wentWell.some((x) => /negative and a positive test/.test(x)));
  assert.ok(stream.events.some((e) => (e._tags || []).includes('legit_broken')), 'the real user is locked out in the logs');
  assert.ok(!stream.events.some((e) => (e._tags || []).includes('legit_after')));
  await api('DELETE', `/api/cases/${id}`);
});

test('pause, resume, review, replay and reset touch only the demo session', async () => {
  const other = await api('POST', '/api/cases', { scenarioId: 's02-authfail', analyst: 'bystander' });
  const { body: s } = await startDemo();
  const id = s.id;
  for (const b of guide.BEATS.slice(0, 7)) await check(id, b.id, await perform(id, b.id));
  assert.equal((await demo(id, '!/status', { status: 'paused' })).body.progress.status, 'paused');
  assert.equal((await demo(id, '!/status', { status: 'bogus' })).status, 400);
  // Resume: same session, progress kept, cursor where it was left.
  await demo(id, '!/goto', { beat: '3-feed' });
  const resumed = await startDemo({ resumeId: id });
  assert.equal(resumed.body.id, id);
  const st = (await demo(id)).body;
  assert.equal(st.progress.status, 'active');
  assert.equal(st.progress.cursor, '3-feed');
  assert.ok(st.progress.done.includes('2-ack'));
  // Review an earlier, completed step.
  assert.equal((await demo(id, '!/goto', { beat: '2-terms' })).status, 200);
  assert.equal((await demo(id, '!/status', { status: 'exited' })).body.progress.status, 'exited');

  // Reset gives a clean session and removes only the old demo session.
  const [r1, r2] = await Promise.all([demo(id, '!/reset', { nonce: 'r-1' }), demo(id, '!/reset', { nonce: 'r-1' })]);
  assert.equal(r1.status, 201);
  assert.equal(r1.body.id, r2.body.id);
  assert.notEqual(r1.body.id, id);
  assert.equal((await demo(id)).status, 404);
  assert.equal((await api('GET', `/api/cases/${id}`)).status, 404);
  const clean = (await demo(r1.body.id)).body;
  assert.deepEqual(clean.progress.done, []);
  assert.equal(clean.progress.cursor, '1-console');
  assert.equal(clean.case.status, 'monitoring');
  // A stale resume id falls back to a new session rather than failing.
  const stale = await startDemo({ resumeId: id });
  assert.equal(stale.status, 201);
  assert.notEqual(stale.body.id, id);

  // The bystander case and the finished demo are untouched.
  assert.equal((await api('GET', `/api/cases/${other.body.id}`)).status, 200);
  assert.equal((await demo(finished, '/summary')).body.complete, true);
  // Replay of a finished demo: new session, old one gone.
  const replay = await demo(finished, '!/reset', {});
  assert.equal(replay.status, 201);
  assert.equal((await demo(finished)).status, 404);
  for (const x of [r1.body.id, stale.body.id, replay.body.id, other.body.id]) await api('DELETE', `/api/cases/${x}`);
});

test('the walkthrough preview is read-only, redacted and creates no cases', async () => {
  const listed = (await api('GET', '/api/cases')).body.length;
  const stored = store.all().length;
  const ids = {};
  for (const point of ['l1', 'l2', 'l3', 'closed']) {
    const r = await api('POST', '/api/tour/preview', { point });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ids[point] = r.body.id;
    assert.equal((await api('POST', '/api/tour/preview', { point })).body.id, r.body.id, 'previews are shared, not created per request');
  }
  assert.equal((await api('POST', '/api/tour/preview', { point: 'x' })).status, 400);
  assert.equal((await api('GET', '/api/cases')).body.length, listed, 'no case is listed');
  assert.equal(store.all().length, stored, 'nothing is written to the case store');

  const want = { l1: 'l1_triage', l2: 'l2_investigation', l3: 'l3_response' };
  for (const [point, id] of Object.entries(ids)) {
    const cs = (await api('GET', `/api/cases/${id}`)).body;
    assert.equal(cs.kind, 'preview');
    assert.equal(cs.readOnly, true);
    assert.match(cs.ticket, /^SAMPLE-/);
    if (want[point]) assert.equal(cs.stage, want[point]); else assert.equal(cs.status, 'closed');
    const { truth: sampleNote, ...reportRest } = cs.report || {};
    assert.deepEqual(findLeaks({ ...cs, report: reportRest }), []);
    // Nothing the server filled in on the learner's behalf is shown.
    assert.ok(cs.stages.every((x) => x.review === undefined));
    assert.ok(cs.pins.every((p) => cs.alert.matched.includes(p.eventId)));
    const blob = JSON.stringify(cs.history);
    assert.doesNotMatch(blob, /Verdict:|Disposition:|Source: |r\.delgado\. |Sample entry/);
    assert.ok(cs.history.every((h) => h.data === undefined));
    if (point === 'closed') {
      assert.equal(cs.report.sample, true);
      assert.ok(cs.report.stages.every((x) => x.fields === undefined && x.objectives === undefined));
      assert.deepEqual(cs.report.truth.timeline, []);
      assert.doesNotMatch(JSON.stringify(cs.report), /fourteen|guess/i);
    }
    // Every change is refused.
    const ev = (await api('GET', `/api/cases/${id}/logs?limit=1`)).body.events[0];
    for (const [m, url, body] of [
      ['POST', `/api/cases/${id}/pins`, { eventId: ev.id }], ['POST', `/api/cases/${id}/notes`, { text: 'x' }],
      ['POST', `/api/cases/${id}/tools/change`, {}], ['POST', `/api/cases/${id}/submit`, {}],
      ['POST', `/api/cases/${id}/actions`, { type: 'block_ip', target: '203.0.113.9' }], ['POST', `/api/cases/${id}/ack`, undefined],
      ['PUT', `/api/cases/${id}/draft`, { values: {} }], ['DELETE', `/api/cases/${id}`, undefined],
    ]) {
      const r = await api(m, url, body);
      assert.ok([403, 409].includes(r.status), `${m} ${url} -> ${r.status}`);
    }
    // A preview is not a demo session.
    assert.equal((await demo(id)).status, 404);
    dropPreview(id);
    assert.equal((await api('GET', `/api/cases/${id}`)).status, 404);
  }
});

test('frontend source and the built bundle contain no answer material', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = fileURLToPath(new URL('../client/', import.meta.url));
  const files = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (/\.(jsx?|css|html)$/.test(f.name)) files.push(p); } };
  walk(path.join(root, 'src'));
  if (fs.existsSync(path.join(root, 'dist'))) walk(path.join(root, 'dist'));
  assert.ok(files.length > 15);
  const needles = new Set();
  for (const id of ['s01-beacon', 's02-authfail', DEMO]) {
    const s = getScenario(id);
    for (const f of s.stages.flatMap((x) => x.fields || [])) {
      const k = f.key || {};
      for (const t of [k.explain, k.reveal, k.hint, k.describe, ...(k.coach && typeof k.coach === 'object' ? Object.values(k.coach) : [])]) if (t && t.length > 30) needles.add(t);
    }
    for (const o of s.secret.response?.objectives || []) needles.add(o.explain);
    needles.add(s.secret.truth({ t0: 0 }).summary.slice(0, 80));
  }
  for (const v of Object.values(getScenario('s01-beacon')._test.IOC)) if (typeof v === 'string' && v.length > 8) needles.add(v);
  needles.add(F.ATK);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const n of needles) assert.ok(!text.includes(n), `${path.relative(root, file)} contains answer material: ${n.slice(0, 50)}`);
    assert.doesNotMatch(text, /atk_fail|atk_ok|legit_after|atk_denied/, `${path.relative(root, file)} contains evidence tags`);
  }
});
