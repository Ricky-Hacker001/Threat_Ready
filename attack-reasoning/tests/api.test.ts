import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../server/app';
import { createStandaloneServer } from '../server/standalone';
import type { IdentityResolver } from '../server/identity';
import { SCENARIOS } from '../server/scenarios';

const ORIGIN = 'http://localhost:5176';
const TOKEN = 'test-internal-token-test-internal-token-0123';
/** Stand-in for onboard: cookie tr.session_token=<name>; "down" = unreachable; "trial…" = no-account trial. */
const identity: IdentityResolver = async (h) => {
  const m = /(?:^|;\s*)tr\.session_token=([^;]+)/.exec(h.cookie || '');
  if (!m) return { ok: false, reason: 'signed-out', setCookies: [] };
  const name = decodeURIComponent(m[1]!);
  if (name === 'down') return { ok: false, reason: 'unavailable' };
  return { ok: true, user: { id: `u_${name}`, name, email: `${name}@example.test`, image: null, isTrial: name.startsWith('trial'), isAdmin: false }, setCookies: [] };
};
const app = createApp(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', apps: async () => [{ key: 'reasoning', title: 'Attack Reasoning', url: ORIGIN, status: 'live' }] });
const as = (name: string) => ({ Cookie: `tr.session_token=${name}`, Origin: ORIGIN });

describe('identity from onboard', () => {
  it('needs a session: none → 401, onboard down → 503, trial → account required', async () => {
    expect((await request(app).get('/api/scenarios')).status).toBe(401);
    expect((await request(app).get('/api/scenarios').set(as('down'))).status).toBe(503);
    const trial = await request(app).get('/api/scenarios').set(as('trial-1'));
    expect(trial.status).toBe(403); expect(trial.body.code).toBe('AUTH_ACCOUNT_REQUIRED');
    expect((await request(app).get('/api/me').set(as('asha'))).body).toMatchObject({ id: 'u_asha', name: 'asha' });
  });
  it('refuses state changes from another origin', async () => {
    expect((await request(app).post('/api/scenarios').set({ ...as('asha'), Origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('scenarios', () => {
  it('lists every scenario without the briefs, with levels and the published dimensions', async () => {
    const r = await request(app).get('/api/scenarios').set(as('asha'));
    expect(r.body.scenarios).toHaveLength(SCENARIOS.length);
    expect(r.body.scenarios[0].brief).toBeUndefined();
    expect(r.body.levels.map((l: any) => l.level)).toEqual(['Beginner', 'Intermediate', 'Advanced', 'Expert']);
    expect(r.body.dimensions.map((d: any) => d.code)).toEqual(['TI', 'CR', 'AB', 'CQ', 'FA']);
  });
  it('serves a dedicated page per scenario, 404 for an unknown id', async () => {
    const r = await request(app).get(`/api/scenarios/${SCENARIOS[0]!.id}`).set(as('asha'));
    expect(r.body.scenario).toMatchObject({ id: SCENARIOS[0]!.id, available: false });
    expect(r.body.scenario.brief.length).toBeGreaterThan(20);
    expect((await request(app).get('/api/scenarios/NOPE-1').set(as('asha'))).status).toBe(404);
  });
  it('uses real ATT&CK technique ids', () => {
    for (const s of SCENARIOS) for (const t of s.techniques) expect(t.id).toMatch(/^T\d{4}(\.\d{3})?$/);
  });
});

describe('internal API for onboard', () => {
  const bearer = { Authorization: `Bearer ${TOKEN}` };
  it('requires the internal token; a browser session is not enough', async () => {
    expect((await request(app).get('/internal/v1/users/u_asha/summary')).status).toBe(401);
    expect((await request(app).get('/internal/v1/users/u_asha/summary').set(as('asha'))).status).toBe(401);
  });
  it('without an engine configured: reports the catalogue and no AI usage, and /v1 answers 503', async () => {
    const s = await request(app).get('/internal/v1/users/u_asha/summary').set(bearer);
    expect(s.body).toMatchObject({ app: 'reasoning', items: [] });
    expect(s.body.aiUsage.calls).toBe(0);
    const u = await request(app).get('/internal/v1/ai-usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z').set(bearer);
    expect(u.body).toEqual({ app: 'reasoning', users: [], byModel: [], byFeature: [] });
    const v1 = await request(app).get('/v1/reasoning/domains').set(as('asha'));
    expect(v1.status).toBe(503);
    expect(v1.body.error.code).toBe('REASONING_ENGINE_UNAVAILABLE');
  });
});

/** Stand-in for the monolith (InterviewPrep API): records what it received and answers like the reasoning module. */
function startEngineStub(): Promise<{ url: string; calls: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[]; close: () => void }> {
  const calls: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        calls.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        if (req.url!.startsWith('/internal/v1/reasoning/')) {
          if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"AUTH_REQUIRED"}}');
          if (req.url!.includes('/summary')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ app: 'reasoning', stats: [{ label: 'Assessments completed', value: 2 }], items: [{ id: 'a1', title: 'Kestrel Payments', status: 'Evaluated', score: 88, at: '2026-10-19T10:00:00Z', url: 'http://localhost:5176/ar/attempts/a1' }], aiUsage: { calls: 4, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 } }));
          return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ app: 'reasoning', users: [], byModel: [], byFeature: [{ feature: 'reasoning.generate', calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }] }));
        }
        if (req.url === '/v1/reasoning/attempts/x/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: state\ndata: {"type":"state","state":"ready","version":1}\n\n');
          return void res.end();
        }
        res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json', 'x-request-id': 'req_engine' });
        res.end(JSON.stringify({ echo: { method: req.method, url: req.url, cookie: req.headers.cookie ?? null, origin: req.headers.origin ?? null, body } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() }));
  });
}

