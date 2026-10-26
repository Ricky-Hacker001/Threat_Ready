// The labs child (deploy/labs-child.mjs) booted the way start.mjs boots it: derived per-caller tokens
// only (no raw INTERNAL_API_TOKEN), production mode, loopback port. Needs `npm run bundle` first; the
// suite is skipped when deploy/dist is absent (plain `npm test` before a build).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { childEnv, labsChildEnv } from '../child-env.mjs';
import { internalTokenEnv } from '../launcher-lib.mjs';

const DEPLOY = path.resolve(import.meta.dirname, '..');
const bundled = fs.existsSync(path.join(DEPLOY, 'dist/labs/app.js')) && fs.existsSync(path.join(DEPLOY, 'dist/ar/app.js'));
const RAW = 'r'.repeat(64);
const T = internalTokenEnv(RAW).labs;
const OTHER = internalTokenEnv('o'.repeat(64)).labs; // same derivation, different secret

describe('labs child', { skip: bundled ? false : 'deploy/dist not built (run npm run bundle)' }, () => {
  let child;
  let port;
  let output = '';
  const get = async (p, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers, redirect: 'manual' }); return { status: r.status, text: await r.text() }; };

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-labs-child-'));
    port = 40000 + Math.floor(Math.random() * 20000);
    // Exactly the launcher's allowlist shape: no INTERNAL_API_TOKEN, legacy acceptance off.
    const env = {
      PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: 'https://tr.example',
      ONBOARD_INTERNAL_PORT: '1', INTERVIEW_INTERNAL_PORT: '1', INTERNAL_TOKEN_LEGACY_ACCEPT: 'false', CLIENT_IP_HEADER: 'x-threatready-client-ip',
      LABS_DATA_FILE: path.join(tmp, 'labs.json'), SOC_DATA_FILE: path.join(tmp, 'soc.json'), REDTEAM_DATA_FILE: path.join(tmp, 'redteam.json'),
      SOC_SESSION_SECRET: 's'.repeat(64), ...T,
    };
    child = spawn(process.execPath, ['labs-child.mjs'], { cwd: DEPLOY, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(`labs child exited early:\n${output}`);
      try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    throw new Error(`labs child did not come up:\n${output}`);
  });
  after(() => { child?.kill('SIGTERM'); });

  test('readiness probe answers 200 with a heap sample and the hosted labs', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.equal(body.ok, true);
    assert.ok(Number.isFinite(body.heapUsed) && body.heapUsed > 0);
    assert.ok(Array.isArray(body.labs));
  });

  test('/labs/internal accepts onboard→labs only: not onboard→ar, not the raw token, not another secret\'s derivation', async () => {
    const path = '/labs/internal/v1/users/u1/summary';
    assert.equal((await get(path, { authorization: `Bearer ${T.LABS_INTERNAL_TOKENS_ACCEPT}` })).status, 200);
    assert.equal((await get(path, { authorization: `Bearer ${T.AR_INTERNAL_TOKENS_ACCEPT}` })).status, 401);
    assert.equal((await get(path, { authorization: `Bearer ${RAW}` })).status, 401, 'raw INTERNAL_API_TOKEN rejected in production');
    assert.equal((await get(path, { authorization: `Bearer ${OTHER.LABS_INTERNAL_TOKENS_ACCEPT}` })).status, 401);
    assert.equal((await get(path)).status, 401);
  });

  test('/ar/internal accepts onboard→ar only', async () => {
    const path = '/ar/internal/v1/users/u1/summary';
    assert.notEqual((await get(path, { authorization: `Bearer ${T.AR_INTERNAL_TOKENS_ACCEPT}` })).status, 401, 'own token passes the token check');
    assert.equal((await get(path, { authorization: `Bearer ${T.LABS_INTERNAL_TOKENS_ACCEPT}` })).status, 401);
    assert.equal((await get(path, { authorization: `Bearer ${RAW}` })).status, 401);
  });

  test('browser APIs are mounted at /labs and /ar and fail closed while onboard is unreachable', async () => {
    for (const p of ['/labs/api/me', '/ar/api/me']) {
      const r = await get(p, { 'x-threatready-client-ip': '203.0.113.9' });
      assert.ok([401, 503].includes(r.status), `${p} → ${r.status}`);
    }
    assert.equal((await get('/nothing-here')).status, 404);
    assert.equal(child.exitCode, null, 'child still running');
  });
});

