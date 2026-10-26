// Security patch 2: per-caller internal tokens (A9), prototype keys (A11) and request ids (A13).
// Cross-user access (IDOR) is not testable here: this app owns no learner objects. Attempts live in the
// reasoning engine (InterviewPrep), reached only through the /v1 proxy with the learner's own cookie, and
// InterviewPrep/apps/api/test/security.e2e.test.ts generates the second-user test for every route there.
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../server/app';
import { acceptedInternalTokens, callerInternalToken, type IdentityResolver } from '../server/identity';
import { fuzzProtoKeys } from './helpers/protoKeys';

const ORIGIN = 'http://localhost:5176';
const RAW = 'test-internal-token-test-internal-token-0123';
const derived = (pair: string) => Buffer.from(crypto.hkdfSync('sha256', RAW, 'threatready-internal', pair, 32)).toString('hex');
const ONBOARD_TO_AR = derived('onboard->ar'), ONBOARD_TO_LABS = derived('onboard->labs'), AR_TO_INTERVIEW = derived('ar->interview');
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const identity: IdentityResolver = async (h) => {
  const m = /(?:^|;\s*)tr\.session_token=([^;]+)/.exec(h.cookie || '');
  if (!m) return { ok: false, reason: 'signed-out', setCookies: [] };
  const name = decodeURIComponent(m[1]!);
  if (name === 'down') return { ok: false, reason: 'unavailable' };
  return { ok: true, user: { id: `u_${name}`, name, email: null, image: null, isTrial: name.startsWith('trial'), isAdmin: false }, setCookies: [] };
};
const as = (name: string) => ({ Cookie: `tr.session_token=${name}`, Origin: ORIGIN });
const base = { identity, internalToken: RAW, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173' };

const savedEnv = { ...process.env };
const setEnv = (vars: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
afterEach(() => { for (const k of ['INTERNAL_TOKENS_ACCEPT', 'INTERNAL_TOKEN_LEGACY_ACCEPT', 'INTERNAL_API_TOKEN', 'INTERNAL_TOKEN_TO_INTERVIEW', 'NODE_ENV']) setEnv({ [k]: savedEnv[k] }); });

/** Engine stub: records the bearer token and request id it receives on its internal API. */
function startEngine(): Promise<{ url: string; calls: http.IncomingHttpHeaders[]; close: () => void }> {
  const calls: http.IncomingHttpHeaders[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      calls.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url!.includes('/summary') ? { app: 'reasoning', stats: [], items: [], aiUsage: null } : { app: 'reasoning', users: [], byModel: [], byFeature: [] }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() }));
  });
}
let engine: Awaited<ReturnType<typeof startEngine>> | undefined;
afterAll(() => engine?.close());

