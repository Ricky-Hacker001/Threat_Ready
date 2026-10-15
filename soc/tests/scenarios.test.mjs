// Every library scenario (Build specification, Phase 7 acceptance):
// alert matched events exist and exclude decoys; every answer is supported
// by the logs or tools; a scripted perfect run scores 100 (renamed and
// canonical); a scripted always-wrong run scores below the pass mark.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, api, solveStage, engine, registerOwner, grantLevels } from './helpers.mjs';

const { allLevelScenarios } = await import('../server/scenarios/index.js');
const { levelById } = await import('../server/levels.js');
const LEGACY = new Set(['F3', 'I1', 'E1']); // covered by s02, demo and s01 tests
const ONLY = process.env.SCN ? new Set(process.env.SCN.split(',')) : null;
const list = allLevelScenarios().filter((s) => !LEGACY.has(s.code) && (!ONLY || ONLY.has(s.code)));

before(start);
after(stop);

async function open(user, scn, canonical) {
  grantLevels(user, ['foundations', 'intermediate']);
  const a = await api('POST', '/api/attempts', { scenarioId: scn.id, canonical, backdate: (scn.alert.at || 5) + 2 }, { user });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  registerOwner(a.body.caseId, user);
  const id = a.body.caseId;
  const c = (await api('GET', `/api/cases/${id}`)).body;
  assert.ok(c.alert, 'alert fired');
  const ack = await api('POST', `/api/cases/${id}/ack`);
  assert.equal(ack.status, 200);
  return id;
}

function fastForward(id) {
  engine.streamFor(engine.getCase(id)).ensure(Date.now() + 180000);
}