describe('gateway to the reasoning engine (the monolith)', () => {
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let gw: ReturnType<typeof createApp>;
  const setup = async () => {
    engine ??= await startEngineStub();
    gw ??= createApp(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', reasoningApi: { url: engine.url } });
    return gw;
  };
  afterAll(() => engine?.close());

  it('proxies /v1 with the session cookie, Origin and body intact, and relays the engine response and status', async () => {
    const app = await setup();
    const get = await request(app).get('/v1/reasoning/domains?x=1').set(as('asha'));
    expect(get.status).toBe(200);
    expect(get.body.echo).toMatchObject({ method: 'GET', url: '/v1/reasoning/domains?x=1', cookie: 'tr.session_token=asha' });
    expect(get.headers['x-request-id']).toBe('req_engine');
    const post = await request(app).post('/v1/reasoning/attempts').set(as('asha')).send({ domain: 'cloud_security' });
    expect(post.status).toBe(202);
    expect(post.body.echo).toMatchObject({ method: 'POST', origin: ORIGIN, body: JSON.stringify({ domain: 'cloud_security' }) });
    const last = engine.calls.at(-1)!;
    expect(last.headers['x-forwarded-host']).toBeDefined();
  });
  it('forwards the engine path, not the mount path, when this app is mounted under a prefix (/ar on the gateway)', async () => {
    await setup();
    const express = (await import('express')).default;
    const outer = express().use('/ar', gw);
    const r = await request(outer).get('/ar/v1/reasoning/domains?x=1').set(as('asha'));
    expect(r.status).toBe(200);
    expect(r.body.echo).toMatchObject({ method: 'GET', url: '/v1/reasoning/domains?x=1' });
    const n = engine.calls.length;
    expect((await request(outer).get('/ar/v1/../internal/v1/reasoning/ai-usage').set(as('asha'))).status).toBe(404);
    expect((await request(outer).get('/ar/v1/%2e%2e/internal/x').set(as('asha'))).status).toBe(404);
    expect(engine.calls.length).toBe(n);
  });
  it('refuses a state change from another origin before it reaches the engine', async () => {
    const app = await setup();
    const n = engine.calls.length;
    expect((await request(app).post('/v1/reasoning/attempts').set({ ...as('asha'), Origin: 'https://evil.example' }).send({})).status).toBe(403);
    expect(engine.calls.length).toBe(n);
  });
  it('never forwards a learner-supplied client-IP header, strips hop-by-hop and Proxy-* headers, keeps the cookie', async () => {
    const engine2 = await startEngineStub();
    const opts = { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', reasoningApi: { url: engine2.url, clientIpHeader: 'x-threatready-client-ip' } };
    // Standing alone (ar.threatready.io), a client-sent client-IP header is dropped and the connection's address is forwarded.
    const standalone = createStandaloneServer(undefined, opts);
    try {
      const r = await request(standalone).get('/v1/reasoning/domains').set({ ...as('asha'), 'x-threatready-client-ip': '203.0.113.9', 'proxy-authorization': 'Basic x', te: 'trailers', 'keep-alive': 'timeout=5' });
      expect(r.status).toBe(200);
      const h = engine2.calls.at(-1)!.headers;
      expect(h['x-threatready-client-ip']).toBeDefined();
      expect(h['x-threatready-client-ip']).not.toBe('203.0.113.9');
      expect(h['proxy-authorization']).toBeUndefined(); expect(h.te).toBeUndefined(); expect(h['keep-alive']).toBeUndefined();
      expect(h.cookie).toBe('tr.session_token=asha');
      // Behind the ThreatReady gateway, the header was stamped by the gateway: that value is forwarded, and junk never is.
      const gatewayed = createApp(undefined, opts);
      await request(gatewayed).get('/v1/reasoning/domains').set({ ...as('asha'), 'x-threatready-client-ip': '198.51.100.4' });
      expect(engine2.calls.at(-1)!.headers['x-threatready-client-ip']).toBe('198.51.100.4');
      await request(gatewayed).get('/v1/reasoning/domains').set({ ...as('asha'), 'x-threatready-client-ip': 'not-an-ip' });
      expect(engine2.calls.at(-1)!.headers['x-threatready-client-ip']).not.toBe('not-an-ip');
    } finally { engine2.close(); }
  });
  it('cannot reach the engine\'s internal API through the /v1 proxy', async () => {
    const app = await setup();
    const n = engine.calls.length;
    for (const path of ['/v1/../internal/v1/reasoning/ai-usage', '/v1/%2e%2e/internal/v1/reasoning/ai-usage', '/v1/reasoning/../../internal/v1/x', '/v1/internal/v1/reasoning/ai-usage', '/v1/%252e%252e/internal/x', '/v1/reasoning/%2Finternal%2Fx']) {
      const r = await request(app).get(path).set(as('asha'));
      expect(r.status, path).toBe(404);
    }
    expect(engine.calls.length).toBe(n);
  });
  it('streams server-sent events through unchanged', async () => {
    const app = await setup();
    const r = await request(app).get('/v1/reasoning/attempts/x/events').set(as('asha')).buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c: string) => (d += c)); res.on('end', () => cb(null, d)); });
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    expect(String(r.body)).toContain('"state":"ready"');
  });
  it("answers onboard from the engine: the reasoning summary with this app's URLs, and AI usage", async () => {
    const app = await setup();
    const bearer = { Authorization: `Bearer ${TOKEN}` };
    const s = await request(app).get('/internal/v1/users/u_asha/summary').set(bearer);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ app: 'reasoning', stats: [{ label: 'Assessments completed', value: 2 }] });
    expect(s.body.items[0].url).toBe('http://localhost:5176/ar/attempts/a1');
    const call = engine.calls.find((c) => c.url.includes('/internal/v1/reasoning/users/u_asha/summary'))!;
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).toContain(`appOrigin=${encodeURIComponent(`${ORIGIN}/ar`)}`);
    const u = await request(app).get('/internal/v1/ai-usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z').set(bearer);
    expect(u.body.byFeature[0].feature).toBe('reasoning.generate');
    expect(engine.calls.at(-1)!.url).toBe('/internal/v1/reasoning/ai-usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z');
    expect((await request(app).get('/internal/v1/users/u_asha/summary')).status).toBe(401);
  });
  it('reports the engine as unavailable instead of hanging when it is down', async () => {
    const dead = createApp(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', reasoningApi: { url: 'http://127.0.0.1:1' } });
    const r = await request(dead).get('/v1/reasoning/domains').set(as('asha'));
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('rate limiting', () => {
  it('answers 429 with Retry-After in the API error shape once a user exceeds the per-minute budget', async () => {
    const limited = createApp(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', ratePerMin: 3, rateIpPerMin: 1000 });
    for (let i = 0; i < 3; i++) expect((await request(limited).get('/api/scenarios').set(as('asha'))).status).toBe(200);
    const r = await request(limited).get('/api/scenarios').set(as('asha'));
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.body).toMatchObject({ code: 'RATE_LIMITED' }); expect(typeof r.body.error).toBe('string');
    // Another user is unaffected; the limit is per account.
    expect((await request(limited).get('/api/scenarios').set(as('bharat'))).status).toBe(200);
  });
  it('limits per client IP before sign-in is resolved, reading the gateway header', async () => {
    const limited = createApp(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', ratePerMin: 1000, rateIpPerMin: 2 });
    const ip = { 'x-threatready-client-ip': '198.51.100.7' };
    expect((await request(limited).get('/api/scenarios').set(ip)).status).toBe(401);
    expect((await request(limited).get('/api/scenarios').set(ip)).status).toBe(401);
    expect((await request(limited).get('/api/scenarios').set(ip)).status).toBe(429);
    expect((await request(limited).get('/api/scenarios').set({ 'x-threatready-client-ip': '198.51.100.8' })).status).toBe(401);
  });
});
