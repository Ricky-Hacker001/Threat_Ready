// Security patch 2: store hygiene (A7), prototype keys, cross-user access and regex timing (A11),
// request ids (A13). The SOC app checks no onboard identity itself (ThreatReady injects the user in
// threatready-lab-001/server/hosted.ts), so the per-caller token item (A9) does not apply here.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, stop, api, repo, grantLevels, sleep, baseUrl, engine } from './helpers.mjs';
import { fuzzProtoKeys, PROTO_KEYS } from './helpers/protoKeys.mjs';

const { JsonFile, quarantine, DATA_DIR } = await import('../server/store.js');
const { AliasMap } = await import('../server/engine/alias.js');

before(start);
after(stop);

const raw = (method, url, { user, headers = {}, body } = {}) => fetch(baseUrl() + url, {
  method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => { const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { status: res.status, body: json, headers: res.headers }; });

test('A7: a truncated JSON store is kept as <file>.corrupt-<timestamp>, the app starts empty and never overwrites it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-store-'));
  const file = path.join(dir, 'cases.json');
  const truncated = '{"seq":1004,"cases":{"c1":{"id":"c1","stat';
  fs.writeFileSync(file, truncated);
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
  let jf; try { jf = new JsonFile(file, () => ({ seq: 1000, cases: {} })); } finally { console.error = orig; }
  assert.deepEqual(jf.db, { seq: 1000, cases: {} });
  assert.equal(fs.existsSync(file), false);
  const kept = fs.readdirSync(dir).filter((f) => /^cases\.json\.corrupt-/.test(f));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), truncated);
  assert.equal(errors.filter((e) => e.includes('Kept as')).length, 1);
  jf.db.cases.c2 = { id: 'c2' }; jf.flushNow();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).cases, { c2: { id: 'c2' } });
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), truncated);
  // A JSON array or scalar is not a store either.
  fs.writeFileSync(file, '[1,2]');
  console.error = () => {}; try { new JsonFile(file, () => ({ seq: 1, cases: {} })); } finally { console.error = orig; }
  assert.equal(fs.readdirSync(dir).filter((f) => /^cases\.json\.corrupt-/.test(f)).length, 2);
  assert.equal(quarantine(path.join(dir, 'missing.json')), null);
});

test('A7: GET routes never write any store file', async () => {
  grantLevels('t.p2get');
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user: 't.p2get' });
  assert.equal(a.status, 201);
  repo.flush();
  const files = ['cases.json', 'attempts.json', 'awards.json'].map((f) => path.join(DATA_DIR, f)).filter((f) => fs.existsSync(f));
  assert.ok(files.length >= 2);
  await sleep(20);
  const before = files.map((f) => [f, fs.statSync(f).mtimeMs, fs.readFileSync(f, 'utf8')]);
  for (const [who, url] of [['t.p2get', '/api/me'], ['t.p2get', '/api/levels'], ['t.p2get', '/api/levels/foundations'], ['t.p2get', '/api/attempts'], ['t.p2get', `/api/attempts/${a.body.attemptId}`], ['t.p2get', '/api/awards'], ['t.p2get', '/api/report'], ['t.p2get', '/api/scenarios'], ['t.p2get', '/api/cases'], ['t.p2get', '/api/session/info'], ['t.p2get', '/api/demo/info'], ['t.p2never', '/api/levels'], ['t.p2never', '/api/attempts'], ['t.p2never', '/api/report'], ['t.p2never', '/api/cases']]) {
    const r = await api('GET', url, undefined, { user: who });
    assert.equal(r.status, 200, `${who} GET ${url}`);
  }
  await sleep(400); // longer than the debounced writer
  for (const [f, mtime, text] of before) { assert.equal(fs.statSync(f).mtimeMs, mtime, `${path.basename(f)} was rewritten`); assert.equal(fs.readFileSync(f, 'utf8'), text); }
  await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: 't.p2get' });
});

