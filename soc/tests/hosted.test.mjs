// Mounted inside ThreatReady (threatready-lab-001/server/hosted.ts): the host's platform identity
// wins over every cookie, the SOC issues no session of its own, records say where they are kept, and
// the live stream's per-user cap, reconnects and resume points behave.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { start, stop, api, grantLevels, baseUrl, sleep, repo } from './helpers.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { app, userSummary, openStreamsOf } = await import('../server/index.js');

// The host: signs the platform user in before the SOC app runs, as hosted.ts socHandler does
// (here without stripping any cookie, so the SOC's own precedence is what is tested).
let hostServer;
let hostBase;
before(async () => {
  await start();
  const host = express();
  host.use((req, res, next) => { req.user = { uid: 'tr_platform', name: 'Platform User' }; next(); });
  host.use(app);
  await new Promise((resolve) => { hostServer = host.listen(0, resolve); });
  hostBase = `http://127.0.0.1:${hostServer.address().port}`;
});
after(async () => {
  await new Promise((resolve) => hostServer.close(resolve));
  await stop();
});

const b64u = (b) => Buffer.from(b).toString('base64url');
const forge = (uid, secret = 'dev-only-session-secret-change-me') => {
  const body = b64u(JSON.stringify({ uid, name: uid, iat: Math.floor(Date.now() / 1000), h: 8 }));
  return `${body}.${b64u(crypto.createHmac('sha256', secret).update(body).digest())}`;
};
const hosted = async (method, url, { cookie, body, headers = {} } = {}) => {
  const res = await fetch(hostBase + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
};

test('a host-provided identity wins over SOC-issued and forged session cookies, DEV_USER and the test header', async () => {
  const issued = await api('POST', '/api/session/local', { name: 'Detached' });
  assert.equal(issued.status, 200);
  const value = (issued.headers.get('set-cookie') || '').split(';')[0].split('=').slice(1).join('=');
  assert.match((await api('GET', '/api/me', undefined, { cookie: `soc_session=${value}` })).body.uid, /^local_/);
  for (const cookie of [`soc_session=${value}`, `soc_session =${value}`, `soc_session\t=${value}`, `soc_session =${encodeURIComponent(forge('tr_victim999'))}`, `soc_session=${encodeURIComponent(forge('tr_victim999'))}`]) {
    const me = await hosted('GET', '/api/me', { cookie, headers: { 'x-test-user': 'mallory' } });
    assert.equal(me.status, 200, cookie);
    assert.deepEqual(me.body, { uid: 'tr_platform', name: 'Platform User' }, cookie);
  }
});

test('mounted, the SOC refuses its own sign-in and sign-out routes and reports hosted', async () => {
  for (const [p, body] of [['/api/session/local', { name: 'Second identity' }], ['/api/session', { token: 'x.y.z' }], ['/api/session/logout', {}]]) {
    const r = await hosted('POST', p, { body });
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get('set-cookie'), null, p);
  }
  const info = await hosted('GET', '/api/session/info');
  assert.equal(info.body.signedIn, true);
  assert.equal(info.body.hosted, true);
  // Standalone, the same routes still work.
  assert.equal((await api('POST', '/api/session/local', { name: 'Standalone' })).status, 200);
  assert.equal((await api('GET', '/api/session/info')).body.hosted, false);
  // The final report says where records are kept (no daily-reset claim here: the wipe is on in this harness).
  const rep = await hosted('GET', '/api/report');
  assert.equal(rep.status, 200);
  assert.ok(rep.body.notes.reset);
});

test('a malformed cookie does not break the request', async () => {
  const me = await api('GET', '/api/me', undefined, { cookie: 'a=%E0%A4%A; soc_session=%zz', user: 't.cookie' });
  assert.equal(me.status, 200);
  assert.equal(me.body.uid, 't.cookie');
});

test('the API answers only under its own spelling (/API/... is not the API)', async () => {
  const r = await api('GET', '/API/me', undefined, { user: 't.case' });
  assert.ok(typeof r.body !== 'object' || r.body.uid === undefined, JSON.stringify(r.body).slice(0, 80));
  assert.equal((await api('GET', '/api/me', undefined, { user: 't.case' })).body.uid, 't.case');
});

