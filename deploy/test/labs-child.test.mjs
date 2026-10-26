// The labs child (deploy/labs-child.mjs) booted the way start.mjs boots it: derived per-caller tokens
// only (no raw INTERNAL_API_TOKEN), production mode, loopback port. Needs `npm run bundle` first; the
// suite is skipped when deploy/dist is absent (plain `npm test` before a build).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
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