test('A11: every route with a string id refuses prototype names (4xx, never 5xx, never data)', async () => {
  const u = 't.p2proto';
  grantLevels(u);
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user: u });
  assert.equal(a.status, 201);
  const cid = a.body.caseId;
  const send = (m, url, body) => api(m, url, body, { user: u });
  // Case id in the path, every case route.
  for (const [m, suffix, body] of [
    ['GET', ''], ['DELETE', ''], ['POST', '/ack'], ['GET', '/logs'], ['GET', '/events?ids=x'], ['POST', '/pins', { eventId: 'x' }], ['DELETE', '/pins/x'],
    ['POST', '/iocs', { value: '1.2.3.4', type: 'ip' }], ['POST', '/iocs/remove', { value: 'x' }], ['POST', '/notes', { text: 'x' }], ['PUT', '/draft', { values: {} }],
    ['POST', '/tools/whois', { input: 'x' }], ['POST', '/actions', { kind: 'x' }], ['POST', '/submit', { values: {} }], ['POST', '/hint', { stageId: 'x', fieldId: 'y' }],
    ['POST', '/heartbeat', { visible: true }], ['GET', '/export'], ['GET', '/stream'],
  ]) await fuzzProtoKeys(`${m} /api/cases/:id${suffix}`, (k) => send(m, `/api/cases/${k}${suffix}`, body));
  // Other ids inside case routes.
  await fuzzProtoKeys('POST /api/cases/:id/tools/:tool', (k) => send('POST', `/api/cases/${cid}/tools/${k}`, { input: 'x' }));
  await fuzzProtoKeys('POST /api/cases/:id/pins eventId', (k) => send('POST', `/api/cases/${cid}/pins`, { eventId: k }));
  await fuzzProtoKeys('POST /api/cases/:id/hint stageId', (k) => send('POST', `/api/cases/${cid}/hint`, { stageId: k, fieldId: k }));
  await fuzzProtoKeys('GET /api/cases/:id/events ids', (k) => send('GET', `/api/cases/${cid}/events?ids=${k}`), (res, label) => { assert.equal(res.status, 200, label); assert.deepEqual(res.body.events, [], label); });
  await fuzzProtoKeys('DELETE /api/cases/:id/pins/:eventId', (k) => send('DELETE', `/api/cases/${cid}/pins/${k}`), (res, label) => { assert.ok(res.status < 500, label); assert.equal((res.body.pins || []).length, 0, label); });
  // Attempts, levels, demo sessions.
  await fuzzProtoKeys('GET /api/attempts/:id', (k) => send('GET', `/api/attempts/${k}`));
  await fuzzProtoKeys('POST /api/attempts/:id/abandon', (k) => send('POST', `/api/attempts/${k}/abandon`));
  await fuzzProtoKeys('GET /api/levels/:level', (k) => send('GET', `/api/levels/${k}`));
  await fuzzProtoKeys('POST /api/attempts scenarioId', (k) => send('POST', '/api/attempts', { scenarioId: k }));
  for (const [m, suffix, body] of [['GET', ''], ['POST', '/check', { beat: 'x', data: {} }], ['POST', '/goto', { beat: 'x' }], ['POST', '/skip', { beat: 'x' }], ['POST', '/status', { status: 'paused' }], ['POST', '/reset', {}], ['GET', '/summary']]) {
    await fuzzProtoKeys(`${m} /api/demo/:id${suffix}`, (k) => send(m, `/api/demo/${k}${suffix}`, body));
  }
  // The user id itself (test harness header) never resolves to another user's records.
  for (const k of PROTO_KEYS) { const r = await api('GET', '/api/attempts', undefined, { user: k }); assert.equal(r.status, 200); assert.equal(r.body.total, 0, k); }
  await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: u });
});

