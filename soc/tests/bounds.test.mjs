// Per-case growth bounds (audit 2026-10-29, H3): free-text tool arguments are sliced, the lists an
// analyst appends to are capped, drafts are reduced to the form's own fields, a write that would push
// the serialised case past 512 kB is refused with 413 and rolled back, and the JSON body limit is 64 kB.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, api, engine, getScenario, grantLevels, registerOwner, baseUrl } from './helpers.mjs';

before(start);
after(stop);

// A canonical F3 attempt, alert fired and acknowledged, driven through the engine where speed matters.
async function openCase(user) {
  grantLevels(user);
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  registerOwner(a.body.caseId, user);
  const c = engine.getCase(a.body.caseId);
  engine.tick(c, c.t0 + 10_000);
  engine.acknowledge(c);
  assert.equal(c.status, 'open');
  return { c, attemptId: a.body.attemptId };
}
const close = (user, attemptId) => api('POST', `/api/attempts/${attemptId}/abandon`, undefined, { user });

test('tool filter is bounded to 300 characters before it runs and before it is recorded', async () => {
  const u = 't.bound.filter';
  const { c, attemptId } = await openCase(u);
  const r = await api('POST', `/api/cases/${c.id}/tools/change`, { input: '', filter: 'X'.repeat(5000) }, { user: u });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const run = c.toolRuns[c.toolRuns.length - 1];
  assert.equal(run.tool, 'change');
  assert.equal(run.filter.length, 300);
  assert.equal(run.filter, 'x'.repeat(300));
  // The 300-character bound on `input` still holds.
  await api('POST', `/api/cases/${c.id}/tools/change`, { input: 'Y'.repeat(5000) }, { user: u });
  assert.equal(c.toolRuns[c.toolRuns.length - 1].input.length, 300);
  await close(u, attemptId);
});

test('toolRuns, history and iocs are capped (oldest dropped) and keep working past the cap', async () => {
  const u = 't.bound.caps';
  const { c, attemptId } = await openCase(u);
  for (let i = 0; i < 410; i++) engine.tool(c, 'change', { input: `run-${i}` });
  assert.equal(c.toolRuns.length, 400);
  assert.equal(c.toolRuns[0].input, 'run-10', 'the ten oldest runs were dropped');
  assert.equal(c.toolRuns[399].input, 'run-409');

  for (let i = 0; i < 1010; i++) engine.addNote(c, `note ${i}`);
  assert.equal(c.history.length, 1000);
  assert.equal(c.history[999].text, 'note 1009');
  assert.ok(!c.history.some((h) => h.kind === 'system' && h.text.startsWith('Shift started')), 'the oldest entries went first');

  for (let i = 0; i < 110; i++) engine.addIoc(c, { type: 'domain', value: `host-${i}.example.test` });
  assert.equal(c.iocs.length, 100);
  assert.equal(c.iocs[0].value, 'host-10.example.test');
  assert.equal(c.iocs[99].value, 'host-109.example.test');
  // Still a working case: the public view is served and the lists are bounded in it too.
  const r = await api('GET', `/api/cases/${c.id}`, undefined, { user: u });
  assert.equal(r.status, 200);
  assert.equal(r.body.history.length, 1000);
  assert.equal(r.body.iocs.length, 100);
  await close(u, attemptId);
});

test('a draft keeps only the form\'s own fields, bounded, in the shape the form produces', async () => {
  const u = 't.bound.draft';
  const { c, attemptId } = await openCase(u);
  const def = getScenario('F3').stages.find((s) => s.id === c.stage);
  assert.equal(def.kind, 'form');
  const ids = def.fields.map((f) => f.id);
  const single = def.fields.find((f) => ['single', 'text', 'longtext'].includes(f.type)) || def.fields[0];
  const listy = def.fields.find((f) => ['multi', 'pins', 'order', 'hosts', 'accounts', 'ioc_list'].includes(f.type));
  const values = {
    [single.id]: 'A'.repeat(5000),
    unknown_field: 'dropped',
    constructor: 'dropped',
    nested: { deep: { deeper: 'dropped' } },
  };
  // An own "__proto__" key, as JSON.parse produces it on the server.
  Object.defineProperty(values, '__proto__', { value: { polluted: true }, enumerable: true });
  for (let i = 0; i < 200; i++) values[`junk_${i}`] = 'x'.repeat(40);
  if (listy) values[listy.id] = Array.from({ length: 52 }, (_, i) => (i % 2 ? `item-${i}` : { type: 'domain', value: 'v'.repeat(520), extra: { not: 'a string' } }));
  const links = { [single.id]: Array.from({ length: 52 }, (_, i) => (i % 3 ? 'e'.repeat(520) : { not: 'a string' })), unknown_field: ['e1'] };
  const r = await api('PUT', `/api/cases/${c.id}/draft`, { values, links }, { user: u });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const draft = c.stages[c.stage].draft;
  for (const k of Object.keys(draft.values)) assert.ok(ids.includes(k), `unexpected draft key ${k}`);
  for (const k of Object.keys(draft.links)) assert.ok(ids.includes(k), `unexpected link key ${k}`);
  assert.equal(draft.values[single.id].length, 2000);
  assert.equal(Object.getPrototypeOf(draft.values), Object.prototype);
  assert.equal(draft.values.polluted, undefined);
  if (listy) {
    const l = draft.values[listy.id];
    assert.equal(l.length, 50);
    assert.equal(l[1], 'item-1');
    assert.deepEqual(l[0], { type: 'domain', value: 'v'.repeat(500) }, 'object items keep string fields only, each bounded');
  }
  // 52 links → first 50 kept → the 33 strings among them, each sliced to 500.
  assert.equal(draft.links[single.id].length, 33);
  assert.ok(draft.links[single.id].every((x) => x === 'e'.repeat(500)));
  // What the analyst gets back is the cleaned draft.
  const g = await api('GET', `/api/cases/${c.id}`, undefined, { user: u });
  assert.deepEqual(g.body.current.draft, draft);
  // Non-object bodies are tolerated.
  assert.equal((await api('PUT', `/api/cases/${c.id}/draft`, { values: 'nope', links: [1, 2] }, { user: u })).status, 200);
  assert.deepEqual(c.stages[c.stage].draft, { values: {}, links: {} });
  await close(u, attemptId);
});

