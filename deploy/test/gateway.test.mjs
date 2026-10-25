// Gateway regression tests: client-IP selection (TR-02), request framing / smuggling (OPS-REG0),
// body cap and upstream timeouts (TR-18), CSP (TR-50). Run: cd deploy && npm test
// Everything listens on ephemeral loopback ports; nothing outside this process is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { CLIENT_IP_HEADER, CONTENT_SECURITY_POLICY, clientIpOf, createGateway, gatewayConfig, ipLiteral } from '../gateway.mjs';

const fakeReq = (headers = {}, remoteAddress = '10.0.0.9') => ({ headers, socket: { remoteAddress } });
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

/** An upstream child stand-in that records every request it fully received. */
function stubUpstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const entry = { method: req.method, url: req.url, headers: req.headers, body: '', complete: false };
    seen.push(entry);
    req.setEncoding('utf8');
    req.on('data', (c) => { entry.body += c; });
    req.on('end', () => {
      entry.complete = true;
      if (handler) { handler(req, res, entry); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, seen };
}

async function gatewayWith({ upstream, config = {}, ready = () => ({ onboard: true, interview: true, degraded: false }), logs = [] }) {
  const port = await listen(upstream.server);
  const labsApp = express();
  labsApp.get(/.*/, (req, res) => res.json({ ip: req.ip, header: req.headers[CLIENT_IP_HEADER] }));
  const arApp = express();
  arApp.use((_req, res) => res.json({ app: 'ar' }));
  const app = await createGateway({
    onboardPort: port, interviewPort: port, ready, labsApp, arApp,
    config: { ...gatewayConfig({}), ...config }, log: (m) => logs.push(m),
  });
  const gw = http.createServer(app);
  const gwPort = await listen(gw);
  return { gwPort, logs, stop: async () => { await close(gw); await close(upstream.server); } };
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

/** Raw bytes on one connection; resolves with whatever came back before the socket closed or `ms` passed. */
function raw(port, payload, ms = 800) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let data = '';
    s.on('data', (c) => { data += c; });
    s.on('error', () => {});
    s.on('close', () => resolve(data));
    s.write(payload);
    setTimeout(() => { s.destroy(); resolve(data); }, ms);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- TR-02: client IP ---------------- */

test('client IP (default): the entry Cloudflare appended, 2 from the right; client-written entries and edge-looking headers are ignored', () => {
  const cfg = gatewayConfig({}).clientIp;
  assert.deepEqual(cfg, { source: 'xff-rightmost', hops: 2 });
  // Render: <client-written...>, <client as seen by Cloudflare>, <Cloudflare edge as seen by Render>
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': '198.51.100.7, 104.22.17.40' }), cfg), '198.51.100.7');
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': '8.8.8.8, 198.51.100.7, 104.22.17.40' }), cfg), '198.51.100.7');
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': '1.0.0.1, 1.0.0.2, 1.0.0.3, 198.51.100.7, 104.22.17.40' }), cfg), '198.51.100.7');
  // Forged edge headers change nothing.
  assert.equal(clientIpOf(fakeReq({ 'cf-connecting-ip': '7.7.7.7', 'true-client-ip': '6.6.6.6', 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '198.51.100.7, 104.22.17.40' }), cfg), '198.51.100.7');
  // Repeated header lines (Node joins x-forwarded-for with ", ") and empty client-written entries.
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': ['9.9.9.9', '198.51.100.7, 104.22.17.40'] }), cfg), '198.51.100.7');
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': ' , ,198.51.100.7, 104.22.17.40' }), cfg), '198.51.100.7');
  // No proxy header at all: the socket.
  assert.equal(clientIpOf(fakeReq({}), cfg), '10.0.0.9');
});

test('client IP: hop count, short chains and junk', () => {
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': '8.8.8.8, 203.0.113.5' }), { source: 'xff-rightmost', hops: 1 }), '203.0.113.5');
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': '8.8.8.8, 198.51.100.7, 172.16.0.1, 10.1.1.1' }), { source: 'xff-rightmost', hops: 3 }), '198.51.100.7');
  // Fewer entries than hops: the left-most (the farthest trusted proxy's view).
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': '198.51.100.7' }), { source: 'xff-rightmost', hops: 2 }), '198.51.100.7');
  // The selected entry is not an IP: never trust it, use the socket.
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': 'garbage, 104.22.17.40' }), { source: 'xff-rightmost', hops: 2 }), '10.0.0.9');
  // Ports, brackets and IPv4-mapped addresses are normalised (one bucket per address).
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': '198.51.100.7:51234, 104.22.17.40' })), '198.51.100.7');
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': '[2001:db8::1]:443, 104.22.17.40' })), '2001:db8::1');
  assert.equal(clientIpOf(fakeReq({}, '::ffff:127.0.0.1')), '127.0.0.1');
  assert.equal(ipLiteral('not-an-ip'), '');
});

test('client IP: explicit sources', () => {
  const h = { 'cf-connecting-ip': '7.7.7.7', 'true-client-ip': '6.6.6.6', 'x-forwarded-for': '8.8.8.8, 203.0.113.5' };
  assert.equal(clientIpOf(fakeReq(h), { source: 'cf-connecting-ip', hops: 2 }), '7.7.7.7');
  assert.equal(clientIpOf(fakeReq(h), { source: 'true-client-ip', hops: 2 }), '6.6.6.6');
  assert.equal(clientIpOf(fakeReq(h), { source: 'socket', hops: 2 }), '10.0.0.9');
  // Header missing or junk: the socket, never another header.
  assert.equal(clientIpOf(fakeReq({ 'x-forwarded-for': '8.8.8.8' }), { source: 'cf-connecting-ip', hops: 2 }), '10.0.0.9');
  assert.equal(clientIpOf(fakeReq({ 'cf-connecting-ip': 'evil' }), { source: 'cf-connecting-ip', hops: 2 }), '10.0.0.9');
});

test('gateway settings: defaults, "0" disables a limit, malformed values refuse to start', () => {
  assert.deepEqual(gatewayConfig({}), { clientIp: { source: 'xff-rightmost', hops: 2 }, maxBodyBytes: 15 * 1024 * 1024, upstreamIdleMs: 180_000, bootHealth: 'auto' });
  const off = gatewayConfig({ GATEWAY_MAX_BODY_BYTES: '0', GATEWAY_UPSTREAM_TIMEOUT_MS: '0', CLIENT_IP_SOURCE: 'CF-Connecting-IP', TRUSTED_PROXY_HOPS: '3', GATEWAY_BOOT_HEALTH: 'Migrations' });
  assert.deepEqual(off, { clientIp: { source: 'cf-connecting-ip', hops: 3 }, maxBodyBytes: 0, upstreamIdleMs: 0, bootHealth: 'migrations' });
  assert.throws(() => gatewayConfig({ CLIENT_IP_SOURCE: 'leftmost' }), /CLIENT_IP_SOURCE/);
  assert.equal(gatewayConfig({ GATEWAY_BOOT_HEALTH: 'wait' }).bootHealth, 'wait');
  assert.throws(() => gatewayConfig({ GATEWAY_BOOT_HEALTH: 'never' }), /GATEWAY_BOOT_HEALTH/);
  assert.throws(() => gatewayConfig({ TRUSTED_PROXY_HOPS: '0' }), /TRUSTED_PROXY_HOPS/);
  assert.throws(() => gatewayConfig({ TRUSTED_PROXY_HOPS: '2.5' }), /TRUSTED_PROXY_HOPS/);
  assert.throws(() => gatewayConfig({ GATEWAY_MAX_BODY_BYTES: '15MB' }), /GATEWAY_MAX_BODY_BYTES/);
});

test('through the gateway: children and in-process apps get the derived IP; client-sent IP headers never pass', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream });
  try {
    const headers = { 'x-forwarded-for': '8.8.8.8, 198.51.100.7, 104.22.17.40', 'cf-connecting-ip': '7.7.7.7', 'true-client-ip': '6.6.6.6', [CLIENT_IP_HEADER]: '5.5.5.5', connection: `keep-alive, ${CLIENT_IP_HEADER}, x-forwarded-for` };
    assert.equal((await request(g.gwPort, '/api/echo', { headers })).status, 200);
    const got = upstream.seen.at(-1).headers;
    assert.equal(got[CLIENT_IP_HEADER], '198.51.100.7');
    assert.equal(got['x-forwarded-for'], '198.51.100.7');
    assert.equal(got['cf-connecting-ip'], undefined);
    assert.equal(got['true-client-ip'], undefined);
    const labs = JSON.parse((await request(g.gwPort, '/labs/whoami', { headers })).body);
    assert.deepEqual(labs, { ip: '198.51.100.7', header: '198.51.100.7' });
  } finally { await g.stop(); }
});