/* ---------------- Merged: the labs child the way start.mjs runs it ---------------- */

/** A free loopback port (bound once, then released). */
const freePort = () => new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
/** A cookie onboard's session format allows (labs signs out implausible cookies without asking onboard). */
const sessionCookie = (id) => `tr.session_token=${id.padEnd(32, 'x')}.${'A'.repeat(43)}=`;

describe('labs child under the launcher: env from labsChildEnv, one shared resolver, durability over IPC, SOC flushed on SIGTERM', { skip: bundled ? false : 'deploy/dist not built (run npm run bundle)' }, () => {
  const TOKENS = internalTokenEnv(RAW);
  const lookups = [];
  let onboard;
  let tmp;
  let port;
  let child;
  let output = '';
  /** The hosted labs this build has (SOC and Red Team need their client builds; render-build has all). */
  let hosted = [];
  const ORIGIN = 'https://tr.example';
  const get = async (p, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers, redirect: 'manual' }); return { status: r.status, body: await r.text() }; };
  const exited = (c, ms) => new Promise((resolve) => { if (c.exitCode !== null || c.signalCode !== null) { resolve(true); return; } const t = setTimeout(() => resolve(false), ms); c.once('exit', () => { clearTimeout(t); resolve(true); }); });

  /** Starts a labs child as supervise() does: childEnv(labsChildEnv(ctx)) + PORT/HOST + TR_STATE_DURABLE, with an IPC channel. */
  async function startChild(extra = {}) {
    const p = await freePort();
    const ctx = {
      publicUrl: ORIGIN, onboardPort: onboard.address().port, interviewPort: 1, labsPort: p, clientIpHeader: 'x-threatready-client-ip',
      internalToken: RAW, tokens: TOKENS, legacyAccept: false, socSessionSecret: 's'.repeat(64),
      labsDataFile: path.join(tmp, 'labs.json'), socDataFile: path.join(tmp, 'soc', 'cases.json'), redteamDataFile: path.join(tmp, 'redteam.json'),
    };
    const base = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' };
    const env = childEnv({ ...labsChildEnv(ctx, base), PORT: String(p), HOST: '127.0.0.1', ...extra }, base);
    assert.equal(env.INTERNAL_API_TOKEN, undefined, 'started without the raw token');
    const c = spawn(process.execPath, ['labs-child.mjs'], { cwd: DEPLOY, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    c.stdout.on('data', (d) => { output += d; });
    c.stderr.on('data', (d) => { output += d; });
    for (let i = 0; i < 80; i++) {
      if (c.exitCode !== null) throw new Error(`labs child exited early:\n${output}`);
      try { await fetch(`http://127.0.0.1:${p}/`); return { child: c, port: p }; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    throw new Error(`labs child did not come up:\n${output}`);
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-labs-launcher-'));
    // Onboard stand-in: the identity endpoint answers only the labs->onboard token.
    onboard = http.createServer((req, res) => {
      if (req.url !== '/api/internal/identity/session') { res.writeHead(404).end(); return; }
      lookups.push({ auth: req.headers.authorization, cookie: req.headers.cookie });
      if (req.headers.authorization !== `Bearer ${TOKENS.labs.LABS_INTERNAL_TOKEN_TO_ONBOARD}`) { res.writeHead(401, { 'content-type': 'application/json' }).end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ user: { id: 'u-launcher', name: 'Learner', email: 'l@example.test', isTrial: false } }));
    });
    await new Promise((r) => onboard.listen(0, '127.0.0.1', r));
    ({ child, port } = await startChild({ TR_STATE_DURABLE: '1' }));
    hosted = JSON.parse((await get('/')).body).labs ?? [];
  });
  after(async () => {
    child?.kill('SIGKILL');
    await new Promise((r) => onboard.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the labs gate and the hosted Red Team share one resolver: one onboard lookup per session, with the labs->onboard token', async (t) => {
    if (!hosted.includes('redteam')) { t.skip('Red Team not built (red_team_lab/web/dist)'); return; }
    const cookie = sessionCookie('shared');
    const before = lookups.length;
    const me = await get('/labs/api/me', { cookie, 'x-threatready-client-ip': '203.0.113.9' });
    assert.equal(me.status, 200, me.body);
    const red = await get('/labs/redteam/api/me', { cookie, 'x-threatready-client-ip': '203.0.113.9' });
    assert.equal(red.status, 200, red.body);
    assert.equal(JSON.parse(red.body).id, 'u-launcher');
    const mine = lookups.slice(before);
    assert.equal(mine.length, 1, 'the Red Team request was answered from the shared resolver');
    assert.equal(mine[0].auth, `Bearer ${TOKENS.labs.LABS_INTERNAL_TOKEN_TO_ONBOARD}`);
  });

  test('TR_STATE_DURABLE follows the launcher: starting value from the environment, changes over IPC (labs catalog and SOC session info)', async () => {
    const cookie = sessionCookie('durable');
    const where = async () => {
      const labs = JSON.parse((await get('/labs/api/labs', { cookie })).body);
      // Without a SOC build only the catalog tells; the SOC answer then mirrors it.
      const soc = hosted.includes('soc') ? JSON.parse((await get('/labs/soc/api/session/info', { cookie })).body).durable : labs.some((l) => l.progressIn === 'account');
      return { labs: [...new Set(labs.filter((l) => l.progressIn && l.progressIn !== 'browser').map((l) => l.progressIn))], soc };
    };
    assert.deepEqual(await where(), { labs: ['account'], soc: true });
    child.send({ type: 'tr-state-durable', on: false });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await where(), { labs: ['server'], soc: false });
    child.send({ type: 'something-else', on: true });
    child.send({ type: 'tr-state-durable', on: 'yes' });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await where(), { labs: ['server'], soc: false }, 'only a well-formed message turns it on');
    child.send({ type: 'tr-state-durable', on: true });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await where(), { labs: ['account'], soc: true });
  });

  test('SIGTERM: a SOC change made just before is on disk when the child has exited (debounced write flushed)', async (t) => {
    if (!hosted.includes('soc')) { t.skip('SOC not built (soc/client/dist)'); return; }
    const cookie = sessionCookie('flush');
    const headers = { cookie, origin: ORIGIN, 'content-type': 'application/json' };
    const levels = JSON.parse((await get('/labs/soc/api/levels', { cookie })).body);
    const open = new Set(levels.filter((l) => l.state !== 'locked').map((l) => l.id));
    const scenarios = JSON.parse((await get('/labs/soc/api/scenarios', { cookie })).body);
    const scn = scenarios.find((s) => s.level && open.has(s.level) && !s.hidden);
    assert.ok(scn, 'an unlocked SOC scenario');
    const r = await fetch(`http://127.0.0.1:${port}/labs/soc/api/attempts`, { method: 'POST', headers, body: JSON.stringify({ scenarioId: scn.id }) });
    const text = await r.text();
    assert.equal(r.status, 201, text);
    const { attemptId } = JSON.parse(text);
    child.kill('SIGTERM');
    assert.ok(await exited(child, 4000), 'exits within the launcher\'s wait');
    assert.equal(child.exitCode, 0);
    const files = fs.readdirSync(path.join(tmp, 'soc')).filter((f) => f.endsWith('.json'));
    const onDisk = files.map((f) => fs.readFileSync(path.join(tmp, 'soc', f), 'utf8')).join('\n');
    assert.ok(onDisk.includes(attemptId), `attempt ${attemptId} written before exit (files: ${files.join(', ')})`);
  });

  test('the child exits when the launcher goes away (IPC channel closed)', async () => {
    const second = await startChild();
    second.child.disconnect();
    assert.ok(await exited(second.child, 4000), 'stopped on disconnect');
  });
});
