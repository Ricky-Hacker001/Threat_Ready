// Hardening checks: the query matcher runs in linear time, per-user caps hold, in-memory maps
// are bounded, hosted mode does not own the process, and production refuses the dev secret.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, api, engine, grantLevels, sleep, baseUrl } from './helpers.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseQuery, matches, globMatch } = await import('../server/engine/query.js');
const { __beats } = await import('../server/attempts.js');

before(start);
after(stop);

test('wildcard queries match in linear time (no regex): 2000 events in under 100 ms', () => {
  const events = [];
  for (let i = 0; i < 2000; i++) {
    const cl = `powershell.exe -nop -w hidden -enc ${'A'.repeat(60)}${i} -ExecutionPolicy Bypass -File C:\\Users\\svc\\AppData\\Local\\Temp\\${i}.ps1`;
    events.push({ _lc: cl.toLowerCase(), fields: { command_line: cl, event_id: 4688 } });
  }
  const terms = parseQuery('command_line:********#');
  const t0 = performance.now();
  const hits = events.filter((e) => matches(terms, e)).length;
  const ms = performance.now() - t0;
  assert.equal(hits, 0);
  assert.ok(ms < 100, `took ${ms.toFixed(1)} ms`);
  // Same answers as the former `^a.*b$` regex.
  const legacy = (p, v) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(v);
  for (const [p, v] of [['telemetry.*', 'telemetry.aerofreight.local'], ['telemetry.*', 'xtelemetry.a'], ['*.ps1', 'a.ps1'], ['*.ps1', 'a.ps1 '], ['a*b*c', 'abc'], ['a*b*c', 'a-b-c-'], ['*', ''], ['a.b', 'axb'], ['*x*', 'line one\nx'], ['', '']]) {
    assert.equal(globMatch(p, v), legacy(p, v), `${p} vs ${JSON.stringify(v)}`);
  }
  assert.equal(matches(parseQuery('event_id:4688'), events[0]), true);
  assert.equal(matches(parseQuery('constructor:*'), events[0]), false, 'prototype properties are not fields');
});

test('live log queries are capped at 300 characters like their recorded copies', async () => {
  grantLevels('t.cap');
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user: 't.cap' });
  assert.equal(a.status, 201);
  const long = await api('GET', `/api/cases/${a.body.caseId}/logs?q=${encodeURIComponent('command_line:' + '*'.repeat(400))}`, undefined, { user: 't.cap' });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'query_too_long');
  const t0 = performance.now();
  const ok = await api('GET', `/api/cases/${a.body.caseId}/logs?q=${encodeURIComponent('command_line:' + '*'.repeat(280) + '#')}`, undefined, { user: 't.cap' });
  assert.equal(ok.status, 200);
  assert.ok(performance.now() - t0 < 1000);
  await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: 't.cap' });
});

test('a user holds at most three open attempts; heartbeats are forgotten when an attempt ends', async () => {
  const u = 't.caps';
  grantLevels(u);
  const ids = [];
  for (const sid of ['F1', 'F2', 'F3']) {
    const r = await api('POST', '/api/attempts', { scenarioId: sid, canonical: true }, { user: u });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.push(r.body);
  }
  const fourth = await api('POST', '/api/attempts', { scenarioId: 'F4', canonical: true }, { user: u });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error, 'too_many_open');
  assert.equal((await api('POST', `/api/cases/${ids[0].caseId}/heartbeat`, { visible: true }, { user: u })).status, 204);
  assert.ok(__beats.has(ids[0].attemptId));
  await api('POST', `/api/attempts/${ids[0].attemptId}/abandon`, undefined, { user: u });
  assert.ok(!__beats.has(ids[0].attemptId), 'abandoning an attempt drops its heartbeat entry');
  assert.equal((await api('POST', '/api/attempts', { scenarioId: 'F4', canonical: true }, { user: u })).status, 201);
  for (const a of (await api('GET', '/api/attempts', undefined, { user: u })).body.attempts) if (a.status === 'open') await api('POST', `/api/attempts/${a.attemptId}/abandon`, undefined, { user: u });
});

test('a user keeps one active demo and at most three unfinished ones', async () => {
  const u = 't.demo';
  const a = await api('POST', '/api/demo/start', { analyst: 'd' }, { user: u });
  const b = await api('POST', '/api/demo/start', { analyst: 'd' }, { user: u });
  assert.equal(a.status, 201);
  assert.equal(a.body.id, b.body.id, 'a second start continues the active demo');
  // Paused or exited demos are not resumed by a bare start, but they are bounded.
  const made = [a.body.id];
  for (let i = 0; i < 4; i++) {
    assert.equal((await api('POST', `/api/demo/${made[made.length - 1]}/status`, { status: 'exited' }, { user: u })).status, 200);
    const n = await api('POST', '/api/demo/start', { analyst: 'd' }, { user: u });
    assert.equal(n.status, 201);
    assert.notEqual(n.body.id, made[made.length - 1]);
    made.push(n.body.id);
  }
  const exists = (id) => { try { engine.getCase(id); return true; } catch { return false; } };
  const alive = made.filter(exists);
  assert.ok(alive.length <= 3, `${alive.length} demo cases alive`);
  for (const id of alive) await api('DELETE', `/api/cases/${id}`, undefined, { user: u });
});