test('a write that would push the case past 512 kB answers 413 and is not kept', async () => {
  const u = 't.bound.size';
  const { c, attemptId } = await openCase(u);
  const CAP = 512 * 1024;
  const size = () => JSON.stringify(c).length;
  // Fill through the engine until the guard trips.
  let tripped = null;
  for (let i = 0; i < 400 && !tripped; i++) {
    try { engine.addNote(c, `${i}:${'n'.repeat(1990)}`); } catch (err) { tripped = err; }
  }
  assert.ok(tripped, 'the guard trips before 400 notes of 2000 characters');
  assert.equal(tripped.status, 413);
  assert.equal(tripped.message, 'case_too_large');
  assert.ok(size() <= CAP, `stored case is ${size()} bytes`);
  // Top up with one-character notes so any further write of a few hundred bytes trips the guard.
  for (let i = 0; i < 100; i++) { try { engine.addNote(c, 'x'); } catch { break; } }
  assert.ok(CAP - size() < 200, `case sits ${CAP - size()} bytes under the cap`);
  const histLen = c.history.length;
  const rev = c.rev;
  const single = getScenario('F3').stages.find((s) => s.id === c.stage).fields[0];

  // Every write path over HTTP: refused, mapped to 413, nothing persisted.
  const note = await api('POST', `/api/cases/${c.id}/notes`, { text: 'one more' }, { user: u });
  assert.equal(note.status, 413);
  assert.equal(note.body.error, 'case_too_large');
  assert.match(note.body.requestId, /^req_/);
  assert.equal(c.history.length, histLen);
  assert.equal(c.rev, rev);
  assert.ok(!c.history.some((h) => h.text === 'one more'));

  const runs = c.toolRuns.length;
  const tool = await api('POST', `/api/cases/${c.id}/tools/change`, { input: 'guarded' }, { user: u });
  assert.equal(tool.status, 413);
  assert.equal(c.toolRuns.length, runs);
  assert.ok(!c.toolRuns.some((t) => t.input === 'guarded'));

  const iocs = c.iocs.length;
  const ioc = await api('POST', `/api/cases/${c.id}/iocs`, { type: 'domain', value: 'guarded.example.test' }, { user: u });
  assert.equal(ioc.status, 413);
  assert.equal(c.iocs.length, iocs);

  const before = c.stages[c.stage].draft;
  const draft = await api('PUT', `/api/cases/${c.id}/draft`, { values: { [single.id]: 'g'.repeat(1500) } }, { user: u });
  assert.equal(draft.status, 413);
  assert.equal(c.stages[c.stage].draft, before);

  const ev = engine.streamFor(c).events[0];
  const pins = c.pins.length;
  const pin = await api('POST', `/api/cases/${c.id}/pins`, { eventId: ev.id, note: 'guarded' }, { user: u });
  assert.equal(pin.status, 413);
  assert.equal(c.pins.length, pins);

  assert.ok(size() <= CAP, `stored case is ${size()} bytes after the refused writes`);
  assert.equal(c.history.length, histLen);
  // The case is still readable and the attempt can still be abandoned.
  assert.equal((await api('GET', `/api/cases/${c.id}`, undefined, { user: u })).status, 200);
  await close(u, attemptId);
});

test('JSON bodies over 64 kB are refused with 413 before any handler runs', async () => {
  const u = 't.bound.body';
  const { c, attemptId } = await openCase(u);
  const post = (url, body) => fetch(`${baseUrl()}${url}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-user': u }, body });
  const big = await post(`/api/cases/${c.id}/draft`, JSON.stringify({ values: { pad: 'x'.repeat(70 * 1024) } }));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'payload_too_large');
  assert.deepEqual(c.stages[c.stage].draft, undefined);
  const ok = await post(`/api/cases/${c.id}/draft`, JSON.stringify({ values: { pad: 'x'.repeat(40 * 1024) } }));
  assert.equal(ok.status, 200, 'an honest body well under the limit is accepted');
  await close(u, attemptId);
});
