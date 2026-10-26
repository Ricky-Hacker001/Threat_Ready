// Security patch 2: store hygiene (A7), per-caller internal tokens (A9), prototype keys, cross-user access
// and regex timing (A11), request ids (A13) and the served target frame (A15b).
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { Store } from '../server/store';
import { createApp } from '../server/app';
import { devIdentity } from '../server/identity';
import { safeRegex } from '../server/terminal';
import { TARGET_FRAME_CSP } from '../server/frame';
import { makeApp, auth, ORIGIN, fakeIdentity, FINDINGS } from './helpers';
import { fuzzProtoKeys, expectActionRefused } from './helpers/protoKeys';

const LAB = 'TR-RED-001';
const RAW = 'test-internal-token-test-internal-token-0123';
let n = 0;
const rid = () => `req-${Date.now()}-${n++}`;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trred-sec-'));
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const derived = (pair: string) => Buffer.from(crypto.hkdfSync('sha256', RAW, 'threatready-internal', pair, 32)).toString('hex');
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const ONBOARD_TO_LABS = derived('onboard->labs'), ONBOARD_TO_AR = derived('onboard->ar');

const savedEnv = { ...process.env };
const setEnv = (vars: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
afterEach(() => { for (const k of ['INTERNAL_TOKENS_ACCEPT', 'INTERNAL_TOKEN_LEGACY_ACCEPT', 'INTERNAL_API_TOKEN', 'NODE_ENV']) setEnv({ [k]: savedEnv[k] }); });

const start = async (store = new Store(null)) => {
  const app = makeApp(store);
  const sid = (await request(app).post(`/api/labs/${LAB}/sessions`).set(auth('Asha'))).body.session.id as string;
  const act = (who: string, type: string, params: any = {}, requestId = rid()) => request(app).post(`/api/sessions/${sid}/actions`).set(auth(who)).send({ type, params, requestId });
  return { app, sid, act };
};

describe('A7 store hygiene', () => {
  it('GET requests never write the store, not even for a learner it has never seen', async () => {
    const file = path.join(tmpDir(), 'store.json');
    const { app, sid } = await start(new Store(file));
    const before = { mtime: fs.statSync(file).mtimeMs, hash: sha(file) };
    await new Promise(r => setTimeout(r, 20));
    for (const [who, url] of [['Asha', '/api/me'], ['Asha', '/api/catalog'], ['Asha', `/api/labs/${LAB}`], ['Asha', `/api/labs/${LAB}/runs`], ['Asha', `/api/sessions/${sid}`], ['Asha', `/api/sessions/${sid}/report`], ['Bharat', '/api/me'], ['Bharat', '/api/catalog'], ['Bharat', `/api/labs/${LAB}/runs`], ['Bharat', '/api/health']]) {
      expect((await request(app).get(url).set(auth(who))).status, `${who} GET ${url}`).toBe(200);
    }
    expect(fs.statSync(file).mtimeMs).toBe(before.mtime); expect(sha(file)).toBe(before.hash);
    await request(app).post(`/api/labs/${LAB}/sessions`).set(auth('Bharat'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).users).toMatchObject({ u_bharat: { name: 'Bharat' } });
  });
  it('a truncated store is kept as <file>.corrupt-<timestamp>; the lab starts empty and never overwrites it', async () => {
    const dir = tmpDir(); const file = path.join(dir, 'store.json');
    await start(new Store(file));
    const truncated = fs.readFileSync(file, 'utf8').slice(0, 100);
    fs.writeFileSync(file, truncated);
    const errors: string[] = []; const orig = console.error; console.error = (...a: any[]) => { errors.push(a.join(' ')); };
    let store: Store; try { store = new Store(file); } finally { console.error = orig; }
    const kept = fs.readdirSync(dir).filter(f => /^store\.json\.corrupt-/.test(f));
    expect(kept).toHaveLength(1); expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).toBe(truncated);
    expect(errors.filter(e => e.includes('could not be read'))).toHaveLength(1);
    const app = makeApp(store);
    expect((await request(app).get(`/api/labs/${LAB}/runs`).set(auth('Asha'))).body).toEqual([]);
    expect((await request(app).post(`/api/labs/${LAB}/sessions`).set(auth('Asha'))).status).toBe(200);
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
    expect(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).toBe(truncated);
  });
});