test('hop-count check logs where CF-Connecting-IP sits (no address logged) and warns on a mismatch', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream });
  try {
    await request(g.gwPort, '/api/a', { headers: { 'x-forwarded-for': '198.51.100.7, 104.22.17.40, 10.2.3.4', 'cf-connecting-ip': '198.51.100.7' } });
    assert.equal(g.logs.length, 1);
    assert.match(g.logs[0], /3 from the right: 1/);
    assert.match(g.logs[0], /set TRUSTED_PROXY_HOPS=3/);
    assert.doesNotMatch(g.logs[0], /198\.51\.100\.7/);
  } finally { await g.stop(); }
});

/* ---------------- OPS-REG0: framing ---------------- */

const SMUGGLED = 'GET /api/SMUGGLED HTTP/1.1\r\nHost: x\r\n\r\n';
const chunk = (s) => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n0\r\n\r\n`;

for (const method of ['GET', 'DELETE', 'HEAD', 'OPTIONS']) {
  test(`a ${method} with a chunked body reaches the child as exactly one request`, async () => {
    const upstream = stubUpstream();
    const g = await gatewayWith({ upstream });
    try {
      await raw(g.gwPort, `${method} /api/front HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk(SMUGGLED)}`);
      await wait(100);
      assert.deepEqual(upstream.seen.map((s) => `${s.method} ${s.url}`), [`${method} /api/front`]);
      assert.equal(upstream.seen[0].headers['transfer-encoding'], 'chunked');
      assert.equal(upstream.seen[0].body, SMUGGLED);
    } finally { await g.stop(); }
  });
}

test('a DELETE with a Content-Length body reaches the child as one request with that length', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream });
  try {
    await raw(g.gwPort, `DELETE /v1/x HTTP/1.1\r\nHost: x\r\nContent-Length: ${Buffer.byteLength(SMUGGLED)}\r\nConnection: close\r\n\r\n${SMUGGLED}`);
    await wait(100);
    assert.deepEqual(upstream.seen.map((s) => `${s.method} ${s.url}`), ['DELETE /v1/x']);
    assert.equal(upstream.seen[0].headers['content-length'], String(Buffer.byteLength(SMUGGLED)));
    assert.equal(upstream.seen[0].body, SMUGGLED);
  } finally { await g.stop(); }
});

test('a POST keeps its body and framing; a bodyless GET sends none', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream });
  try {
    await request(g.gwPort, '/api/p', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    await request(g.gwPort, '/api/g');
    assert.equal(upstream.seen[0].body, '{"a":1}');
    assert.equal(upstream.seen[1].body, '');
    assert.equal(upstream.seen[1].headers['transfer-encoding'], undefined);
    assert.equal(upstream.seen[1].headers['content-length'], undefined);
  } finally { await g.stop(); }
});

test('Transfer-Encoding with Content-Length, or a coding other than chunked, is refused before any child sees it', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream });
  try {
    const both = await raw(g.gwPort, `POST /api/x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n${chunk('hello')}`);
    assert.match(both, /^HTTP\/1\.1 400/);
    const gzip = await raw(g.gwPort, `POST /api/x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: gzip, chunked\r\nConnection: close\r\n\r\n${chunk('hello')}`);
    assert.match(gzip, /^HTTP\/1\.1 400/);
    assert.equal(upstream.seen.length, 0);
  } finally { await g.stop(); }
});

test('a compressed request body is refused with 415 before any app parses it; identity is allowed', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream });
  try {
    for (const enc of ['gzip', 'deflate', 'br', 'GZIP', 'gzip, identity']) {
      const r = await request(g.gwPort, '/api/x', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': enc }, body: '{}' });
      assert.equal(r.status, 415, enc);
    }
    assert.equal(upstream.seen.length, 0);
    const ok = await request(g.gwPort, '/api/x', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'identity' }, body: '{}' });
    assert.notEqual(ok.status, 415);
    assert.equal(upstream.seen.length, 1);
  } finally { await g.stop(); }
});

/* ---------------- TR-18: body cap and timeouts ---------------- */

test('a declared body over the cap gets 413 and never reaches the child', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream, config: { maxBodyBytes: 1000 } });
  try {
    const r = await request(g.gwPort, '/v1/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x'.repeat(2000) });
    assert.equal(r.status, 413);
    assert.equal(JSON.parse(r.body).error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(upstream.seen.length, 0);
    // Under the cap passes.
    assert.equal((await request(g.gwPort, '/v1/upload', { method: 'POST', body: 'x'.repeat(900) })).status, 200);
  } finally { await g.stop(); }
});

test('a chunked body that grows past the cap gets 413; the child never receives a complete request', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream, config: { maxBodyBytes: 1000 } });
  try {
    const big = 'y'.repeat(600);
    const reply = await raw(g.gwPort, `POST /api/stream HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n258\r\n${big}\r\n258\r\n${big}\r\n258\r\n${big}\r\n0\r\n\r\n`, 1500);
    assert.match(reply, /^HTTP\/1\.1 413/);
    await wait(100);
    assert.ok(upstream.seen.every((s) => !s.complete), 'the child must not see a complete over-cap request');
  } finally { await g.stop(); }
});

test('the cap and the timeout can be turned off with 0', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream, config: { maxBodyBytes: 0, upstreamIdleMs: 0 } });
  try {
    assert.equal((await request(g.gwPort, '/api/big', { method: 'POST', body: 'z'.repeat(20 * 1024 * 1024) })).status, 200);
    assert.equal(upstream.seen[0].body.length, 20 * 1024 * 1024);
  } finally { await g.stop(); }
});

test('a hung child is abandoned after the idle timeout with a 504 the client can act on', async () => {
  const upstream = stubUpstream(() => { /* never answers */ });
  const g = await gatewayWith({ upstream, config: { upstreamIdleMs: 200 } });
  try {
    const started = Date.now();
    const r = await request(g.gwPort, '/api/slow');
    assert.equal(r.status, 504);
    assert.equal(r.headers['retry-after'], '5');
    const body = JSON.parse(r.body).error;
    assert.equal(body.code, 'UPSTREAM_TIMEOUT');
    assert.ok(body.message.length > 10);
    assert.ok(Date.now() - started < 3000);
  } finally { await g.stop(); }
});

test('event streams are exempt from the idle timeout (by Accept, or by the response type)', async () => {
  const upstream = stubUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': open\n\n');
    setTimeout(() => res.end('event: done\ndata: {}\n\n'), 500);
  });
  const g = await gatewayWith({ upstream, config: { upstreamIdleMs: 150 } });
  try {
    const viaAccept = await request(g.gwPort, '/v1/interviews/1/turns', { method: 'POST', headers: { accept: 'text/event-stream' }, body: '{}' });
    assert.match(viaAccept.body, /event: done/);
    const viaType = await request(g.gwPort, '/v1/events');
    assert.match(viaType.body, /event: done/);
  } finally { await g.stop(); }
});

test('a child that refuses before reading an upload: the client still gets its complete answer', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    // Node (and so Nest) answers without reading the body, then discards the rest of it.
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first.' } }));
  });
  const g = await gatewayWith({ upstream: { server, seen } });
  try {
    const r = await request(g.gwPort, '/v1/documents', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: 'u'.repeat(4 * 1024 * 1024) });
    assert.equal(r.status, 401);
    assert.equal(JSON.parse(r.body).error.code, 'UNAUTHENTICATED');
  } finally { await g.stop(); }
});

test('a child that is not ready yet answers 503 with Retry-After', async () => {
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream, ready: () => ({ onboard: false, interview: false, degraded: false }) });
  try {
    const r = await request(g.gwPort, '/api/x');
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '5');
    assert.equal(JSON.parse(r.body).error.code, 'STARTING');
  } finally { await g.stop(); }
});

/* ---------------- TR-14: health while booting ---------------- */

test('/healthz is 503 while the launcher is starting (migrations, first API start), then 200; a crash loop is 503 again', async () => {
  const state = { onboard: false, interview: false, starting: true, degraded: false };
  const g = await gatewayWith({ upstream: stubUpstream(), ready: () => state });
  try {
    // A failing migration or an API that never starts keeps the deploy unhealthy: Render keeps the old instance.
    let r = await request(g.gwPort, '/healthz');
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '5');
    assert.deepEqual(JSON.parse(r.body), { ok: false, phase: 'starting' });
    // The port is up meanwhile: the SPA shell and in-process labs still answer.
    assert.equal((await request(g.gwPort, '/labs/x')).status, 200);
    Object.assign(state, { onboard: true, interview: true, starting: false });
    r = await request(g.gwPort, '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
    Object.assign(state, { onboard: false, degraded: true });
    assert.equal((await request(g.gwPort, '/healthz')).status, 503);
    assert.equal((await request(g.gwPort, '/readyz')).status, 503);
  } finally { await g.stop(); }
});

/* ---------------- TR-50: headers ---------------- */

test('CSP connect-src is self + blob: only (no data:), on every response', async () => {
  const connect = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('connect-src'));
  assert.equal(connect, "connect-src 'self' blob:");
  const upstream = stubUpstream();
  const g = await gatewayWith({ upstream });
  try {
    const r = await request(g.gwPort, '/healthz');
    assert.equal(r.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
    assert.equal(r.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  } finally { await g.stop(); }
});
