import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../server/app';
import { onboardIdentity, type IdentityResolver } from '../server/identity';
import { createStandaloneServer, SECURITY_HEADERS } from '../server/standalone';
import { ApiError } from '../client/src/api';
import { FAILURE_MESSAGE, messageFor, reasoning, startQuestion, uuid } from '../client/src/reasoning/api';

/** Attack Reasoning gateway and client hardening (audit 2026-10-23: AR-REG5, UX-REG0, UX-REG3, IP-REG1, OPS-REG0 incl. the body cap, TR-49, TR-60, UX-REG9). */

const ORIGIN = 'http://localhost:5176';
const TOKEN = 'test-internal-token-test-internal-token-0123';
const listen = (server: http.Server) => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

/** Stand-in for onboard's identity endpoint: tokens starting "user-" are signed in; it counts lookups and can be slowed down. */
function onboardStub() {
  const state = { calls: 0, delayMs: 0, active: 0, maxActive: 0, reset() { this.active = 0; this.maxActive = 0; } };
  const server = http.createServer((req, res) => {
    state.calls++;
    state.active++; state.maxActive = Math.max(state.maxActive, state.active);
    const token = /tr\.session_token=([^.;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    setTimeout(() => {
      state.active--;
      if (req.headers.authorization !== `Bearer ${TOKEN}` || !token.startsWith('user-')) return void res.writeHead(401).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ user: { id: token, name: token, email: null, image: null, isTrial: false, isAdmin: false } }));
    }, state.delayMs);
  });
  return { state, server };
}
/** A plausible Better Auth session cookie value (token.signature). */
const cookie = (token: string) => `tr.session_token=${token}.${'s'.repeat(43)}%3D`;

