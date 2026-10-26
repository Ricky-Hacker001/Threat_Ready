// Gateway behaviour with stub children on loopback ports: internal-route guard, client-IP stamping,
// security headers, hop-by-hop stripping, readiness/health, labs-child failure modes, SSE streaming and
// request ids. node:test, no extra dependencies:  cd deploy && npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CLIENT_IP_HEADER, clientIpOf, createGateway } from '../gateway.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

/** A child stub: records every request and answers JSON with what it saw. /labs/sse streams two events 100 ms apart. */
function stubChild(name) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/labs/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: a\ndata: 1\n\n');
      setTimeout(() => { res.write('event: b\ndata: 2\n\n'); res.end(); }, 100);
      return;
    }
    if (req.url === '/labs/error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"child blew up"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'proxy-authenticate': 'Basic realm="child"', 'x-child': name });
    res.end(JSON.stringify({ child: name, url: req.url, clientIp: req.headers[CLIENT_IP_HEADER] ?? null, requestId: req.headers['x-request-id'] ?? null }));
  });
  return { server, seen };
}

/** Raw request (fetch forbids some of the headers these tests send). Resolves with status, headers, body and chunk timings. */
function raw(port, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push({ at: Date.now() - started, text: c.toString() }));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.map((c) => c.text).join(''), chunks, endedAt: Date.now() - started }));
    });
    req.on('error', reject);
    req.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
/** Bytes on the wire (Node's http client refuses some of the headers the stripping test needs to send). */
function rawSocket(port, lines) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`${lines.join('\r\n')}\r\n\r\n`));
    let data = '';
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

const SECURITY_HEADERS = ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'referrer-policy', 'permissions-policy'];
const assertSecurityHeaders = (r, label) => { for (const h of SECURITY_HEADERS) assert.ok(r.headers[h], `${label}: missing ${h}`); };