test("A11: generated second-user test: every case, attempt, stream and demo route answers 404 for another user and changes nothing", async () => {
  const owner = 't.p2owner', other = 't.p2other';
  grantLevels(owner); grantLevels(other);
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user: owner });
  assert.equal(a.status, 201);
  const { caseId, attemptId } = a.body;
  const demo = await api('POST', '/api/demo/start', { analyst: 'owner' }, { user: owner });
  assert.equal(demo.status, 201, JSON.stringify(demo.body));
  const demoId = demo.body.id;
  const beforeCase = await api('GET', `/api/cases/${caseId}`, undefined, { user: owner });
  const routes = [
    ['GET', `/api/cases/${caseId}`], ['DELETE', `/api/cases/${caseId}`], ['POST', `/api/cases/${caseId}/ack`], ['GET', `/api/cases/${caseId}/logs`], ['GET', `/api/cases/${caseId}/events?ids=x`],
    ['POST', `/api/cases/${caseId}/pins`, { eventId: 'x' }], ['DELETE', `/api/cases/${caseId}/pins/x`], ['POST', `/api/cases/${caseId}/iocs`, { value: '1.2.3.4', type: 'ip' }], ['POST', `/api/cases/${caseId}/iocs/remove`, { value: 'x' }],
    ['POST', `/api/cases/${caseId}/notes`, { text: 'x' }], ['PUT', `/api/cases/${caseId}/draft`, { values: {} }], ['POST', `/api/cases/${caseId}/tools/whois`, { input: 'x' }], ['POST', `/api/cases/${caseId}/actions`, { kind: 'x' }],
    ['POST', `/api/cases/${caseId}/submit`, { values: {} }], ['POST', `/api/cases/${caseId}/hint`, { stageId: 'x', fieldId: 'y' }], ['POST', `/api/cases/${caseId}/heartbeat`, { visible: true }], ['GET', `/api/cases/${caseId}/export`], ['GET', `/api/cases/${caseId}/stream`],
    ['GET', `/api/attempts/${attemptId}`], ['POST', `/api/attempts/${attemptId}/abandon`],
    ['GET', `/api/demo/${demoId}`], ['POST', `/api/demo/${demoId}/check`, { beat: 'x', data: {} }], ['POST', `/api/demo/${demoId}/goto`, { beat: 'x' }], ['POST', `/api/demo/${demoId}/skip`, { beat: 'x' }], ['POST', `/api/demo/${demoId}/status`, { status: 'paused' }], ['POST', `/api/demo/${demoId}/reset`, {}], ['GET', `/api/demo/${demoId}/summary`],
  ];
  // Every route with an :id the server defines is in the table (guard: counts routes in index.js and demo/routes.js).
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../server/demo/routes.js', import.meta.url), 'utf8');
  const defined = (src.match(/\.(get|post|put|delete)\('(\/api)?(\/cases\/:id|\/attempts\/:id|\/:id)[^']*'/g) || []).length;
  assert.equal(defined, routes.length, 'add every new id route to this table');
  for (const [m, u, b] of routes) {
    const r = await api(m, u, b, { user: other });
    assert.equal(r.status, 404, `${m} ${u} must be 404 for another user (got ${r.status} ${JSON.stringify(r.body).slice(0, 120)})`);
  }
  const afterCase = await api('GET', `/api/cases/${caseId}`, undefined, { user: owner });
  assert.equal(afterCase.status, 200);
  assert.equal(afterCase.body.status, beforeCase.body.status);
  assert.deepEqual(afterCase.body.pins, beforeCase.body.pins); assert.deepEqual(afterCase.body.iocs, beforeCase.body.iocs); assert.deepEqual(afterCase.body.notes, beforeCase.body.notes);
  assert.equal((await api('GET', `/api/attempts/${attemptId}`, undefined, { user: owner })).body.status, 'open');
  assert.equal((await api('GET', '/api/attempts', undefined, { user: other })).body.total, 0);
  await api('POST', `/api/attempts/${attemptId}/abandon`, undefined, { user: owner });
});