describe('A9 per-caller internal tokens', () => {
  const opts = { identity: fakeIdentity, appOrigin: ORIGIN, devLogin: false as const };
  it('accepts the hosted accept list (onboard→labs), rejects other derived tokens, and the raw token only with legacy acceptance', async () => {
    setEnv({ INTERNAL_API_TOKEN: RAW });
    const strict = createApp(new Store(null), undefined, { ...opts, internalToken: RAW, internalTokensAccept: [ONBOARD_TO_LABS], internalTokenLegacyAccept: false });
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(ONBOARD_TO_LABS))).status).toBe(200);
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(ONBOARD_TO_AR))).status).toBe(401);
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(401);
    const legacy = createApp(new Store(null), undefined, { ...opts, internalToken: RAW, internalTokensAccept: [ONBOARD_TO_LABS], internalTokenLegacyAccept: true });
    expect((await request(legacy).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(200);
    // hosted.ts passes the derived token itself as `internalToken` (the launcher's value): accepted as given.
    const hostedStyle = createApp(new Store(null), undefined, { ...opts, internalToken: ONBOARD_TO_LABS, internalTokenLegacyAccept: false });
    expect((await request(hostedStyle).get('/internal/v1/ai-usage').set(bearer(ONBOARD_TO_LABS))).status).toBe(200);
    expect((await request(hostedStyle).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(401);
  });
  it('reads the launcher environment: production rejects the raw token; without any token the router stays off', async () => {
    setEnv({ INTERNAL_API_TOKEN: RAW, INTERNAL_TOKENS_ACCEPT: ONBOARD_TO_LABS, INTERNAL_TOKEN_LEGACY_ACCEPT: undefined, NODE_ENV: 'production' });
    const prod = createApp(new Store(null), undefined, { ...opts, internalToken: RAW });
    expect((await request(prod).get('/internal/v1/ai-usage').set(bearer(ONBOARD_TO_LABS))).status).toBe(200);
    expect((await request(prod).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(401);
    setEnv({ NODE_ENV: 'development' });
    expect((await request(createApp(new Store(null), undefined, { ...opts, internalToken: RAW })).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(200);
    expect((await request(makeApp(new Store(null))).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(404); // standalone without a token: no internal API at all
  });
});

describe('A11 prototype keys, cross-user access and regex timing', () => {
  it('every route with a string id refuses prototype names (4xx, never 5xx, never data); ids in action bodies are refused by the engine', async () => {
    const { app, sid, act } = await start();
    await fuzzProtoKeys('GET /api/labs/:labId', k => request(app).get(`/api/labs/${k}`).set(auth('Asha')));
    await fuzzProtoKeys('POST /api/labs/:labId/sessions', k => request(app).post(`/api/labs/${k}/sessions`).set(auth('Asha')).send({}));
    await fuzzProtoKeys('GET /api/labs/:labId/runs', k => request(app).get(`/api/labs/${k}/runs`).set(auth('Asha')));
    for (const [m, suffix, body] of [['get', '', undefined], ['post', '/actions', { type: 'engagement.acknowledge', params: {}, requestId: rid() }], ['get', '/report', undefined], ['post', '/reset', { confirm: 'RESET' }]] as const) {
      await fuzzProtoKeys(`${m.toUpperCase()} /api/sessions/:sid${suffix}`, k => (request(app) as any)[m](`/api/sessions/${k}${suffix}`).set(auth('Asha')).send(body));
    }
    await fuzzProtoKeys('finding.report findingId', k => act('Asha', 'finding.report', { findingId: k, severity: 'High' }), expectActionRefused);
    await fuzzProtoKeys('finding.remediate findingId', k => act('Asha', 'finding.remediate', { findingId: k, optionId: 'x' }), expectActionRefused);
    await fuzzProtoKeys('finding.remediate optionId', k => act('Asha', 'finding.remediate', { findingId: FINDINGS[0].id, optionId: k }), expectActionRefused);
    await fuzzProtoKeys('finding.retest findingId', k => act('Asha', 'finding.retest', { findingId: k }), expectActionRefused);
    await fuzzProtoKeys('evidence.add historyId', k => act('Asha', 'evidence.add', { historyId: k }), expectActionRefused);
    await fuzzProtoKeys('hint.request objectiveId', k => act('Asha', 'hint.request', { objectiveId: k }), expectActionRefused);
    await fuzzProtoKeys('requestId', k => act('Asha', 'nosuch.action', {}, k), expectActionRefused);
    // Ticket ids and target paths reach the simulated application, which answers like a web app would (never a 500 here).
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      const r = await act('Asha', 'browser.navigate', { url: `/support/ticket?id=${k}` });
      expect(r.status, k).toBe(200); expect(r.body.ok, k).toBe(true); expect(r.body.result.response.status, k).toBeGreaterThanOrEqual(400);
    }
    await fuzzProtoKeys('GET /internal/v1/users/:userId/summary', k => request(createApp(new Store(null), undefined, { identity: fakeIdentity, appOrigin: ORIGIN, devLogin: false, internalToken: RAW })).get(`/internal/v1/users/${k}/summary`).set(bearer(RAW)), (res, label) => {
      expect(res.status, label).toBe(200); expect(res.body.items, label).toEqual([]);
    });
  });
  it("generated second-user test: every session route (sessions, tickets and findings live inside them) answers 404 for another learner and changes nothing", async () => {
    const { app, sid } = await start();
    const routes: [string, string, any?][] = [
      ['get', '/api/sessions/{sid}'],
      ['post', '/api/sessions/{sid}/actions', { type: 'engagement.acknowledge', params: {}, requestId: rid() }],
      ['post', '/api/sessions/{sid}/actions', { type: 'finding.report', params: { findingId: FINDINGS[0].id, severity: 'High' }, requestId: rid() }],
      ['post', '/api/sessions/{sid}/actions', { type: 'browser.navigate', params: { url: '/support/ticket?id=9001' }, requestId: rid() }],
      ['get', '/api/sessions/{sid}/report'],
      ['post', '/api/sessions/{sid}/reset', { confirm: 'RESET' }],
    ];
    const src = fs.readFileSync(path.join(import.meta.dirname, '../server/app.ts'), 'utf8');
    expect((src.match(/api\.(get|post|put|patch|delete)\('\/sessions\/:sid/g) || []).length).toBe(new Set(routes.map(r => `${r[0]} ${r[1]}`)).size);
    const before = (await request(app).get(`/api/sessions/${sid}`).set(auth('Asha'))).body;
    for (const [m, p, body] of routes) {
      const r = await (request(app) as any)[m](p.replace('{sid}', sid)).set(auth('Bharat')).send(body);
      expect(r.status, `${m.toUpperCase()} ${p}`).toBe(404); expect(r.body.code).toBe('LAB_INSTANCE_NOT_FOUND');
    }
    const after = (await request(app).get(`/api/sessions/${sid}`).set(auth('Asha'))).body;
    expect(after.view.rev).toBe(before.view.rev); expect(after.view.history.length).toBe(before.view.history.length); expect(after.session).toEqual(before.session);
    expect((await request(app).get(`/api/labs/${LAB}/runs`).set(auth('Bharat'))).body).toEqual([]);
  });
  it('regexes built from input stay linear: terminal grep/find (safeRegex) and the dev-login cookie parser', async () => {
    const subject = 'a'.repeat(5000);
    for (const p of ['(a+)+$', '(a|aa)*b', 'a?'.repeat(30) + 'a'.repeat(30), '(.*a){20}', '.*.*.*x', '\\b(\\w+\\s?)*$']) {
      const t0 = performance.now(); const re = safeRegex(p); if (re) re.test(subject);
      expect(performance.now() - t0, p).toBeLessThan(20);
    }
    for (const p of ['^admin', '[0-9]+', 'robots\\.txt', 'a.*b']) expect(safeRegex(p), p).not.toBeNull();
    // The only other RegExp built at runtime: a constant cookie-name pattern over the learner's cookie header.
    const identity = devIdentity('secret-secret-secret');
    for (const cookie of ['; '.repeat(8000), ';' + ' '.repeat(16000) + 'tr_lab_user', 'tr_lab_user=' + 'x'.repeat(16000), (' ;tr_lab_user' + ' '.repeat(50)).repeat(300)]) {
      const t0 = performance.now(); expect((await identity({ cookie })).ok).toBe(false); expect(performance.now() - t0, cookie.slice(0, 20)).toBeLessThan(20);
    }
    // And through the API: a grep that used to hang answers in milliseconds.
    const { act } = await start();
    const t0 = performance.now();
    const r = await act('Asha', 'terminal.exec', { line: `echo ${'a'.repeat(60)} | grep "(a|a)+$"` });
    expect(performance.now() - t0).toBeLessThan(100); expect(r.status).toBe(200); expect(r.body.result.output).toMatch(/^grep: invalid pattern/);
  });
});

describe('A13 request ids', () => {
  it('echoes the gateway x-request-id in the header and in every JSON error envelope; mints one when absent', async () => {
    const { app, sid } = await start();
    for (const r of [
      await request(app).get('/api/me').set('x-request-id', 'gw-1'),
      await request(app).get('/api/labs/nope').set(auth('Asha')).set('x-request-id', 'gw-1'),
      await request(app).get(`/api/sessions/${sid}`).set(auth('Bharat')).set('x-request-id', 'gw-1'),
      await request(app).post(`/api/sessions/${sid}/actions`).set(auth('Asha')).set('x-request-id', 'gw-1').send({ type: 'x' }),
      await request(app).post(`/api/sessions/${sid}/actions`).set(auth('Asha')).set('x-request-id', 'gw-1').set('Content-Type', 'application/json').send('{oops'),
      await request(app).post(`/api/sessions/${sid}/actions`).set(auth('Asha')).set('x-request-id', 'gw-1').set('Origin', 'https://evil.example').send({ type: 'engagement.acknowledge', params: {}, requestId: rid() }),
      await request(app).get('/api/nothing').set(auth('Asha')).set('x-request-id', 'gw-1'),
      await request(app).get('/api/me').set(auth('trial-x')).set('x-request-id', 'gw-1'),
    ]) { expect(r.status).toBeGreaterThanOrEqual(400); expect(r.body.requestId).toBe('gw-1'); expect(r.headers['x-request-id']).toBe('gw-1'); }
    const ok = await request(app).get('/api/me').set(auth('Asha')).set('x-request-id', 'gw-2');
    expect(ok.body.requestId).toBeUndefined(); expect(ok.headers['x-request-id']).toBe('gw-2');
    const none = await request(app).get('/api/me');
    expect(none.body.requestId).toMatch(/^req_[0-9a-f-]{36}$/); expect(none.headers['x-request-id']).toBe(none.body.requestId);
  });
  it('the 500 log line carries the request id', async () => {
    const app = createApp(new Store(null), undefined, { identity: async () => { throw new Error('boom'); }, appOrigin: ORIGIN, devLogin: false });
    const lines: string[] = []; const orig = console.error; console.error = (...a: any[]) => { lines.push(a.map(String).join(' ')); };
    try { const r = await request(app).get('/api/me').set('x-request-id', 'gw-500'); expect(r.status).toBe(500); expect(r.body).toEqual({ error: 'Internal error.', code: 'INTERNAL_ERROR', requestId: 'gw-500' }); }
    finally { console.error = orig; }
    expect(lines.some(l => l.startsWith('[gw-500] GET /api/me') && l.includes('boom'))).toBe(true);
  });
});

describe('A15b the embedded target browser document', () => {
  it('is served with its own sandboxed policy, uncached, ahead of the built client, and only hands the page body to its embedder', async () => {
    const dist = tmpDir(); fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>spa</title>');
    const app = makeApp(new Store(null), dist);
    const r = await request(app).get('/target-frame.html');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toBe(TARGET_FRAME_CSP);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.text).not.toContain('spa');
    const csp = Object.fromEntries(TARGET_FRAME_CSP.split('; ').map(d => { const [k, ...v] = d.split(' '); return [k, v.join(' ')]; }));
    expect(csp).toMatchObject({ 'default-src': "'none'", 'script-src': "'unsafe-inline'", 'style-src': "'unsafe-inline'", 'img-src': 'data:', 'form-action': "'none'", 'base-uri': "'none'", sandbox: 'allow-scripts allow-forms' });
    expect(csp.sandbox).not.toContain('allow-same-origin');
    expect(csp['script-src']).not.toMatch(/'self'|http/);
    // The handshake: ready → the embedder's {nonce, html} → document.write; messages from anyone but the parent are ignored.
    expect(r.text).toContain("parentWindow.postMessage({ __trlab: 1, type: 'ready' }, '*')");
    expect(r.text).toContain('if (e.source !== parentWindow) return;');
    expect(r.text).toContain("typeof d.html !== 'string' || typeof d.nonce !== 'string'");
    expect(r.text).toContain('document.write(d.html)');
    // The SPA still serves its pages and the client references the frame by its base-relative path.
    expect((await request(app).get('/anything')).text).toContain('spa');
    const client = fs.readFileSync(path.join(import.meta.dirname, '../client/src/tools.tsx'), 'utf8');
    expect(client).toContain('src={`${BASE}target-frame.html`}');
    expect(client).not.toContain('srcDoc=');
    expect(client).toContain("e.origin !== 'null'");
  });
});
