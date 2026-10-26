// Security patch 2: store hygiene (A7), per-caller internal tokens (A9), prototype keys and cross-user
// access (A11), request ids (A13) and the hosted Red Team frame policy (A15b).
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import crypto from 'node:crypto';
import express from 'express';
import { Store } from '../server/store';
import { createApp, loadHostedLabs } from '../server/app';
import { acceptedInternalTokens, callerInternalToken, onboardIdentity } from '../server/identity';
import { requestIdOf } from '../server/requestId';
import { auth, makeApp, ORIGIN, INTERNAL_TOKEN, fakeIdentity, sessionCookie } from './helpers';
import { fuzzProtoKeys, expectActionRefused } from './helpers/protoKeys';

const LAB = 'TR-CLOUD-001';
let n = 0;
const rid = () => `req-${Date.now()}-${n++}`;
const tmpFile = (name = 'store.json') => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trlab-sec-')), name);
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const derived = (pair: string) => Buffer.from(crypto.hkdfSync('sha256', INTERNAL_TOKEN, 'threatready-internal', pair, 32)).toString('hex');
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const savedEnv = { ...process.env };
const setEnv = (vars: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
afterEach(() => { for (const k of ['INTERNAL_TOKENS_ACCEPT', 'INTERNAL_TOKEN_LEGACY_ACCEPT', 'INTERNAL_API_TOKEN', 'INTERNAL_TOKEN_TO_ONBOARD', 'NODE_ENV']) setEnv({ [k]: savedEnv[k] }); });

describe('A7 store hygiene', () => {
  it('GET requests never write the store, not even for a learner it has never seen', async () => {
    const file = tmpFile();
    const app = makeApp(new Store(file));
    const sid = (await request(app).post(`/api/labs/${LAB}/sessions`).set(auth('Asha'))).body.session.id;
    const before = { mtime: fs.statSync(file).mtimeMs, hash: sha(file) };
    await new Promise(r => setTimeout(r, 20));
    for (const [who, url] of [['Asha', '/api/me'], ['Asha', '/api/labs'], ['Asha', `/api/labs/${LAB}`], ['Asha', `/api/labs/${LAB}/runs`], ['Asha', `/api/sessions/${sid}`], ['Asha', `/api/sessions/${sid}/cloudtrail`], ['Asha', `/api/sessions/${sid}/activity`], ['Asha', `/api/sessions/${sid}/report`], ['Bharat', '/api/me'], ['Bharat', '/api/labs'], ['Bharat', `/api/labs/${LAB}/runs`], ['Bharat', '/api/platform']]) {
      const r = await request(app).get(url).set(auth(who));
      expect(r.status, `${who} GET ${url}`).toBe(200);
    }
    expect(fs.statSync(file).mtimeMs).toBe(before.mtime);
    expect(sha(file)).toBe(before.hash);
    // The first state-changing request of the new learner is what records them.
    await request(app).post(`/api/labs/${LAB}/sessions`).set(auth('Bharat'));
    expect(sha(file)).not.toBe(before.hash);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).users).toMatchObject({ u_bharat: { name: 'Bharat' } });
  });
  it('a truncated store is kept as <file>.corrupt-<timestamp> and the lab starts empty instead of overwriting it', async () => {
    const file = tmpFile();
    const good = makeApp(new Store(file));
    await request(good).post(`/api/labs/${LAB}/sessions`).set(auth('Asha'));
    const truncated = fs.readFileSync(file, 'utf8').slice(0, 120);
    fs.writeFileSync(file, truncated);
    const errors: string[] = []; const orig = console.error; console.error = (...a: any[]) => { errors.push(a.join(' ')); };
    let store: Store; try { store = new Store(file); } finally { console.error = orig; }
    expect(fs.existsSync(file)).toBe(false);
    const kept = fs.readdirSync(path.dirname(file)).filter(f => /^store\.json\.corrupt-/.test(f));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8')).toBe(truncated);
    expect(errors.filter(e => e.includes('could not be read'))).toHaveLength(1);
    const app = makeApp(store);
    expect((await request(app).get(`/api/labs/${LAB}/runs`).set(auth('Asha'))).body).toEqual([]);
    const r = await request(app).post(`/api/labs/${LAB}/sessions`).set(auth('Asha'));
    expect(r.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).sessions[r.body.session.id]).toBeTruthy(); // a fresh, valid store
    expect(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8')).toBe(truncated); // the quarantined copy is untouched
  });
});