/** Stand-in for the reasoning engine: records each request it parses (one entry per request on the wire). */
function engineStub() {
  const calls: { method: string; url: string; body: string; ip?: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      calls.push({ method: req.method!, url: req.url!, body, ip: req.headers['x-threatready-client-ip'] as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  return { calls, server };
}

describe('identity: junk cannot crowd out valid sessions (IP-REG1)', () => {
  const onboard = onboardStub();
  let url = '';
  beforeAll(async () => { url = await listen(onboard.server); });
  afterAll(() => onboard.server.close());

  it('answers a request without a plausible session cookie as signed out without asking onboard', async () => {
    const id = onboardIdentity({ identityUrl: url, internalToken: TOKEN, cacheSeconds: 30 });
    const before = onboard.state.calls;
    // The same check as the other resolvers: <token>.<44-character base64 signature ending in "=">.
    for (const c of ['tr.session_token=x', 'other=1', 'tr.session_token=aaaaaaaaaaaaaaaa', `tr.session_token=user-1.${'s'.repeat(40)}`, 'tr.session_token=<script>alert(1)</script>xxxxxxxxxx', '']) {
      expect(await id({ cookie: c }, '198.51.100.1')).toMatchObject({ ok: false, reason: 'signed-out' });
    }
    expect(onboard.state.calls).toBe(before);
    expect(await id({ cookie: `__Secure-${cookie('user-1')}` }, '198.51.100.1')).toMatchObject({ ok: true, user: { id: 'user-1' } });
    // The cache is keyed on the session token, so other cookies coming and going cost no new lookup.
    const calls = onboard.state.calls;
    expect(await id({ cookie: `theme=dark; __Secure-${cookie('user-1')}; _ga=1` }, '198.51.100.1')).toMatchObject({ ok: true, user: { id: 'user-1' } });
    expect(onboard.state.calls).toBe(calls);
  });

  it('queues one client past its share of lookups instead of letting it fill every slot or refusing it', async () => {
    onboard.state.delayMs = 300; onboard.state.reset();
    try {
      const id = onboardIdentity({ identityUrl: url, internalToken: TOKEN, cacheSeconds: 30, maxInFlight: 6, maxPerClient: 3 });
      const flood = Array.from({ length: 10 }, (_, i) => id({ cookie: cookie(`junk-${i}-${Date.now()}`) }, '203.0.113.66'));
      const valid = id({ cookie: cookie('user-valid') }, '198.51.100.20');
      expect(await valid).toMatchObject({ ok: true, user: { id: 'user-valid' } });
      const results = await Promise.all(flood);
      // Every lookup was answered (in waves of 3), and the flooding client never held more than its 3 slots.
      expect(results.filter((r) => !r.ok && r.reason === 'signed-out')).toHaveLength(10);
      expect(onboard.state.maxActive).toBeLessThanOrEqual(4);
      // Failures are cached: the same junk again costs no lookup.
      const calls = onboard.state.calls;
      await id({ cookie: cookie(`junk-0-x`) }, '203.0.113.66');
      await id({ cookie: cookie(`junk-0-x`) }, '203.0.113.66');
      expect(onboard.state.calls).toBe(calls + 1);
      // A cached session is answered by peek without a lookup.
      expect(id.peek!({ cookie: cookie('user-valid') })).toMatchObject({ id: 'user-valid' });
      expect(id.peek!({ cookie: cookie('user-unknown') })).toBeNull();
    } finally { onboard.state.delayMs = 0; }
  });

  it('answers busy past a bounded wait, and never sheds a session onboard confirmed recently', async () => {
    onboard.state.delayMs = 300;
    try {
      const id = onboardIdentity({ identityUrl: url, internalToken: TOKEN, cacheSeconds: 0, maxInFlight: 1, maxPerClient: 1, clientWaitMs: 100 });
      expect(await id({ cookie: cookie('user-known') }, '203.0.113.90')).toMatchObject({ ok: true });
      const calls = onboard.state.calls;
      // One running, 16 queued (16 x the cap), the rest refused at once; the queued ones give up after 100 ms.
      const flood = Array.from({ length: 20 }, (_, i) => id({ cookie: cookie(`junk-b-${i}`) }, '203.0.113.90'));
      // The confirmed session (no cache here) is checked again while the flood holds the client's slot
      // and the only global one: it is not shed.
      await new Promise((r) => setTimeout(r, 20));
      const again = id({ cookie: cookie('user-known') }, '203.0.113.90');
      const results = await Promise.all(flood);
      expect(results.filter((r) => !r.ok && r.reason === 'busy')).toHaveLength(19);
      expect(await again).toMatchObject({ ok: true, user: { id: 'user-known' } });
      expect(onboard.state.calls - calls).toBe(2);
    } finally { onboard.state.delayMs = 0; }
  });
});

describe('identity behind one NAT: a classroom signs in together (IP-REG1)', () => {
  const onboard = onboardStub();
  let url = '';
  beforeAll(async () => { url = await listen(onboard.server); });
  afterAll(() => onboard.server.close());

  it('serves 40 cold sessions from one address at once, while a junk flood from another cannot take the global slots', async () => {
    onboard.state.delayMs = 300; onboard.state.reset();
    try {
      const identity = onboardIdentity({ identityUrl: url, internalToken: TOKEN, cacheSeconds: 30 });
      const app = createApp(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173' });
      const server = http.createServer(app);
      const base = await listen(server);
      const get = (ip: string, c: string) => fetch(`${base}/api/me`, { headers: { 'x-threatready-client-ip': ip, cookie: c } }).then(async (r) => `${r.status} ${r.status === 200 ? '' : ((await r.json()) as { code?: string }).code ?? ''}`.trim());
      try {
        const junk = Array.from({ length: 60 }, (_, i) => get('203.0.113.200', cookie(`junk-nat-${i}`)));
        const classroom = Array.from({ length: 40 }, (_, i) => get('198.51.100.7', cookie(`user-class-${i}`)));
        const statuses = await Promise.all(classroom);
        expect(statuses.filter((s) => s !== '200')).toEqual([]);
        const junkStatuses = await Promise.all(junk);
        expect(junkStatuses.every((s) => s === '401 AUTH_REQUIRED' || s === '429 RATE_LIMITED')).toBe(true);
        // Two clients at 16 slots each: never more than 32 lookups at once against a global cap of 50.
        expect(onboard.state.maxActive).toBeLessThanOrEqual(32);
      } finally { server.close(); }
    } finally { onboard.state.delayMs = 0; }
  });
});

describe('rate limits: per learner for signed-in traffic, per IP for the rest (UX-REG0, AR-REG5)', () => {
  const onboard = onboardStub();
  let identity: IdentityResolver;
  beforeAll(async () => { identity = onboardIdentity({ identityUrl: await listen(onboard.server), internalToken: TOKEN, cacheSeconds: 30 }); });
  afterAll(() => onboard.server.close());

  it('never 429s a classroom of signed-in learners behind one NAT, while junk from that address still is', async () => {
    const app = createApp(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', ratePerMin: 120, rateIpPerMin: 40 });
    const nat = { 'x-threatready-client-ip': '198.51.100.30' };
    const statuses: number[] = [];
    // 30 learners, 4 requests each, all from one address: 120 requests against a 40/min per-IP limit.
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 30; i++) statuses.push((await request(app).get('/api/me').set({ ...nat, Cookie: cookie(`user-${i}`) })).status);
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    // Junk (plausible but unknown) cookies from another address pay the per-IP bucket before onboard is asked.
    const before = onboard.state.calls;
    const junk: number[] = [];
    for (let i = 0; i < 50; i++) junk.push((await request(app).get('/api/me').set({ 'x-threatready-client-ip': '203.0.113.77', Cookie: cookie(`junk-${i}`) })).status);
    // 40 a minute refill one token every 1.5 s: allow for one or two refilled while the loop runs.
    expect(junk.filter((s) => s === 401).length).toBeGreaterThanOrEqual(40);
    expect(junk.filter((s) => s === 401).length).toBeLessThanOrEqual(42);
    expect(junk.filter((s) => s === 429).length).toBeGreaterThanOrEqual(8);
    expect(onboard.state.calls - before).toBe(junk.filter((s) => s === 401).length);
  });

  it('standing alone, a client cannot pick its own per-IP bucket by sending the client-IP header', async () => {
    const server = createStandaloneServer(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', rateIpPerMin: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await request(server).get('/ar/api/me').set({ 'x-threatready-client-ip': `198.51.100.${100 + i}` })).status);
    expect(codes).toEqual([401, 401, 429]);
    // And inside the app, a value that is not an IP is ignored rather than used as a key.
    const app = createApp(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', rateIpPerMin: 2 });
    const junk: number[] = [];
    for (let i = 0; i < 3; i++) junk.push((await request(app).get('/api/me').set({ 'x-threatready-client-ip': `not-an-ip-${i}` })).status);
    expect(junk).toEqual([401, 401, 429]);
  });
});

describe('the /v1 proxy (UX-REG3, OPS-REG0) and the standalone server (TR-49)', () => {
  const engine = engineStub();
  let engineUrl = '';
  beforeAll(async () => { engineUrl = await listen(engine.server); });
  afterAll(() => engine.server.close());
  const signedOut: IdentityResolver = async () => ({ ok: false, reason: 'signed-out', setCookies: [] });

  it('answers its own 429 on /v1 in the engine envelope with Retry-After, so the SPA shows when to retry', async () => {
    const app = createApp(undefined, { identity: signedOut, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', rateIpPerMin: 1, reasoningApi: { url: engineUrl } });
    expect((await request(app).get('/v1/reasoning/domains')).status).toBe(200);
    const r = await request(app).get('/v1/reasoning/domains');
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(r.body.error.message).toMatch(/Try again in \d+ s/);
  });

  it('forwards one request per request: bytes sent with a GET or DELETE never reach the engine as a second request', async () => {
    const app = createApp(undefined, { identity: signedOut, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', rateIpPerMin: 0, reasoningApi: { url: engineUrl } });
    const server = http.createServer(app);
    const base = await listen(server);
    const port = Number(new URL(base).port);
    const smuggled = 'GET /internal/v1/reasoning/ai-usage HTTP/1.1\r\nHost: x\r\n\r\n';
    const raw = (payload: string) => new Promise<string>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.end(payload));
      let out = '';
      s.on('data', (d) => (out += d.toString()));
      s.on('close', () => resolve(out));
    });
    try {
      const n = engine.calls.length;
      await raw(`GET /v1/reasoning/domains HTTP/1.1\r\nHost: x\r\nContent-Length: ${smuggled.length}\r\nConnection: close\r\n\r\n${smuggled}`);
      const chunk = `${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`;
      await raw(`DELETE /v1/reasoning/attempts/x HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk}`);
      // A POST body still goes through whole, framed by its length or re-chunked.
      const json = '{"domain":"cloud_security"}';
      await raw(`POST /v1/reasoning/attempts HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: ${json.length}\r\nConnection: close\r\n\r\n${json}`);
      const seen = engine.calls.slice(n);
      expect(seen.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/reasoning/domains', 'DELETE /v1/reasoning/attempts/x', 'POST /v1/reasoning/attempts']);
      expect(seen[0]!.body).toBe('');
      expect(seen[1]!.body).toBe('');
      expect(seen[2]!.body).toBe('{"domain":"cloud_security"}');
    } finally { server.close(); }
  });

  it('caps a forwarded body, chunked or declared, and answers 413 without the engine seeing a request', async () => {
    const app = createApp(undefined, { identity: signedOut, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', rateIpPerMin: 0, reasoningApi: { url: engineUrl } });
    const server = http.createServer(app);
    const port = Number(new URL(await listen(server)).port);
    const raw = (head: string, body: () => Iterable<string>) => new Promise<string>((resolve) => {
      // No half-close: the server answers and closes (Connection: close).
      const s = net.connect(port, '127.0.0.1', () => { s.write(head); for (const b of body()) s.write(b); });
      let out = '';
      s.on('data', (d) => (out += d.toString()));
      s.on('error', () => resolve(out));
      s.on('close', () => resolve(out));
    });
    try {
      const n = engine.calls.length;
      const piece = 'x'.repeat(16 * 1024);
      // 20 chunks of 16 KiB: 320 KiB against the 256 KiB cap.
      const chunked = await raw(`POST /v1/reasoning/attempts HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`, function* () { for (let i = 0; i < 20; i++) yield `${piece.length.toString(16)}\r\n${piece}\r\n`; yield '0\r\n\r\n'; });
      expect(chunked).toMatch(/^HTTP\/1\.1 413 /);
      expect(chunked).toMatch(/"code":"PAYLOAD_TOO_LARGE"/);
      const size = 300 * 1024;
      const declared = await raw(`POST /v1/reasoning/attempts HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: ${size}\r\nConnection: close\r\n\r\n`, function* () { yield 'x'.repeat(size); });
      expect(declared).toMatch(/^HTTP\/1\.1 413 /);
      // A body under the cap still goes through whole, chunked.
      const ok = await raw(`POST /v1/reasoning/attempts HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`, function* () { yield `${piece.length.toString(16)}\r\n${piece}\r\n0\r\n\r\n`; });
      expect(ok).toMatch(/^HTTP\/1\.1 200 /);
      await new Promise((r) => setTimeout(r, 50));
      expect(engine.calls.slice(n).map((c) => `${c.method} ${c.url} ${c.body.length}`)).toEqual([`POST /v1/reasoning/attempts ${piece.length}`]);
    } finally { server.close(); }
  });

  it('standing alone, sends security headers on every response and serves the engine at /v1 with the path intact', async () => {
    const server = createStandaloneServer(undefined, { identity: signedOut, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', reasoningApi: { url: engineUrl } }, { hsts: true });
    for (const path of ['/', '/ar/api/me', '/v1/reasoning/domains']) {
      const r = await request(server).get(path);
      expect(r.headers['content-security-policy'], path).toBe(SECURITY_HEADERS['Content-Security-Policy']);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['strict-transport-security']).toMatch(/max-age=/);
    }
    expect(SECURITY_HEADERS['Content-Security-Policy']).toMatch(/frame-ancestors 'none'/);
    expect(SECURITY_HEADERS['Content-Security-Policy']).toMatch(/connect-src 'self'/);
    const n = engine.calls.length;
    expect((await request(server).get('/v1/reasoning/domains')).status).toBe(200);
    expect(engine.calls.slice(n).map((c) => c.url)).toEqual(['/v1/reasoning/domains']);
  });
});

describe('client: a question that counts as 0 is never skipped unasked (BIZ-09)', () => {
  it('asks before starting a question would skip the oldest unanswered one, and starts it only on a yes', async () => {
    const realFetch = globalThis.fetch;
    const bodies: unknown[] = [];
    const refusal = { error: { code: 'REASONING_SKIP_CONFIRMATION_REQUIRED', message: 'You have 3 unanswered questions open. Starting another skips the oldest, “Leaked key”, which counts as 0 in your averages.', retryable: false, request_id: 'r', details: { attemptId: 'a1', title: 'Leaked key' } } };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return body.skipOldest ? new Response(JSON.stringify({ id: 'new-1', state: 'ready' }), { status: 202 }) : new Response(JSON.stringify(refusal), { status: 409 });
    }) as typeof fetch;
    try {
      const asked: string[] = [];
      expect(await startQuestion('cloud_security', 'advanced', (m) => { asked.push(m); return false; })).toBeNull();
      expect(asked).toEqual([`${refusal.error.message} Start the new question anyway?`]);
      expect(bodies).toEqual([{ domain: 'cloud_security', difficulty: 'advanced' }]);
      bodies.length = 0;
      expect(await startQuestion('cloud_security', 'advanced', () => true)).toMatchObject({ id: 'new-1' });
      expect(bodies).toEqual([{ domain: 'cloud_security', difficulty: 'advanced' }, { domain: 'cloud_security', difficulty: 'advanced', skipOldest: true }]);
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('client: submission ids and messages (TR-60, UX-REG3, UX-REG9)', () => {
  it('makes a valid v4 UUID without crypto.randomUUID (non-secure origins, older browsers)', () => {
    const fallback = { getRandomValues: <T extends ArrayBufferView>(a: T) => globalThis.crypto.getRandomValues(a as unknown as Uint8Array) as unknown as T };
    const ids = new Set(Array.from({ length: 50 }, () => uuid(fallback)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says what happened and when to try again, never a raw status or code', async () => {
    const quota = new ApiError(429, 'x', 'REASONING_DAILY_LIMIT_REACHED', { details: { limit: 20, resetAt: '2026-10-24T00:00:00.000Z' }, retryAfterSec: 3600 });
    expect(messageFor(quota)).toMatch(/^You have used today’s 20 evaluations\. Your answer was not submitted and is kept in this tab; evaluations reset at 00:00 UTC \(.+ your time\)\.$/);
    expect(messageFor(new ApiError(429, 'x', 'LLM_BUDGET_EXCEEDED', { details: { scope: 'user_day', resetAt: '2026-10-24T00:00:00.000Z' } }))).toMatch(/resets at 00:00 UTC/);
    expect(messageFor(new ApiError(429, 'x', 'LLM_BUDGET_EXCEEDED'))).not.toMatch(/attempt is saved/);
    expect(messageFor(new ApiError(503, 'x', 'AI_SERVICE_PAUSED'))).toMatch(/paused for the rest of today/);
    expect(FAILURE_MESSAGE('AI_SERVICE_PAUSED')).not.toMatch(/can finish/);
    expect(messageFor(new ApiError(429, 'x', 'RATE_LIMITED', { retryAfterSec: 1800 }))).toBe('You are going a little fast. Try again in about 30 min.');

    // A gateway's flat 429 body ({ error: '…', code }) reads like the engine's envelope.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Too many requests. Try again in 7s.', code: 'RATE_LIMITED' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' } })) as typeof fetch;
    try {
      const err = await reasoning.domains().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('RATE_LIMITED');
      expect(messageFor(err)).toBe('You are going a little fast. Try again in 7 s.');
      globalThis.fetch = (async () => new Response('<html>busy</html>', { status: 503, headers: { 'retry-after': '20' } })) as typeof fetch;
      const down = await reasoning.domains().catch((e: unknown) => e);
      expect(messageFor(down)).toBe('The assessment service is briefly unavailable. Try again in 20 s.');
    } finally { globalThis.fetch = realFetch; }
  });
});