test('inside ThreatReady (DAILY_WIPE=false) no daily-reset claim is made; the internal summary needs its token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-wipe-'));
  const code = `
    const { app } = await import('./server/index.js');
    const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
    const b = 'http://127.0.0.1:' + srv.address().port;
    const h = { 'x-test-user': 'w.user' };
    const out = {
      exportNote: (await (await fetch(b + '/api/me/export', { headers: h })).json()).note,
      reset: (await (await fetch(b + '/api/report', { headers: h })).json()).notes.reset,
      info: (await (await fetch(b + '/api/session/info', { headers: h })).json()).dailyWipe,
      noToken: (await fetch(b + '/internal/v1/users/w.user/summary')).status,
      badToken: (await fetch(b + '/internal/v1/users/w.user/summary', { headers: { authorization: 'Bearer ' + 'y'.repeat(40) } })).status,
      summary: await (await fetch(b + '/internal/v1/users/w.user/summary', { headers: { authorization: 'Bearer ' + 'x'.repeat(40) } })).json(),
    };
    console.log(JSON.stringify(out)); srv.close(); process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', env: { ...process.env, SOC_SIM_NO_LISTEN: '1', SOC_SIM_TEST: '1', SOC_SIM_DATA: path.join(dir, 'cases.json'), DAILY_WIPE: 'false', SOC_INTERNAL_TOKEN: 'x'.repeat(40), NODE_ENV: 'development' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.doesNotMatch(out.exportNote, /reset|00:00/i);
  assert.match(out.exportNote, /not a certification/);
  assert.equal(out.reset, null);
  assert.equal(out.info, false);
  assert.equal(out.noToken, 401);
  assert.equal(out.badToken, 401);
  assert.equal(out.summary.app, 'soc');
  assert.equal(out.summary.attempts, 0);
});

// Runs the SOC app in a child process (its config is read when it loads), mounted the way ThreatReady
// mounts it, and returns what `body` collected (with `b` the base URL).
function mounted(env, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-mounted-'));
  const code = `
    const express = (await import('express')).default;
    const { app } = await import('./server/index.js');
    const host = express();
    host.use((req, res, next) => { req.user = { uid: 'tr_m', name: 'Mounted' }; next(); });
    host.use(app);
    const srv = host.listen(0); await new Promise((r) => srv.once('listening', r));
    const b = 'http://127.0.0.1:' + srv.address().port;
    const get = async (u) => (await fetch(b + u)).json();
    const out = await (async () => { ${body} })();
    console.log(JSON.stringify(out)); srv.close(); process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', env: { ...process.env, SOC_SIM_NO_LISTEN: '1', SOC_SIM_DATA: path.join(dir, 'cases.json'), DAILY_WIPE: 'false', NODE_ENV: 'development', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('inside ThreatReady, records are said to be saved with the account only while the launcher keeps them across restarts', () => {
  const out = mounted({ TR_STATE_DURABLE: '' }, `
    const before = { info: await get('/api/session/info'), reset: (await get('/api/report')).notes.reset };
    process.env.TR_STATE_DURABLE = '1'; // the launcher sets it while its mirror saves (read per request)
    const on = { info: await get('/api/session/info'), reset: (await get('/api/report')).notes.reset };
    return { before, on };`);
  assert.equal(out.before.info.hosted, true);
  assert.equal(out.before.info.durable, false);
  assert.equal(out.before.reset, 'Practice records are kept on the ThreatReady lab server.');
  assert.equal(out.on.info.durable, true);
  assert.equal(out.on.reset, 'Practice records are saved to your ThreatReady account.');
});