describe('A9 per-caller internal tokens', () => {
  const onboardToLabs = derived('onboard->labs'), onboardToAr = derived('onboard->ar');
  it('accepts the caller token from the accept list and rejects other derived tokens; the raw token only with legacy acceptance', async () => {
    setEnv({ INTERNAL_API_TOKEN: INTERNAL_TOKEN }); // "raw" is the shared INTERNAL_API_TOKEN of the environment
    const strict = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', internalTokensAccept: [onboardToLabs], internalTokenLegacyAccept: false });
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(onboardToLabs))).status).toBe(200);
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(onboardToAr))).status).toBe(401);
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(INTERNAL_TOKEN))).status).toBe(401);
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(onboardToLabs + 'x'))).status).toBe(401);
    const legacy = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', internalTokensAccept: [onboardToLabs], internalTokenLegacyAccept: true });
    expect((await request(legacy).get('/internal/v1/ai-usage').set(bearer(INTERNAL_TOKEN))).status).toBe(200);
    expect((await request(legacy).get('/internal/v1/ai-usage').set(bearer(onboardToLabs))).status).toBe(200);
  });
  it('reads the launcher environment: production rejects the raw INTERNAL_API_TOKEN, development still accepts it', async () => {
    setEnv({ INTERNAL_API_TOKEN: INTERNAL_TOKEN, INTERNAL_TOKENS_ACCEPT: `${onboardToLabs}, ${onboardToAr}`, INTERNAL_TOKEN_LEGACY_ACCEPT: undefined, NODE_ENV: 'production' });
    const prod = makeApp(new Store(null));
    expect((await request(prod).get('/internal/v1/ai-usage').set(bearer(onboardToLabs))).status).toBe(200);
    expect((await request(prod).get('/internal/v1/ai-usage').set(bearer(onboardToAr))).status).toBe(200);
    expect((await request(prod).get('/internal/v1/ai-usage').set(bearer(INTERNAL_TOKEN))).status).toBe(401);
    setEnv({ NODE_ENV: 'development' });
    const dev = makeApp(new Store(null));
    expect((await request(dev).get('/internal/v1/ai-usage').set(bearer(INTERNAL_TOKEN))).status).toBe(200);
    setEnv({ NODE_ENV: 'production', INTERNAL_TOKEN_LEGACY_ACCEPT: 'true' });
    expect((await request(makeApp(new Store(null))).get('/internal/v1/ai-usage').set(bearer(INTERNAL_TOKEN))).status).toBe(200);
  });
  it('token selection rules', () => {
    const env = { INTERNAL_API_TOKEN: 'raw', INTERNAL_TOKENS_ACCEPT: 'a,b', NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(acceptedInternalTokens('raw', { env })).toEqual(['a', 'b']);
    expect(acceptedInternalTokens('raw', { env: { ...env, INTERNAL_TOKEN_LEGACY_ACCEPT: 'true' } })).toEqual(['a', 'b', 'raw']);
    expect(acceptedInternalTokens('raw', { env: { ...env, NODE_ENV: 'test' } })).toEqual(['a', 'b', 'raw']);
    expect(acceptedInternalTokens('raw', { env: { INTERNAL_API_TOKEN: 'raw', NODE_ENV: 'production' } })).toEqual(['raw']); // no derived list configured: unchanged behaviour
    expect(acceptedInternalTokens('mine', { env })).toEqual(['a', 'b', 'mine']); // a token of its own (the launcher passes the derived one in) is always accepted
    expect(callerInternalToken('onboard', 'raw', { INTERNAL_API_TOKEN: 'raw', INTERNAL_TOKEN_TO_ONBOARD: 'labs->onboard' })).toBe('labs->onboard');
    expect(callerInternalToken('onboard', 'raw', { INTERNAL_API_TOKEN: 'raw' })).toBe('raw');
    expect(callerInternalToken('onboard', 'given', { INTERNAL_API_TOKEN: 'raw', INTERNAL_TOKEN_TO_ONBOARD: 'labs->onboard' })).toBe('given');
    expect(callerInternalToken('interview', undefined, { INTERNAL_TOKEN_TO_INTERVIEW: 'ar->interview' })).toBe('ar->interview');
  });
  it('presents INTERNAL_TOKEN_TO_ONBOARD (or an explicit callerToken) to onboard, never the raw token', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => { seen.push(String(req.headers.authorization)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user: { id: 'u_1', name: 'One', isTrial: false } })); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      setEnv({ INTERNAL_API_TOKEN: INTERNAL_TOKEN, INTERNAL_TOKEN_TO_ONBOARD: derived('labs->onboard') });
      expect((await onboardIdentity({ identityUrl: url, internalToken: INTERNAL_TOKEN })({ cookie: sessionCookie('a') })).ok).toBe(true);
      expect(seen.at(-1)).toBe(`Bearer ${derived('labs->onboard')}`);
      expect((await onboardIdentity({ identityUrl: url, internalToken: INTERNAL_TOKEN, callerToken: derived('redteam->onboard') })({ cookie: sessionCookie('b') })).ok).toBe(true);
      expect(seen.at(-1)).toBe(`Bearer ${derived('redteam->onboard')}`);
      setEnv({ INTERNAL_TOKEN_TO_ONBOARD: undefined });
      await onboardIdentity({ identityUrl: url, internalToken: INTERNAL_TOKEN })({ cookie: sessionCookie('c') });
      expect(seen.at(-1)).toBe(`Bearer ${INTERNAL_TOKEN}`); // no launcher: the raw token, as before
    } finally { server.close(); }
  });
});