test('at most three live consoles per user; a closed case ends its stream', async () => {
  const u = 't.sse';
  grantLevels(u);
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user: u });
  const { openStreamsOf } = await import('../server/index.js');
  const base = baseUrl();
  const open = async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/cases/${a.body.caseId}/stream`, { headers: { 'x-test-user': u }, signal: ac.signal });
    return { res, ac };
  };
  const conns = [];
  for (let i = 0; i < 3; i++) { const c = await open(); assert.equal(c.res.status, 200); conns.push(c); }
  const fourth = await open();
  assert.equal(fourth.res.status, 429);
  assert.equal(fourth.res.headers.get('retry-after'), '5');
  assert.equal((await fourth.res.json()).error, 'too_many_streams');
  assert.equal(openStreamsOf(u), 3);
  for (const c of conns) c.ac.abort();
  for (let i = 0; i < 20 && openStreamsOf(u) > 0; i++) await sleep(50);
  assert.equal(openStreamsOf(u), 0, 'closed connections are released');
  // A removed (abandoned) case ends the stream from the server side.
  const last = await open();
  assert.equal(last.res.status, 200);
  await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: u });
  const text = await last.res.text(); // resolves only when the server ends the response
  assert.match(text, /event: closed/);
  assert.equal(openStreamsOf(u), 0);
});

test('idle and closed streams are swept from memory', async () => {
  const u = 't.sweep';
  grantLevels(u);
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user: u });
  const before = engine.liveStreams();
  assert.ok(before >= 1);
  assert.equal(engine.sweepStreams(Date.now()), 0, 'fresh open streams stay');
  const dropped = engine.sweepStreams(Date.now() + 3 * 3600 * 1000);
  assert.ok(dropped >= 1, 'idle streams go');
  // The stream is rebuilt on demand, from the stored seed.
  assert.equal((await api('GET', `/api/cases/${a.body.caseId}/logs?limit=5`, undefined, { user: u })).status, 200);
  await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: u });
});

test('hosted mode registers no SIGTERM handler; production refuses the development session secret', () => {
  const probe = "await import('./server/store.js'); console.log(JSON.stringify({ term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') }));";
  const hosted = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, env: { ...process.env, SOC_SIM_NO_LISTEN: '1', SOC_SIM_DATA: path.join(root, 'data', 'probe-cases.json') }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(hosted.stdout), { term: 0, int: 0 }, hosted.stderr);
  const standalone = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, env: { ...process.env, SOC_SIM_NO_LISTEN: '', SOC_SIM_DATA: path.join(root, 'data', 'probe-cases.json') }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(standalone.stdout), { term: 1, int: 1 }, standalone.stderr);

  const cfg = "const { config } = await import('./server/config.js'); console.log(JSON.stringify({ secret: config.sessionSecret, generated: config.sessionSecretGenerated }));";
  const bad = spawnSync(process.execPath, ['--input-type=module', '-e', cfg], { cwd: root, env: { ...process.env, NODE_ENV: 'production', SIM_SESSION_SECRET: 'dev-only-session-secret-change-me' }, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /development default/);
  const preferred = spawnSync(process.execPath, ['--input-type=module', '-e', cfg], { cwd: root, env: { ...process.env, NODE_ENV: 'production', SOC_SESSION_SECRET: 'launcher-secret-0123456789abcdef', SIM_SESSION_SECRET: 'legacy' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(preferred.stdout), { secret: 'launcher-secret-0123456789abcdef', generated: false }, preferred.stderr);
  const legacy = spawnSync(process.execPath, ['--input-type=module', '-e', cfg], { cwd: root, env: { ...process.env, NODE_ENV: 'production', SOC_SESSION_SECRET: '', SIM_SESSION_SECRET: 'legacy-secret' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(legacy.stdout), { secret: 'legacy-secret', generated: false }, legacy.stderr);
});

test('a body the JSON parser refuses gets its own 4xx, not a 500 with a stack in the log', async () => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => { logged.push(a); };
  try {
    const post = (body, headers = {}) => fetch(`${baseUrl()}/api/attempts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': 't.body', ...headers }, body });
    const big = await post(JSON.stringify({ scenarioId: 'F1', pad: 'x'.repeat(300 * 1024) }));
    assert.equal(big.status, 413);
    // Every error envelope also carries the request id (security patch 2, A13).
    const { requestId, ...bigBody } = await big.json();
    assert.deepEqual(bigBody, { error: 'payload_too_large', message: 'The request is too large.' });
    assert.match(requestId, /^req_/);
    const enc = await post('{}', { 'Content-Encoding': 'compress' });
    assert.equal(enc.status, 415);
    assert.equal((await enc.json()).error, 'unsupported_media_type');
    const charset = await post('{}', { 'Content-Type': 'application/json; charset=x-unknown' });
    assert.equal(charset.status, 415);
    const bad = await post('{bad');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).message, 'Malformed JSON.');
    const param = await fetch(`${baseUrl()}/api/cases/%E0%A4%A`, { headers: { 'x-test-user': 't.body' } });
    assert.equal(param.status, 400);
    assert.equal((await param.json()).error, 'bad_request');
  } finally { console.error = orig; }
  assert.deepEqual(logged, [], 'nothing is logged as an internal error');
});