test('A11: the alias renamer (the only regex built at runtime over learner text) stays linear on adversarial 300-character input', () => {
  const pairs = Array.from({ length: 40 }, (_, i) => [`ws-finance-${String(i).padStart(2, '0')}`, `host-${i}-alias`]);
  const m = new AliasMap(pairs, Array.from({ length: 64 }, (_, i) => i % 16));
  for (const s of ['ws-finance-'.repeat(27), 'ws-finance-0'.repeat(25), '-'.repeat(300), 'a'.repeat(300), ('ws-finance-00' + '-').repeat(21), 'ws-finance-00.'.repeat(21), 'ws-finance-0'.repeat(24) + '0']) {
    const t0 = performance.now(); m.in(s); m.out(s); assert.ok(performance.now() - t0 < 20, `${s.slice(0, 24)}… took too long`);
  }
  // And the query path end to end (capped at 300 characters by the route, linear glob matcher underneath).
  const query = engine.aliasFor({ variant: null });
  assert.ok(query);
});

test('A13: the gateway x-request-id is echoed in the header and in every JSON error envelope; one is minted when absent', async () => {
  const u = 't.p2rid';
  grantLevels(u);
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user: u });
  const checks = [
    raw('GET', '/api/cases/nope', { user: u, headers: { 'x-request-id': 'gw-s1' } }),
    raw('POST', '/api/attempts', { user: u, body: { scenarioId: 'NOPE' }, headers: { 'x-request-id': 'gw-s1' } }),
    raw('POST', '/api/attempts', { user: u, body: { scenarioId: 'F3' }, headers: { 'x-request-id': 'gw-s1' } }),
    raw('GET', `/api/cases/${a.body.caseId}`, { user: 't.p2other2', headers: { 'x-request-id': 'gw-s1' } }),
    raw('GET', '/api/nothing', { user: u, headers: { 'x-request-id': 'gw-s1' } }),
    raw('GET', `/api/cases/${a.body.caseId}/logs?q=${'*'.repeat(400)}`, { user: u, headers: { 'x-request-id': 'gw-s1' } }),
    fetch(baseUrl() + '/api/cases', { method: 'POST', headers: { 'x-test-user': u, 'content-type': 'application/json', 'x-request-id': 'gw-s1' }, body: '{oops' }).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers })),
  ];
  for (const r of await Promise.all(checks)) {
    assert.ok(r.status >= 400, String(r.status));
    assert.equal(r.body.requestId, 'gw-s1', JSON.stringify(r.body));
    assert.equal(r.headers.get('x-request-id'), 'gw-s1');
  }
  const ok = await raw('GET', '/api/levels', { user: u, headers: { 'x-request-id': 'gw-s2' } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('x-request-id'), 'gw-s2'); assert.equal(JSON.stringify(ok.body).includes('requestId'), false);
  const none = await raw('GET', '/api/cases/nope', { user: u });
  assert.match(none.body.requestId, /^req_[0-9a-f-]{36}$/); assert.equal(none.headers.get('x-request-id'), none.body.requestId);
  const bad = await raw('GET', '/api/cases/nope', { user: u, headers: { 'x-request-id': 'bad id <x>' } });
  assert.match(bad.body.requestId, /^req_/);
  await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: u });
});

test('A15a: every client API URL outside api.js goes through apiUrl() (base-relative under /labs/soc/), in the sources and in the built bundle', () => {
  const srcDir = new URL('../client/src/', import.meta.url);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(jsx?|tsx?)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const offenders = [];
  for (const file of walk(fileURLToPathSafe(srcDir))) {
    if (file.endsWith(`${path.sep}api.js`)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/.{0,12}["'`]\/api\//g)) if (!/apiUrl\(\s*["'`]\/api\/$/.test(m[0])) offenders.push(`${path.relative(process.cwd(), file)}: ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
  const dist = fileURLToPathSafe(new URL('../client/dist/assets/', import.meta.url));
  if (fs.existsSync(dist)) {
    const bundle = fs.readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dist, f), 'utf8')).join('\n');
    assert.equal(/(EventSource\(|href:|location\.href=)["'`]\/api/.test(bundle), false, 'the bundle builds an API URL from an absolute /api path');
  }
});
function fileURLToPathSafe(u) { return decodeURIComponent(u.pathname); }
