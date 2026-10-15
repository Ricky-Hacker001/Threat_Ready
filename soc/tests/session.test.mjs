// Identity handoff and data isolation (Build specification, section 8.1).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, api } from './helpers.mjs';

const { signToken } = await import('../server/auth.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = () => Math.floor(Date.now() / 1000);
const claims = (over = {}) => ({ sub: 'tr_10442', name: 'Priya Raman', aud: 'soc-sim', iat: now(), exp: now() + 120, ...over });

before(start);
after(stop);

async function signIn(token) {
  const r = await api('POST', '/api/session', { token });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { r, cookie };
}

test('a valid ThreatReady token signs in and sets a secure session cookie', async () => {
  const { r, cookie } = await signIn(signToken(claims()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.user, { uid: 'tr_10442', name: 'Priya Raman' });
  const raw = r.headers.get('set-cookie');
  assert.match(raw, /soc_session=/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  const me = await api('GET', '/api/me', undefined, { cookie });
  assert.deepEqual(me.body, { uid: 'tr_10442', name: 'Priya Raman' });
});

test('invalid, expired, wrong-audience and over-long tokens are refused', async () => {
  const bad = [
    [signToken(claims(), 'another-secret'), 'bad_token'],
    [signToken(claims({ iat: now() - 600, exp: now() - 400 })), 'token_expired'],
    [signToken(claims({ aud: 'other-app' })), 'bad_token'],
    [signToken(claims({ exp: now() + 3600 })), 'bad_token'],
    [signToken(claims({ sub: '' })), 'bad_token'],
    ['not.a.jwt', 'bad_token'],
    ['', 'bad_token'],
  ];
  for (const [token, code] of bad) {
    const { r } = await signIn(token);
    assert.equal(r.status, 401, `token should be refused: ${code}`);
    assert.equal(r.body.error, code);
    assert.ok(r.body.message);
  }
});

test('a tampered session cookie is ignored', async () => {
  const { cookie } = await signIn(signToken(claims({ sub: 'tr_tamper' })));
  const [name, value] = cookie.split('=');
  const [body, sig] = decodeURIComponent(value).split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'tr_victim', name: 'x', iat: now() })).toString('base64url');
  const me = await api('GET', '/api/me', undefined, { cookie: `${name}=${encodeURIComponent(`${forged}.${sig}`)}` });
  // Falls back to DEV_USER in the test environment, never to the forged id.
  assert.notEqual(me.body.uid, 'tr_victim');
  assert.ok(body);
});

test('users cannot read or change each other\'s cases or attempts', async () => {
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3' }, { user: 'iso.alice' });
  assert.equal(a.status, 201);
  const { caseId, attemptId } = a.body;
  for (const [m, u, b] of [
    ['GET', `/api/cases/${caseId}`], ['GET', `/api/cases/${caseId}/logs`], ['POST', `/api/cases/${caseId}/notes`, { text: 'x' }],
    ['POST', `/api/cases/${caseId}/submit`, { values: {} }], ['DELETE', `/api/cases/${caseId}`], ['GET', `/api/attempts/${attemptId}`],
    ['POST', `/api/attempts/${attemptId}/abandon`], ['GET', `/api/cases/${caseId}/stream`],
  ]) {
    const r = await api(m, u, b, { user: 'iso.mallory' });
    assert.equal(r.status, 404, `${m} ${u} must be 404 for another user`);
  }
  const mine = await api('GET', '/api/attempts', undefined, { user: 'iso.mallory' });
  assert.equal(mine.body.total, 0);
  const rep = await api('GET', '/api/report', undefined, { user: 'iso.mallory' });
  assert.equal(rep.body.summary.attempts, 0);
  const exp = await api('GET', '/api/me/export', undefined, { user: 'iso.mallory' });
  assert.equal(exp.body.attempts.length, 0);
  await api('POST', `/api/attempts/${attemptId}/abandon`, undefined, { user: 'iso.alice' });
});

test('every API route except health and session requires a session', async () => {
  const env = { ...process.env, SOC_SIM_NO_LISTEN: '1', DEV_USER: '', SOC_SIM_TEST: '0', NODE_ENV: 'development' };
  const code = `
    const { app } = await import('./server/index.js');
    const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
    const b = 'http://127.0.0.1:' + srv.address().port;
    const out = {};
    for (const u of ['/api/health', '/api/levels', '/api/report', '/api/attempts', '/api/me', '/api/scenarios', '/api/cases/x', '/api/demo/info', '/api/session/info']) out[u] = (await fetch(b + u)).status;
    console.log(JSON.stringify(out)); srv.close(); process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out['/api/health'], 200);
  assert.equal(out['/api/session/info'], 200);
  for (const u of ['/api/levels', '/api/report', '/api/attempts', '/api/me', '/api/scenarios', '/api/cases/x', '/api/demo/info']) assert.equal(out[u], 401, u);
});

test('production starts standalone without any secret, warns, and ignores DEV_USER', () => {
  const r = spawnSync(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, NODE_ENV: 'production', TR_SIM_SECRET: '', SIM_SESSION_SECRET: '', TR_HOME_URL: '', SOC_SIM_NO_LISTEN: '1', DAILY_WIPE: 'false', PORT: '0' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /SIM_SESSION_SECRET is not set: using a random secret/);
  const code = "const { config } = await import('./server/config.js'); console.log(JSON.stringify({ dev: config.devUser, test: config.testMode, secret: config.sessionSecret.length >= 64 }));";
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: { ...process.env, NODE_ENV: 'production', DEV_USER: 'sneaky', SOC_SIM_TEST: '1' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(p.stdout), { dev: '', test: false, secret: true });
});

test('standalone name sign-in: own session, private records, name validation', async () => {
  const bad = await api('POST', '/api/session/local', { name: ' a ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_name');
  const a = await api('POST', '/api/session/local', { name: 'Asha Rivera' });
  const b = await api('POST', '/api/session/local', { name: 'Asha Rivera' });
  assert.equal(a.status, 200);
  assert.match(a.headers.get('set-cookie'), /soc_session=.*HttpOnly.*SameSite=Lax/);
  assert.match(a.headers.get('set-cookie'), /Max-Age=86400/);
  assert.notEqual(a.body.user.uid, b.body.user.uid, 'same name must not share records');
  const ca = (a.headers.get('set-cookie') || '').split(';')[0];
  const cb = (b.headers.get('set-cookie') || '').split(';')[0];
  const me = await api('GET', '/api/me', undefined, { cookie: ca });
  assert.deepEqual(me.body, a.body.user);
  const start = await api('POST', '/api/attempts', { scenarioId: 'F1' }, { cookie: ca });
  assert.equal(start.status, 201);
  const other = await api('GET', `/api/cases/${start.body.caseId}`, undefined, { cookie: cb });
  assert.equal(other.status, 404);
  const listB = await api('GET', '/api/attempts', undefined, { cookie: cb });
  assert.equal(listB.body.total, 0);
  const html = await api('POST', '/api/session/local', { name: '<script>x</script>' });
  assert.ok(!/[<>]/.test(html.body.user.name));
});