test('SOC_MAX_STREAMS_PER_USER: empty or invalid keeps the default of 3; 0 is the explicit opt-out', async () => {
  const { limitFrom } = await import('../server/config.js');
  for (const v of [undefined, '', '  ', 'abc', '-1', '2.5']) assert.equal(limitFrom(v, 3), 3, String(v));
  assert.equal(limitFrom('5', 3), 5);
  assert.equal(limitFrom(' 0 ', 3), 0);
  // Wired to the stream cap: an empty value (a cleared dashboard field) keeps the cap.
  assert.equal(mounted({ SOC_MAX_STREAMS_PER_USER: '' }, `return (await get('/api/streams')).max;`), 3);
});

test('the profile summary counts attempts, best score and badges per user', async () => {
  const u = 't.summary';
  grantLevels(u, ['foundations']);
  const a = await api('POST', '/api/attempts', { scenarioId: 'F1', canonical: true }, { user: u });
  assert.equal(a.status, 201);
  const s = userSummary(u);
  assert.equal(s.attempts, 1);
  assert.equal(s.open, 1);
  assert.equal(s.badges, 1);
  assert.equal(s.complete, false);
  assert.equal(s.best, null);
  assert.deepEqual(s.items.map((i) => [i.attemptId, i.status, i.caseId]), [[a.body.attemptId, 'In progress', a.body.caseId]]);
  assert.equal(userSummary('t.nobody').attempts, 0);
  await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: u });
  assert.equal(userSummary(u).items.length, 0, 'abandoned attempts are not listed');
});

test('abandoned attempts are kept up to a cap per user', async () => {
  const u = 't.abandon';
  for (let i = 0; i < 55; i++) {
    repo.createAttempt({ schema: 'soc-attempt/1', attemptId: `att_AB${i}`, caseId: null, ticket: null, userId: u, userName: u, scenarioId: 'F1', level: 'foundations', status: 'abandoned', startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), closedAt: null, activeSeconds: 0, stages: [], answers: {}, questions: [], score: 0, passMark: 60, passed: false, skills: {}, metrics: {} });
  }
  const a = await api('POST', '/api/attempts', { scenarioId: 'F2', canonical: true }, { user: u });
  assert.equal(a.status, 201);
  await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: u });
  const left = repo.listAttempts(u).filter((x) => x.status === 'abandoned');
  assert.equal(left.length, 50);
  assert.ok(left.some((x) => x.attemptId === a.body.attemptId), 'the newest is kept');
  assert.ok(!left.some((x) => x.attemptId === 'att_AB0'), 'the oldest go');
});

test('a data file that does not parse is kept aside, not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-corrupt-'));
  const file = path.join(dir, 'cases.json');
  fs.writeFileSync(file, '{"seq": 1001, "cases": {');
  fs.writeFileSync(path.join(dir, 'attempts.json'), '[1,2]');
  const code = "const { store, flushAll } = await import('./server/store.js'); await import('./server/repo.js'); store.nextSeq(); flushAll(); console.log('ok');";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', env: { ...process.env, SOC_SIM_NO_LISTEN: '1', SOC_SIM_DATA: file } });
  assert.equal(r.status, 0, r.stderr);
  const files = fs.readdirSync(dir);
  const casesAside = files.filter((f) => f.startsWith('cases.json.corrupt-'));
  assert.equal(casesAside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, casesAside[0]), 'utf8'), '{"seq": 1001, "cases": {');
  assert.equal(files.filter((f) => f.startsWith('attempts.json.corrupt-')).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).seq, 1001, 'a fresh store was written beside it');
  assert.match(r.stderr, /kept it as .*cases\.json\.corrupt-/);
});

// ---------------------------------------------------------------------------
// Live stream: cap, per-tab slots, resume points
// ---------------------------------------------------------------------------
const opened = new Set();
async function openStream(caseId, user, query = '', headers = {}) {
  const ac = new AbortController();
  const res = await fetch(`${baseUrl()}/api/cases/${caseId}/stream${query}`, { headers: { 'x-test-user': user, ...headers }, signal: ac.signal });
  opened.add(ac);
  let reader = null;
  let text = '';
  // Reads until `until` matches (whole SSE messages: they end with a blank line) or `ms` pass.
  const read = async (until, ms = 4000) => {
    reader ??= res.body.getReader();
    const end = Date.now() + ms;
    while (!until.test(text) && Date.now() < end) {
      const r = await Promise.race([reader.read(), sleep(Math.max(1, end - Date.now())).then(() => ({ timeout: true }))]);
      if (r.timeout || r.done) break;
      text += Buffer.from(r.value).toString('utf8');
    }
    return text;
  };
  return { res, ac, read };
}
const closeStreams = async (uid) => {
  for (const ac of opened) ac.abort();
  opened.clear();
  for (let i = 0; i < 40 && openStreamsOf(uid) > 0; i++) await sleep(50);
};