async function run(id, scn, mode) {
  let r;
  for (let i = 0; i < 12; i++) {
    const c = (await api('GET', `/api/cases/${id}`)).body;
    if (c.status === 'closed') break;
    const st = c.current;
    if (st.kind === 'response') {
      if (mode === 'perfect') {
        for (const q of scn._test.searches || []) await api('GET', `/api/cases/${id}/logs?limit=1&q=${encodeURIComponent(engine.aliasFor(engine.getCase(id)).out(q))}`);
        for (const [type, target] of scn._test.response || []) {
          const x = await api('POST', `/api/cases/${id}/actions`, { type, target: engine.aliasFor(engine.getCase(id)).out(target), confirm: true });
          assert.equal(x.status, 200, `${type} ${target}: ${JSON.stringify(x.body).slice(0, 200)}`);
          assert.equal(x.body.action.ok, true, `${type} ${target}: ${x.body.action.summary}`);
        }
      }
      r = await api('POST', `/api/cases/${id}/submit`, {});
      fastForward(id);
      continue;
    }
    fastForward(id);
    const body = mode === 'perfect' ? await solveStage(id, scn, st.id) : wrongAnswers(id, scn, st.id);
    r = await api('POST', `/api/cases/${id}/submit`, { ...body, finalize: true });
    assert.equal(r.status, 200, `${st.id}: ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  assert.equal(r.body.case.status, 'closed');
  return r.body;
}

function wrongAnswers(id, scn, stageId) {
  const def = scn.stages.find((s) => s.id === stageId);
  const c = engine.getCase(id);
  const noise = engine.streamFor(c).events.filter((e) => !(e._tags || []).length);
  const alias = engine.aliasFor(c);
  const values = {};
  for (const f of def.fields) {
    const k = f.key || {};
    switch (f.type) {
      case 'single': {
        const acc = typeof k.accept === 'string' ? { [k.accept]: 1 } : k.accept;
        values[f.id] = f.options.map((o) => o.value).find((v) => !acc[v]) ?? f.options[0].value;
        break;
      }
      case 'multi': values[f.id] = f.options.map((o) => o.value).filter((v) => !k.set.includes(v)).slice(0, 2); if (!values[f.id].length) values[f.id] = [f.options[0].value]; break;
      case 'host': values[f.id] = k.accept === 'DC01' ? 'DC02' : 'DC01'; break;
      case 'account': values[f.id] = k.accept === 'k.yamamoto' ? 'p.nair' : 'k.yamamoto'; break;
      case 'hosts': values[f.id] = ['BKP01']; break;
      case 'accounts': values[f.id] = ['k.yamamoto']; break;
      case 'text': values[f.id] = 'not-the-answer'; break;
      case 'longtext': values[f.id] = 'Recorded by the automated wrong-answer run, which deliberately answers every question incorrectly.'; break;
      case 'order': values[f.id] = [...k.order].reverse(); break;
      case 'pins': values[f.id] = [noise[0].id]; break;
      case 'pin_one': values[f.id] = noise[1].id; break;
      default: break;
    }
  }
  for (const nEv of noise.slice(0, 2)) if (!c.pins.some((p) => p.eventId === nEv.id)) c.pins.push({ eventId: nEv.id, note: '', at: Date.now(), by: 'test', snapshot: nEv });
  return { values: alias.outDeep(values), links: {} };
}

function appears(scn, stream, value) {
  const v = String(value).toLowerCase();
  if (stream.events.some((e) => e._lc.includes(v))) return true;
  const hay = JSON.stringify([scn.intel({ t0: 0 }), scn.changes, scn.assetNotes, scn.accountNotes, scn.sandbox, scn.accountState, scn.assetRecords]).toLowerCase();
  if (hay.includes(v)) return true;
  return false;
}

for (const scn of list) {
  test(`${scn.code}: evidence, alert, perfect and wrong runs`, async () => {
    const pass = levelById(scn.level).passMark;
    // 1. Renamed perfect run
    const id = await open(`scn.${scn.code}.p`, scn, false);
    const c = engine.getCase(id);
    const stream = engine.streamFor(c);
    fastForward(id);
    // alert matched events exist and are not decoys
    assert.ok(c.alert.matched.length > 0, 'alert has matched events');
    for (const eid of c.alert.matched) {
      const ev = stream.get(eid);
      assert.ok(ev, 'matched event exists');
      assert.ok(!(ev._tags || []).some((t) => t.startsWith('decoy')), 'decoys are never matched');
    }
    // every tag a key relies on exists, and every typed answer is in the logs or tools
    for (const def of scn.stages.filter((s) => s.kind === 'form')) {
      for (const f of def.fields) {
        const k = f.key || {};
        const tags = [...(k.support || []), ...Object.values(k.groups || {}).flat(), ...Object.keys(f.type === 'pin_one' ? k.accept : {})];
        for (const t of tags) assert.ok(stream.events.some((e) => (e._tags || []).includes(t)), `${def.id}.${f.id}: tag ${t} exists`);
        const answers = f.type === 'text' ? k.accept : ['host', 'account'].includes(f.type) ? [k.accept] : ['hosts', 'accounts'].includes(f.type) ? k.set : [];
        for (const a of answers) assert.ok(appears(scn, stream, a), `${def.id}.${f.id}: answer ${a} is findable`);
      }
    }
    const perfect = await run(id, scn, 'perfect');
    assert.equal(perfect.attempt.score, 100, `perfect run: ${JSON.stringify(perfect.case.report.stages.map((s) => [s.id, s.pct, (s.fields || []).filter((f) => f.verdict !== 'correct').map((f) => f.label), (s.objectives || []).filter((o) => o.verdict !== 'correct').map((o) => o.label), s.findings]))}`);
    // 2. Always-wrong run
    const wid = await open(`scn.${scn.code}.w`, scn, false);
    const wrong = await run(wid, scn, 'wrong');
    assert.ok(wrong.attempt.score < pass, `wrong run scored ${wrong.attempt.score}, pass mark ${pass}`);
    assert.equal(wrong.attempt.passed, false);
  });
}