describe('gateway', () => {
  const onboard = stubChild('onboard');
  const interview = stubChild('interview');
  const labs = stubChild('labs');
  let ports;
  let gw;
  let gwPort;
  const state = { onboard: true, interview: true, labs: true, degraded: false, status: { onboard: 'ready', interview: 'ready', labs: 'ready' }, exits: { onboard: 0, interview: 0, labs: 0 } };
  const ready = () => ({ ...state, status: { ...state.status } });

  before(async () => {
    ports = { onboard: await listen(onboard.server), interview: await listen(interview.server), labs: await listen(labs.server) };
    const app = await createGateway({ onboardPort: ports.onboard, interviewPort: ports.interview, labsPort: ports.labs, ready });
    gw = http.createServer(app);
    gwPort = await listen(gw);
  });
  after(async () => { await close(gw); await close(onboard.server); await close(interview.server); await close(labs.server); });

  test('internal paths answer 404 with every edge header and are never forwarded', async () => {
    const edge = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'cf-connecting-ip', 'true-client-ip', 'cf-ray', 'rndr-id', 'x-real-ip', 'forwarded', 'via'];
    const paths = ['/api/internal/identity/session', '/labs/internal/v1/users/u/summary', '/ar/internal/v1/ai-usage', '/labs/redteam/internal/x', '/API/Internal/x', '/Labs/RedTeam/INTERNAL/x', '/api/internal', '/ar/internal'];
    const before = [onboard.seen.length, labs.seen.length];
    for (const h of edge) {
      for (const p of paths) {
        const r = await raw(gwPort, 'GET', p, { [h]: '1.2.3.4' });
        assert.equal(r.status, 404, `${h} ${p}`);
        assert.ok(json(r)?.requestId, `${p}: 404 carries the request id`);
        assertSecurityHeaders(r, `${h} ${p}`);
      }
    }
    assert.deepEqual([onboard.seen.length, labs.seen.length], before, 'no internal request reached a child');
  });

  test('odd spellings of an internal path never reach a child as an internal route', async () => {
    const before = onboard.seen.length;
    // These either answer 404 or fall through to the SPA shell (200 HTML when the web dist is built);
    // what matters is that none of them is proxied to a child as an internal route.
    for (const p of ['//api/internal', '/%2Fapi%2Finternal', '/api%2Finternal/x', '/api/./internal/x', '/api/x/../internal/x', '/api//internal/x']) {
      const r = await raw(gwPort, 'GET', p, { 'x-forwarded-for': '1.2.3.4' });
      assert.ok(r.status === 404 || !(r.headers['content-type'] ?? '').includes('json') || json(r)?.child === undefined, `${p} proxied (${r.status})`);
    }
    const reached = onboard.seen.slice(before).map((s) => s.url);
    assert.ok(reached.every((u) => !/internal/i.test(decodeURIComponent(u))), `forwarded: ${reached.join(', ')}`);
  });

  test('bare loopback caller (no edge header) reaches the internal route', async () => {
    const r = await raw(gwPort, 'GET', '/api/internal/identity/session');
    assert.equal(r.status, 200);
    assert.equal(json(r).child, 'onboard');
    const l = await raw(gwPort, 'GET', '/labs/redteam/internal/v1/x');
    assert.equal(l.status, 200);
    assert.equal(json(l).child, 'labs');
  });

  test('client-IP header is always the gateway\'s: client value ignored, junk → socket, cf-connecting-ip preferred', async () => {
    const spoofed = json(await raw(gwPort, 'GET', '/api/x', { [CLIENT_IP_HEADER]: '9.9.9.9' }));
    assert.equal(spoofed.clientIp, '127.0.0.1', 'client-supplied header overwritten with the socket IP');
    const xff = json(await raw(gwPort, 'GET', '/api/x', { 'x-forwarded-for': '1.2.3.4, 10.0.0.1', [CLIENT_IP_HEADER]: '9.9.9.9' }));
    assert.equal(xff.clientIp, '1.2.3.4');
    const junk = json(await raw(gwPort, 'GET', '/labs/x', { 'x-forwarded-for': 'not-an-ip' }));
    assert.equal(junk.clientIp, '127.0.0.1');
    const cf = json(await raw(gwPort, 'GET', '/ar/x', { 'cf-connecting-ip': '5.5.5.5', 'true-client-ip': '6.6.6.6', 'x-forwarded-for': '1.2.3.4' }));
    assert.equal(cf.clientIp, '5.5.5.5');
    const tc = json(await raw(gwPort, 'GET', '/v1/x', { 'true-client-ip': '6.6.6.6', 'x-forwarded-for': '1.2.3.4' }));
    assert.equal(tc.clientIp, '6.6.6.6');
    // The pure function agrees with the wire behaviour, including IPv6 literals.
    assert.equal(clientIpOf({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '2001:db8::1' } }), '2001:db8::1');
    assert.equal(clientIpOf({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': ['7.7.7.7'] } }), '7.7.7.7');
  });

  test('security headers on every kind of response: SPA, proxied, 404, upstream 500, gateway 500', async () => {
    for (const p of ['/', '/labs/', '/ar/', '/interview-prep/', '/healthz', '/readyz']) assertSecurityHeaders(await raw(gwPort, 'GET', p), p);
    const notFound = await raw(gwPort, 'POST', '/no-such-route');
    assert.equal(notFound.status, 404);
    assert.equal(json(notFound).error.code, 'NOT_FOUND');
    assertSecurityHeaders(notFound, 'POST 404');
    const upstream500 = await raw(gwPort, 'GET', '/labs/error');
    assert.equal(upstream500.status, 500);
    assertSecurityHeaders(upstream500, 'upstream 500');
    // In-process fallback whose handler throws: the gateway's own error handler answers, JSON only.
    const boom = await createGateway({ onboardPort: ports.onboard, interviewPort: ports.interview, ready, labsApp: (_req, _res, next) => next(new Error('boom')), arApp: (_req, _res, next) => next(new Error('boom')) });
    const srv = http.createServer(boom);
    const port = await listen(srv);
    try {
      const r = await raw(port, 'GET', '/labs/anything');
      assert.equal(r.status, 500);
      assert.equal(r.headers['content-type'].split(';')[0], 'application/json');
      assert.equal(json(r).error.code, 'INTERNAL');
      assert.ok(json(r).error.requestId);
      assert.ok(!r.body.includes('boom'), 'error message never leaks');
      assertSecurityHeaders(r, 'gateway 500');
    } finally { await close(srv); }
  });

  test('hop-by-hop headers are not forwarded to a child, in either direction', async () => {
    const before = labs.seen.length;
    const wire = await rawSocket(gwPort, [`GET /labs/x HTTP/1.1`, `Host: 127.0.0.1:${gwPort}`, 'Connection: close', 'Proxy-Authorization: Basic abc', 'TE: trailers', 'Keep-Alive: timeout=5', 'Trailer: x-foo', 'X-Forwarded-For: 1.2.3.4']);
    assert.match(wire, /^HTTP\/1\.1 200/);
    const upstreamHeaders = labs.seen[before].headers;
    for (const h of ['proxy-authorization', 'te', 'keep-alive', 'trailer']) assert.equal(upstreamHeaders[h], undefined, `${h} forwarded upstream`);
    const down = await raw(gwPort, 'GET', '/labs/x');
    assert.equal(down.headers['proxy-authenticate'], undefined, 'child hop-by-hop header relayed to the client');
    assert.equal(down.headers['x-child'], 'labs', 'ordinary child headers still relayed');
    assert.equal(upstreamHeaders['x-forwarded-host'], `127.0.0.1:${gwPort}`);
    assert.equal(upstreamHeaders['x-forwarded-proto'], 'https');
  });

  test('healthz and readyz: 503 when degraded; readyz reports all three children', async () => {
    const r = await raw(gwPort, 'GET', '/readyz');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(json(r).status).sort(), ['interview', 'labs', 'onboard']);
    state.degraded = true;
    try {
      const h = await raw(gwPort, 'GET', '/healthz');
      assert.equal(h.status, 503);
      assert.deepEqual(json(h), { ok: false });
    } finally { state.degraded = false; }
    assert.equal((await raw(gwPort, 'GET', '/healthz')).status, 200);
    state.labs = false; state.status.labs = 'starting';
    try { assert.equal((await raw(gwPort, 'GET', '/readyz')).status, 503, 'labs not ready → readyz 503'); } finally { state.labs = true; state.status.labs = 'ready'; }
  });

  test('labs child down → /labs and /ar answer 503 UPSTREAM_UNAVAILABLE while /api still proxies', async () => {
    state.labs = false; state.status.labs = 'down';
    try {
      for (const p of ['/labs/api/x', '/ar/api/x']) {
        const r = await raw(gwPort, 'GET', p);
        assert.equal(r.status, 503, p);
        assert.equal(r.headers['retry-after'], '5');
        assert.equal(json(r).error.code, 'UPSTREAM_UNAVAILABLE');
        assert.ok(json(r).error.requestId);
      }
      assert.equal(json(await raw(gwPort, 'GET', '/api/x')).child, 'onboard');
    } finally { state.labs = true; state.status.labs = 'ready'; }
    // Never been ready: STARTING.
    state.labs = false; state.status.labs = 'starting';
    try { assert.equal(json(await raw(gwPort, 'GET', '/labs/api/x')).error.code, 'STARTING'); } finally { state.labs = true; state.status.labs = 'ready'; }
    // Marked ready but the port refuses connections (crashed between probes): UPSTREAM_UNAVAILABLE too.
    await close(labs.server);
    try {
      const r = await raw(gwPort, 'GET', '/labs/api/x');
      assert.equal(r.status, 503);
      assert.equal(json(r).error.code, 'UPSTREAM_UNAVAILABLE');
    } finally { ports.labs = await new Promise((res) => labs.server.listen(ports.labs, '127.0.0.1', () => res(ports.labs))); }
  });

  test('SSE streams through the proxy: two events 100 ms apart both arrive before the end', async () => {
    const r = await raw(gwPort, 'GET', '/labs/sse');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/event-stream');
    assert.ok(r.body.includes('event: a') && r.body.includes('event: b'));
    const firstA = r.chunks.find((c) => c.text.includes('event: a')).at;
    const firstB = r.chunks.find((c) => c.text.includes('event: b')).at;
    assert.ok(firstB - firstA >= 50, `events buffered together (a at ${firstA} ms, b at ${firstB} ms)`);
    assert.ok(firstA < r.endedAt - 50, 'first event arrived well before the response ended');
  });

  test('x-request-id: always minted by the gateway (a client-supplied id is never kept); forwarded and echoed', async () => {
    const fresh = await raw(gwPort, 'GET', '/api/x');
    assert.match(fresh.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(json(fresh).requestId, fresh.headers['x-request-id'], 'child received the same id');
    // The APIs trust a well-formed inbound id for log correlation, so a client must not be able to choose it.
    const supplied = await raw(gwPort, 'GET', '/api/x', { 'x-request-id': 'req_abcdef123456' });
    assert.match(supplied.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.notEqual(supplied.headers['x-request-id'], 'req_abcdef123456');
    assert.equal(json(supplied).requestId, supplied.headers['x-request-id'], 'child received the minted id, not the client one');
    const junk = await raw(gwPort, 'GET', '/api/x', { 'x-request-id': 'bad id\twith spaces' });
    assert.match(junk.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    const err = await raw(gwPort, 'GET', '/api/internal/x', { 'x-forwarded-for': '1.1.1.1', 'x-request-id': 'req_abcdef123456' });
    assert.match(json(err).requestId, /^[0-9a-f-]{36}$/, 'error JSON echoes the minted id');
    assert.equal(json(err).requestId, err.headers['x-request-id']);
  });

  test('no source maps under any served dist directory', () => {
    const dists = ['Threatready-landing-page-main/apps/web/dist', 'InterviewPrep/apps/web/dist', 'threatready-lab-001/dist', 'attack-reasoning/dist', 'soc/client/dist', 'DevSecOps-Simulation/dist', 'ThreatWall/dist', 'AI-Security/dist', 'red_team_lab/web/dist'];
    const maps = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.map')) maps.push(p); } };
    for (const d of dists) { const full = path.join(ROOT, d); if (fs.existsSync(full)) walk(full); }
    assert.deepEqual(maps, [], `source maps served: ${maps.join(', ')}`);
  });
});