describe('A11 prototype keys and cross-user access', () => {
  const setup = async () => {
    const app = makeApp(new Store(null));
    const sid = (await request(app).post(`/api/labs/${LAB}/sessions`).set(auth('Asha'))).body.session.id;
    return { app, sid };
  };
  it('every route with a string id refuses prototype names with a 4xx (never 5xx, never data)', async () => {
    const { app, sid } = await setup();
    await fuzzProtoKeys('GET /api/labs/:labId', k => request(app).get(`/api/labs/${k}`).set(auth('Asha')));
    await fuzzProtoKeys('POST /api/labs/:labId/sessions', k => request(app).post(`/api/labs/${k}/sessions`).set(auth('Asha')).send({}));
    await fuzzProtoKeys('GET /api/labs/:labId/runs', k => request(app).get(`/api/labs/${k}/runs`).set(auth('Asha')));
    for (const [m, suffix, body] of [['get', '', undefined], ['post', '/actions', { type: 'incident.acknowledge', params: {}, requestId: rid() }], ['get', '/cloudtrail', undefined], ['get', '/activity', undefined], ['get', '/report', undefined], ['post', '/reset', { confirm: 'RESET' }]] as const) {
      await fuzzProtoKeys(`${m.toUpperCase()} /api/sessions/:sid${suffix}`, k => (request(app) as any)[m](`/api/sessions/${k}${suffix}`).set(auth('Asha')).send(body));
    }
    // Ids inside action bodies: refused by the engine (ok:false), never replayed, never a 500.
    const act = (type: string, params: any, requestId = rid()) => request(app).post(`/api/sessions/${sid}/actions`).set(auth('Asha')).send({ type, params, requestId });
    await fuzzProtoKeys('finding.report findingId', k => act('finding.report', { findingId: k, resource: 'x' }), expectActionRefused);
    await fuzzProtoKeys('evidence.add eventId', k => act('evidence.add', { eventId: k }), expectActionRefused);
    await fuzzProtoKeys('iam.simulate principal', k => act('iam.simulate', { principal: k, action: 's3:GetObject', resource: '*' }), expectActionRefused);
    await fuzzProtoKeys('s3.accessTest bucket', k => act('s3.accessTest', { bucket: k, key: 'a', principal: '*', operation: 'GET' }), expectActionRefused);
    await fuzzProtoKeys('requestId', k => act('nosuch.action', {}, k), expectActionRefused);
    // The internal summary for an unknown user id (including prototype names) is empty, never an error or a replay of another user.
    await fuzzProtoKeys('GET /internal/v1/users/:userId/summary', k => request(app).get(`/internal/v1/users/${k}/summary`).set(bearer(INTERNAL_TOKEN)), (res, label) => {
      expect(res.status, label).toBe(200); expect(res.body.items, label).toEqual([]); expect(res.body.stats.find((s: any) => s.label === 'Total runs').value, label).toBe(0);
    });
  });
  it("generated second-user test: every session route answers 404 for another learner's session and changes nothing", async () => {
    const { app, sid } = await setup();
    // Every /sessions/:sid route the server defines must be in this table (guard below).
    const routes: [string, string, any?][] = [
      ['get', '/api/sessions/{sid}'],
      ['post', '/api/sessions/{sid}/actions', { type: 'incident.acknowledge', params: {}, requestId: rid() }],
      ['get', '/api/sessions/{sid}/cloudtrail'],
      ['get', '/api/sessions/{sid}/activity'],
      ['get', '/api/sessions/{sid}/report'],
      ['post', '/api/sessions/{sid}/reset', { confirm: 'RESET' }],
    ];
    const src = fs.readFileSync(path.join(import.meta.dirname, '../server/app.ts'), 'utf8');
    expect((src.match(/api\.(get|post|put|patch|delete)\('\/sessions\/:sid/g) || []).length).toBe(routes.length);
    const before = (await request(app).get(`/api/sessions/${sid}`).set(auth('Asha'))).body;
    for (const [m, p, body] of routes) {
      const r = await (request(app) as any)[m](p.replace('{sid}', sid)).set(auth('Bharat')).send(body);
      expect(r.status, `${m.toUpperCase()} ${p}`).toBe(404);
      expect(r.body.error, `${m.toUpperCase()} ${p}`).toBe('Session not found.');
    }
    const after = (await request(app).get(`/api/sessions/${sid}`).set(auth('Asha'))).body;
    expect(after.cloud.rev).toBe(before.cloud.rev); expect(after.session).toEqual(before.session); expect(after.status.incident.acknowledged).toBe(false);
    expect((await request(app).get(`/api/labs/${LAB}/runs`).set(auth('Bharat'))).body).toEqual([]);
  });
});

describe('A13 request ids', () => {
  it('echoes the gateway x-request-id in the header and in every JSON error envelope; mints one when absent or malformed', async () => {
    const app = makeApp(new Store(null));
    const withId = await request(app).get('/api/me').set('x-request-id', 'gw-abc.123');
    expect(withId.status).toBe(401); expect(withId.headers['x-request-id']).toBe('gw-abc.123'); expect(withId.body).toMatchObject({ code: 'AUTH_REQUIRED', requestId: 'gw-abc.123' });
    const sid = (await request(app).post(`/api/labs/${LAB}/sessions`).set(auth('Asha'))).body.session.id;
    for (const r of [
      await request(app).get('/api/labs/nope').set(auth('Asha')).set('x-request-id', 'gw-1'),
      await request(app).get(`/api/sessions/${sid}`).set(auth('Bharat')).set('x-request-id', 'gw-1'),
      await request(app).post(`/api/sessions/${sid}/actions`).set(auth('Asha')).set('x-request-id', 'gw-1').send({ type: 'x' }),
      await request(app).post(`/api/sessions/${sid}/actions`).set(auth('Asha')).set('x-request-id', 'gw-1').set('Content-Type', 'application/json').send('{oops'),
      await request(app).get('/internal/v1/ai-usage').set('x-request-id', 'gw-1'),
      await request(app).get('/api/nothing').set(auth('Asha')).set('x-request-id', 'gw-1'),
      await request(app).get('/api/me').set(auth('trial-x')).set('x-request-id', 'gw-1'),
      await request(app).get('/api/me').set(auth('down')).set('x-request-id', 'gw-1'),
    ]) { expect(r.status).toBeGreaterThanOrEqual(400); expect(r.body.requestId).toBe('gw-1'); expect(r.headers['x-request-id']).toBe('gw-1'); }
    const ok = await request(app).get('/api/me').set(auth('Asha')).set('x-request-id', 'gw-2');
    expect(ok.body.requestId).toBeUndefined(); expect(ok.headers['x-request-id']).toBe('gw-2');
    const none = await request(app).get('/api/me');
    expect(none.body.requestId).toMatch(/^req_[0-9a-f-]{36}$/); expect(none.headers['x-request-id']).toBe(none.body.requestId);
    const bad = await request(app).get('/api/me').set('x-request-id', 'not valid <id>');
    expect(bad.body.requestId).toMatch(/^req_/);
    expect(requestIdOf({ headers: { 'x-request-id': 'x'.repeat(129) } })).toMatch(/^req_/);
  });
  it('hosted labs see the same id and their error envelopes carry it', async () => {
    const seen: string[] = [];
    const app = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', hosted: [{ slug: 'soc', handler: (req, res) => { seen.push(String(req.headers['x-request-id'])); res.status(404).json({ error: 'not_found' }); } }] });
    const r = await request(app).get('/soc/api/cases').set(auth('Asha')).set('x-request-id', 'gw-h1');
    expect(r.status).toBe(404); expect(r.body).toEqual({ error: 'not_found', requestId: 'gw-h1' }); expect(seen).toEqual(['gw-h1']);
    const denied = await request(app).get('/soc/api/cases').set('x-request-id', 'gw-h2');
    expect(denied.status).toBe(401); expect(denied.body).toMatchObject({ error: 'auth_required', requestId: 'gw-h2' });
    const minted = await request(app).get('/soc/api/cases').set(auth('Asha'));
    expect(seen.at(-1)).toMatch(/^req_/);
  });
  it('the 500 log line carries the request id', async () => {
    const app = createApp(new Store(null), undefined, { identity: async () => { throw new Error('boom'); }, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173' });
    const lines: string[] = []; const orig = console.error; console.error = (...a: any[]) => { lines.push(a.map(String).join(' ')); };
    try { const r = await request(app).get('/api/me').set('x-request-id', 'gw-500'); expect(r.status).toBe(500); expect(r.body).toEqual({ error: 'Internal error.', requestId: 'gw-500' }); }
    finally { console.error = orig; }
    expect(lines.some(l => l.startsWith('[gw-500] GET /api/me') && l.includes('boom'))).toBe(true);
  });
});

describe('A15b hosted Red Team pages may frame the target document', () => {
  const GATEWAY_CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
  it("adds frame-src 'self' to /redteam/ pages only, and the target frame answers with its own sandboxed policy", async () => {
    // A checkout containing only a built Red Team lab (its server modules linked from this repo).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trlab-hosted-'));
    const red = path.join(root, 'red_team_lab', 'web');
    fs.mkdirSync(path.join(red, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(red, 'dist', 'index.html'), '<!doctype html><html><head></head><body>red</body></html>');
    const realServer = path.resolve(import.meta.dirname, '../../red_team_lab/web/server');
    if (!fs.existsSync(path.join(realServer, 'app.ts')) || !fs.existsSync(path.resolve(realServer, '../node_modules/express'))) return; // Red Team lab not checked out / not installed
    fs.symlinkSync(realServer, path.join(red, 'server'));
    const hosted = await loadHostedLabs(root, { catalogUrl: `${ORIGIN}/labs/`, identity: fakeIdentity, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', redTeamDataFile: path.join(root, 'red.json'), internalToken: INTERNAL_TOKEN });
    expect(hosted.map(h => h.slug)).toEqual(['redteam']);
    const labs = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', hosted: [...hosted, { slug: 'other', handler: (_req, res) => { res.type('html').send('<p>other</p>'); } }] });
    const gateway = express();
    gateway.use((_req, res, next) => { res.setHeader('Content-Security-Policy', GATEWAY_CSP); next(); });
    gateway.use('/labs', labs);
    const page = await request(gateway).get('/labs/redteam/').set({ ...auth('Asha'), Accept: 'text/html' });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe(GATEWAY_CSP.replace('frame-src ', "frame-src 'self' "));
    const frame = await request(gateway).get('/labs/redteam/target-frame.html').set({ ...auth('Asha'), Accept: 'text/html' });
    expect(frame.status).toBe(200);
    // The Red Team lab's own policy for that route (red_team_lab/web/server/frame.ts): an opaque-origin
    // sandbox where inline script (and eval, for the lab's XSS exercises) may run and nothing may connect.
    expect(frame.headers['content-security-policy']).toMatch(/^default-src 'none'; script-src 'unsafe-inline'( 'unsafe-eval')?; style-src 'unsafe-inline'; img-src data:( blob:)?; .*frame-ancestors 'self'.*; sandbox allow-scripts allow-forms$/);
    expect(frame.headers['content-security-policy']).not.toMatch(/connect-src (?!'none')/);
    expect(frame.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(frame.headers['cache-control']).toBe('no-store');
    expect(frame.text).toContain("type: 'ready'");
    const other = await request(gateway).get('/labs/other/').set({ ...auth('Asha'), Accept: 'text/html' });
    expect(other.headers['content-security-policy']).toBe(GATEWAY_CSP); // untouched elsewhere
    expect((await request(gateway).get('/labs/redteam/target-frame.html').set('Accept', 'text/html')).status).toBe(302); // still behind the platform sign-in
  });
});

describe('A9 the hosted Red Team lab under per-caller tokens (merge of patch 2 with the labs summary)', () => {
  it('folds Red Team progress into the labs summary with derived tokens only (production, no legacy); the raw token is refused on both routers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trlab-hosted-'));
    const red = path.join(root, 'red_team_lab', 'web');
    fs.mkdirSync(path.join(red, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(red, 'dist', 'index.html'), '<!doctype html><html><head></head><body>red</body></html>');
    const realServer = path.resolve(import.meta.dirname, '../../red_team_lab/web/server');
    if (!fs.existsSync(path.join(realServer, 'app.ts')) || !fs.existsSync(path.resolve(realServer, '../node_modules/express'))) return; // Red Team lab not checked out / not installed
    fs.symlinkSync(realServer, path.join(red, 'server'));
    const onboardToLabs = derived('onboard->labs');
    setEnv({ INTERNAL_API_TOKEN: INTERNAL_TOKEN, NODE_ENV: 'production', INTERNAL_TOKENS_ACCEPT: undefined, INTERNAL_TOKEN_LEGACY_ACCEPT: undefined });
    const tokens = { internalToken: onboardToLabs, internalTokensAccept: [onboardToLabs], internalTokenLegacyAccept: false };
    const hosted = await loadHostedLabs(root, { catalogUrl: `${ORIGIN}/labs/`, identity: fakeIdentity, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', redTeamDataFile: path.join(root, 'red.json'), ...tokens });
    const labs = createApp(new Store(null), undefined, { identity: fakeIdentity, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', hosted, ratePerMin: 0, rateIpPerMin: 0, ...tokens });
    const rt = await request(labs).post('/redteam/api/labs/TR-RED-001/sessions').set(auth('Derived')).send({});
    expect(rt.status).toBe(200);
    // The labs summary reaches the Red Team's internal router with its process-local token, whatever onboard sends.
    const r = await request(labs).get('/internal/v1/users/u_derived/summary').set(bearer(onboardToLabs));
    expect(r.status).toBe(200);
    expect(r.body.items.find((i: any) => i.id === rt.body.session.id)).toMatchObject({ url: `${ORIGIN}/labs/redteam/` });
    expect(r.body.stats.find((s: any) => s.label === 'Labs started').value).toBe(1);
    expect((await request(labs).get('/internal/v1/users/u_derived/summary').set(bearer(INTERNAL_TOKEN))).status).toBe(401);
    // The Red Team's own /internal/v1 (behind the platform sign-in here) accepts what the labs app accepts, never the raw token.
    expect((await request(labs).get('/redteam/internal/v1/users/u_derived/summary').set({ ...auth('Derived'), ...bearer(INTERNAL_TOKEN) })).status).toBe(401);
    expect((await request(labs).get('/redteam/internal/v1/users/u_derived/summary').set({ ...auth('Derived'), ...bearer(onboardToLabs) })).status).toBe(200);
  });
});