describe('A9 per-caller internal tokens', () => {
  it('accepts the caller token (onboard→ar), rejects other derived tokens, and the raw token only with legacy acceptance', async () => {
    setEnv({ INTERNAL_API_TOKEN: RAW });
    const strict = createApp(undefined, { ...base, internalTokensAccept: [ONBOARD_TO_AR], internalTokenLegacyAccept: false });
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(ONBOARD_TO_AR))).status).toBe(200);
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(ONBOARD_TO_LABS))).status).toBe(401);
    expect((await request(strict).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(401);
    const legacy = createApp(undefined, { ...base, internalTokensAccept: [ONBOARD_TO_AR], internalTokenLegacyAccept: true });
    expect((await request(legacy).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(200);
  });
  it('reads the launcher environment: production rejects the raw token, development accepts it', async () => {
    setEnv({ INTERNAL_API_TOKEN: RAW, INTERNAL_TOKENS_ACCEPT: ONBOARD_TO_AR, INTERNAL_TOKEN_LEGACY_ACCEPT: undefined, NODE_ENV: 'production' });
    const prod = createApp(undefined, base);
    expect((await request(prod).get('/internal/v1/ai-usage').set(bearer(ONBOARD_TO_AR))).status).toBe(200);
    expect((await request(prod).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(401);
    setEnv({ NODE_ENV: 'development' });
    expect((await request(createApp(undefined, base)).get('/internal/v1/ai-usage').set(bearer(RAW))).status).toBe(200);
    expect(acceptedInternalTokens(RAW, { env: { INTERNAL_API_TOKEN: RAW, INTERNAL_TOKENS_ACCEPT: 'a', NODE_ENV: 'production' } })).toEqual(['a']);
    expect(callerInternalToken('interview', RAW, { INTERNAL_API_TOKEN: RAW, INTERNAL_TOKEN_TO_INTERVIEW: 'x' })).toBe('x');
  });
  it('presents the ar→interview token to the engine (reasoningApi.token, else INTERNAL_TOKEN_TO_INTERVIEW), never what it accepts', async () => {
    engine ??= await startEngine();
    const explicit = createApp(undefined, { ...base, internalToken: ONBOARD_TO_AR, internalTokenLegacyAccept: false, reasoningApi: { url: engine.url, token: AR_TO_INTERVIEW } });
    expect((await request(explicit).get('/internal/v1/users/u_asha/summary').set(bearer(ONBOARD_TO_AR)).set('x-request-id', 'gw-ar-1')).status).toBe(200);
    expect(engine.calls.at(-1)!.authorization).toBe(`Bearer ${AR_TO_INTERVIEW}`);
    expect(engine.calls.at(-1)!['x-request-id']).toBe('gw-ar-1');
    setEnv({ INTERNAL_API_TOKEN: RAW, INTERNAL_TOKEN_TO_INTERVIEW: AR_TO_INTERVIEW });
    const fromEnv = createApp(undefined, { ...base, reasoningApi: { url: engine.url } });
    expect((await request(fromEnv).get('/internal/v1/ai-usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z').set(bearer(RAW))).status).toBe(200);
    expect(engine.calls.at(-1)!.authorization).toBe(`Bearer ${AR_TO_INTERVIEW}`);
    setEnv({ INTERNAL_TOKEN_TO_INTERVIEW: undefined });
    const plain = createApp(undefined, { ...base, reasoningApi: { url: engine.url } });
    await request(plain).get('/internal/v1/ai-usage').set(bearer(RAW));
    expect(engine.calls.at(-1)!.authorization).toBe(`Bearer ${RAW}`); // no launcher: the raw token, as before
  });
});

describe('A11 prototype keys', () => {
  it('scenario ids that are prototype names are 404, and the internal summary for such a user id is empty (never a 5xx)', async () => {
    const app = createApp(undefined, base);
    await fuzzProtoKeys('GET /api/scenarios/:id', k => request(app).get(`/api/scenarios/${k}`).set(as('asha')));
    await fuzzProtoKeys('GET /internal/v1/users/:userId/summary', k => request(app).get(`/internal/v1/users/${k}/summary`).set(bearer(RAW)), (res, label) => {
      expect(res.status, label).toBe(200); expect(res.body.items, label).toEqual([]);
    });
    engine ??= await startEngine();
    const withEngine = createApp(undefined, { ...base, reasoningApi: { url: engine.url } });
    await fuzzProtoKeys('GET /internal/v1/users/:userId/summary (engine)', k => request(withEngine).get(`/internal/v1/users/${k}/summary`).set(bearer(RAW)), (res, label) => { expect(res.status, label).toBeLessThan(500); });
  });
});

describe('A13 request ids', () => {
  it('echoes the gateway x-request-id in the header and in every error envelope (API shape and engine shape); mints one when absent', async () => {
    const app = createApp(undefined, base);
    for (const r of [
      await request(app).get('/api/me').set('x-request-id', 'gw-1'),
      await request(app).get('/api/scenarios/NOPE').set(as('asha')).set('x-request-id', 'gw-1'),
      await request(app).get('/api/me').set(as('trial-1')).set('x-request-id', 'gw-1'),
      await request(app).get('/api/me').set(as('down')).set('x-request-id', 'gw-1'),
      await request(app).get('/internal/v1/ai-usage').set('x-request-id', 'gw-1'),
      await request(app).post('/api/scenarios').set({ ...as('asha'), Origin: 'https://evil.example' }).set('x-request-id', 'gw-1'),
    ]) { expect(r.status).toBeGreaterThanOrEqual(400); expect(r.body.requestId).toBe('gw-1'); expect(r.headers['x-request-id']).toBe('gw-1'); }
    const v1 = await request(app).get('/v1/reasoning/domains').set(as('asha')).set('x-request-id', 'gw-2');
    expect(v1.status).toBe(503); expect(v1.body.error.request_id).toBe('gw-2'); expect(v1.body.requestId).toBe('gw-2');
    const none = await request(app).get('/api/me');
    expect(none.body.requestId).toMatch(/^req_[0-9a-f-]{36}$/); expect(none.headers['x-request-id']).toBe(none.body.requestId);
    expect((await request(app).get('/api/me').set(as('asha')).set('x-request-id', 'gw-3')).body.requestId).toBeUndefined();
  });
  it('the proxy envelopes carry it too, the engine receives it, and the engine-down log line names it', async () => {
    engine ??= await startEngine();
    const gw = createApp(undefined, { ...base, reasoningApi: { url: engine.url } });
    const blocked = await request(gw).get('/v1/internal/v1/reasoning/ai-usage').set(as('asha')).set('x-request-id', 'gw-p1');
    expect(blocked.status).toBe(404); expect(blocked.body.error.request_id).toBe('gw-p1');
    await request(gw).get('/v1/reasoning/domains').set(as('asha')).set('x-request-id', 'gw-p2');
    expect(engine.calls.at(-1)!['x-request-id']).toBe('gw-p2');
    // The proxy's own refusals (body cap, OPS-REG0) and this app's /v1 refusals carry it as well.
    const big = await request(gw).post('/v1/reasoning/attempts').set(as('asha')).set('x-request-id', 'gw-p4').set('Content-Type', 'application/json').send(JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
    expect(big.status).toBe(413); expect(big.body.error.request_id).toBe('gw-p4');
    const cross = await request(gw).post('/v1/reasoning/attempts').set({ ...as('asha'), Origin: 'https://evil.example' }).set('x-request-id', 'gw-p5').send({});
    expect(cross.status).toBe(403); expect(cross.body.error.request_id).toBe('gw-p5');
    const dead = createApp(undefined, { ...base, reasoningApi: { url: 'http://127.0.0.1:1' } });
    const lines: string[] = []; const orig = console.error; console.error = (...a: any[]) => { lines.push(a.map(String).join(' ')); };
    try {
      const r = await request(dead).get('/v1/reasoning/domains').set(as('asha')).set('x-request-id', 'gw-p3');
      expect(r.status).toBe(502); expect(r.body.error.request_id).toBe('gw-p3');
    } finally { console.error = orig; }
    expect(lines.some(l => l.startsWith('[gw-p3] GET /v1/reasoning/domains'))).toBe(true);
  });
});