test('a reconnect from the same tab replaces its own slot; a new tab past the cap is refused, with the reason readable', async () => {
  const u = 't.tabs';
  grantLevels(u);
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true }, { user: u });
  const id = a.body.caseId;
  const tabs = ['tabAAAAAAAA', 'tabBBBBBBBB', 'tabCCCCCCCC'];
  const conns = [];
  try {
  for (const t of tabs) { const c = await openStream(id, u, `?tab=${t}`); assert.equal(c.res.status, 200); conns.push(c); }
  assert.equal(openStreamsOf(u), 3);
  assert.match(await conns[0].read(/retry: \d+\n/), /retry: 3000\n/, 'the server sets the reconnect delay');
  assert.deepEqual((await api('GET', '/api/streams', undefined, { user: u })).body, { open: 3, max: 3, full: true, retryAfter: 5 });
  // Tab A reconnects while its old connection is still open on the server: accepted, the old one told why it ends.
  const again = await openStream(id, u, `?tab=${tabs[0]}`);
  assert.equal(again.res.status, 200);
  assert.match(await conns[0].read(/event: replaced\n/), /event: replaced\n/);
  assert.equal(openStreamsOf(u), 3);
  // A fourth tab is refused with a code, a human message and Retry-After.
  const fourth = await openStream(id, u, '?tab=tabDDDDDDDD');
  assert.equal(fourth.res.status, 429);
  assert.equal(fourth.res.headers.get('retry-after'), '5');
  const body = await fourth.res.json();
  assert.equal(body.error, 'too_many_streams');
  assert.match(body.message, /At most 3 live consoles .* retry/);
  await closeStreams(u);
  assert.equal(openStreamsOf(u), 0);
  assert.equal((await api('GET', '/api/streams', undefined, { user: u })).body.full, false);
  } finally {
    await closeStreams(u);
    await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: u });
  }
});

test('resume points are digits only and bounded; an empty ?after= starts live', async () => {
  const u = 't.resume';
  grantLevels(u);
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3', canonical: true, backdate: 900 }, { user: u });
  const id = a.body.caseId;
  const linesOf = (text) => (text.match(/^event: logs\ndata: (.*)\n\n/gm) || []).map((m) => JSON.parse(m.split('data: ')[1]).length);
  const first = async (query, headers) => {
    const c = await openStream(id, u, query, headers);
    try {
      assert.equal(c.res.status, 200);
      const text = await c.read(/event: logs\ndata: .*\n\n/, 2500);
      return linesOf(text)[0] ?? 0;
    } finally { await closeStreams(u); }
  };
  // Seconds of backdated history: well over the resume window.
  const total = (await api('GET', `/api/cases/${id}/logs?limit=1`, undefined, { user: u })).body.total;
  assert.ok(total > 400, `history of ${total} lines`);
  const live = await first('?after=');
  assert.ok(live < 50, `"?after=" replayed ${live} lines`);
  assert.ok(await first('?after=abc') < 50);
  assert.ok(await first('', { 'Last-Event-ID': '1e3' }) < 50, 'not a number by the strict test');
  const replay = await first('?after=0');
  assert.ok(replay <= 401, `a resume from the start replays at most the window (${replay})`);
  assert.ok(replay > 50, `a valid resume point replays the missed lines (${replay})`);
  await api('POST', `/api/attempts/${a.body.attemptId}/abandon`, undefined, { user: u });
});

after(() => { for (const ac of opened) ac.abort(); });
