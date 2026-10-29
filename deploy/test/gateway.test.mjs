// Gateway regression tests. Ours: client-IP selection (TR-02), request framing / smuggling (OPS-REG0),
// body cap and upstream timeouts (TR-18), boot-phase health (TR-14), CSP (TR-50). Theirs (security patch
// 2): internal-route guard, client-IP stamping, security headers, hop-by-hop stripping, readiness/health,
// labs-child failure modes, SSE streaming and request ids. Merged: the same protections on the labs
// child's /labs and /ar, and the child's own CSP winning for its pages. Run: cd deploy && npm test
// Everything listens on ephemeral loopback ports; nothing outside this process is touched.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import express from 'express';
import { CLIENT_IP_HEADER, CONTENT_SECURITY_POLICY, CSP_DIRECTIVES, clientIpOf, createGateway, gatewayConfig, ipLiteral, labUnavailablePage } from '../gateway.mjs';
import { gatewayIpToForwardedFor } from '../launcher-lib.mjs';
import { extractGatewayHeaders } from '../../tools/gen-headers.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const fakeReq = (headers = {}, remoteAddress = '10.0.0.9') => ({ headers, socket: { remoteAddress } });
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { if (!server) { resolve(); return; } server.closeAllConnections?.(); server.close(() => resolve()); });

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
  assert.deepEqual(gatewayConfig({}), { clientIp: { source: 'xff-rightmost', hops: 2 }, maxBodyBytes: 15 * 1024 * 1024, upstreamIdleMs: 180_000, pageHoldMs: 15_000, bootHealth: 'auto' });
  const off = gatewayConfig({ GATEWAY_MAX_BODY_BYTES: '0', GATEWAY_UPSTREAM_TIMEOUT_MS: '0', GATEWAY_PAGE_HOLD_MS: '0', CLIENT_IP_SOURCE: 'CF-Connecting-IP', TRUSTED_PROXY_HOPS: '3', GATEWAY_BOOT_HEALTH: 'Migrations' });
  assert.deepEqual(off, { clientIp: { source: 'cf-connecting-ip', hops: 3 }, maxBodyBytes: 0, upstreamIdleMs: 0, pageHoldMs: 0, bootHealth: 'migrations' });
  assert.throws(() => gatewayConfig({ GATEWAY_PAGE_HOLD_MS: '120000' }), /GATEWAY_PAGE_HOLD_MS/);
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
    assert.equal(r.headers['x-robots-tag'], 'noindex', 'the signed-in platform is never indexed');
    assert.ok(!/googleapis|gstatic/.test(r.headers['content-security-policy']), 'fonts are self-hosted: no Google Fonts origins in the CSP');
  } finally { await g.stop(); }
});

/* ---------------- Security patch 2: stub children on loopback ports ---------------- */

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
function call(port, method, urlPath, headers = {}) {
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

const SECURITY_HEADERS = ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'x-robots-tag'];
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
    // Default settings (CLIENT_IP_SOURCE=xff-rightmost, 2 hops), whatever this shell's environment says.
    const app = await createGateway({ onboardPort: ports.onboard, interviewPort: ports.interview, labsPort: ports.labs, ready, config: gatewayConfig({}), log: () => {} });
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
        const r = await call(gwPort, 'GET', p, { [h]: '1.2.3.4' });
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
      const r = await call(gwPort, 'GET', p, { 'x-forwarded-for': '1.2.3.4' });
      assert.ok(r.status === 404 || !(r.headers['content-type'] ?? '').includes('json') || json(r)?.child === undefined, `${p} proxied (${r.status})`);
    }
    const reached = onboard.seen.slice(before).map((s) => s.url);
    assert.ok(reached.every((u) => !/internal/i.test(decodeURIComponent(u))), `forwarded: ${reached.join(', ')}`);
  });

  test('bare loopback caller (no edge header) reaches the internal route', async () => {
    const r = await call(gwPort, 'GET', '/api/internal/identity/session');
    assert.equal(r.status, 200);
    assert.equal(json(r).child, 'onboard');
    const l = await call(gwPort, 'GET', '/labs/redteam/internal/v1/x');
    assert.equal(l.status, 200);
    assert.equal(json(l).child, 'labs');
  });

  test('client-IP header is always the gateway\'s: client value ignored, junk → socket, client-sent edge headers ignored by default', async () => {
    const spoofed = json(await call(gwPort, 'GET', '/api/x', { [CLIENT_IP_HEADER]: '9.9.9.9' }));
    assert.equal(spoofed.clientIp, '127.0.0.1', 'client-supplied header overwritten with the socket IP');
    const xff = json(await call(gwPort, 'GET', '/api/x', { 'x-forwarded-for': '1.2.3.4, 10.0.0.1', [CLIENT_IP_HEADER]: '9.9.9.9' }));
    assert.equal(xff.clientIp, '1.2.3.4');
    const junk = json(await call(gwPort, 'GET', '/labs/x', { 'x-forwarded-for': 'not-an-ip' }));
    assert.equal(junk.clientIp, '127.0.0.1');
    // CF-Connecting-IP / True-Client-IP can be written by the visitor: by default (xff-rightmost) they
    // never decide the address, on any route (TR-02); CLIENT_IP_SOURCE opts into one (next test).
    const cf = json(await call(gwPort, 'GET', '/ar/x', { 'cf-connecting-ip': '5.5.5.5', 'true-client-ip': '6.6.6.6', 'x-forwarded-for': '1.2.3.4' }));
    assert.equal(cf.clientIp, '1.2.3.4');
    const tc = json(await call(gwPort, 'GET', '/v1/x', { 'true-client-ip': '6.6.6.6', 'x-forwarded-for': '1.2.3.4' }));
    assert.equal(tc.clientIp, '1.2.3.4');
    // The pure function agrees with the wire behaviour, including IPv6 literals.
    assert.equal(clientIpOf({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '2001:db8::1' } }), '2001:db8::1');
    assert.equal(clientIpOf({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': ['7.7.7.7'] } }), '127.0.0.1');
    assert.equal(clientIpOf({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': ['7.7.7.7'] } }, { source: 'cf-connecting-ip', hops: 2 }), '7.7.7.7');
  });

  test('CLIENT_IP_SOURCE=cf-connecting-ip / true-client-ip: that header decides, for proxied routes and the labs child alike', async () => {
    for (const [source, want] of [['cf-connecting-ip', '5.5.5.5'], ['true-client-ip', '6.6.6.6']]) {
      const app = await createGateway({ onboardPort: ports.onboard, interviewPort: ports.interview, labsPort: ports.labs, ready, config: gatewayConfig({ CLIENT_IP_SOURCE: source }), log: () => {} });
      const srv = http.createServer(app);
      const port = await listen(srv);
      try {
        for (const p of ['/api/x', '/labs/x', '/ar/x', '/v1/x']) {
          const r = json(await call(port, 'GET', p, { 'cf-connecting-ip': '5.5.5.5', 'true-client-ip': '6.6.6.6', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }));
          assert.equal(r.clientIp, want, `${source} ${p}`);
        }
      } finally { await close(srv); }
    }
  });

  test('security headers on every kind of response: SPA, proxied, 404, upstream 500, gateway 500', async () => {
    for (const p of ['/', '/labs/', '/ar/', '/interview-prep/', '/healthz', '/readyz']) assertSecurityHeaders(await call(gwPort, 'GET', p), p);
    const notFound = await call(gwPort, 'POST', '/no-such-route');
    assert.equal(notFound.status, 404);
    assert.equal(json(notFound).error.code, 'NOT_FOUND');
    assertSecurityHeaders(notFound, 'POST 404');
    const upstream500 = await call(gwPort, 'GET', '/labs/error');
    assert.equal(upstream500.status, 500);
    assertSecurityHeaders(upstream500, 'upstream 500');
    // In-process fallback whose handler throws: the gateway's own error handler answers, JSON only.
    const boom = await createGateway({ onboardPort: ports.onboard, interviewPort: ports.interview, ready, labsApp: (_req, _res, next) => next(new Error('boom')), arApp: (_req, _res, next) => next(new Error('boom')) });
    const srv = http.createServer(boom);
    const port = await listen(srv);
    try {
      const r = await call(port, 'GET', '/labs/anything');
      assert.equal(r.status, 500);
      assert.equal(r.headers['content-type'].split(';')[0], 'application/json');
      // Under /labs the gateway's own errors are flat (the lab clients show `error` / `message` as text, UI-1).
      assert.equal(json(r).code, 'INTERNAL');
      assert.equal(typeof json(r).error, 'string');
      assert.ok(json(r).requestId);
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
    const down = await call(gwPort, 'GET', '/labs/x');
    assert.equal(down.headers['proxy-authenticate'], undefined, 'child hop-by-hop header relayed to the client');
    assert.equal(down.headers['x-child'], 'labs', 'ordinary child headers still relayed');
    assert.equal(upstreamHeaders['x-forwarded-host'], `127.0.0.1:${gwPort}`);
    assert.equal(upstreamHeaders['x-forwarded-proto'], 'https');
  });

  test('healthz and readyz: 503 when degraded; readyz reports all three children', async () => {
    const r = await call(gwPort, 'GET', '/readyz');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(json(r).status).sort(), ['interview', 'labs', 'onboard']);
    state.degraded = true;
    try {
      const h = await call(gwPort, 'GET', '/healthz');
      assert.equal(h.status, 503);
      assert.deepEqual(json(h), { ok: false });
    } finally { state.degraded = false; }
    assert.equal((await call(gwPort, 'GET', '/healthz')).status, 200);
    state.labs = false; state.status.labs = 'starting';
    try { assert.equal((await call(gwPort, 'GET', '/readyz')).status, 503, 'labs not ready → readyz 503'); } finally { state.labs = true; state.status.labs = 'ready'; }
  });

  test('labs child down → /labs and /ar answer 503 UPSTREAM_UNAVAILABLE while /api still proxies', async () => {
    state.labs = false; state.status.labs = 'down';
    try {
      for (const p of ['/labs/api/x', '/ar/api/x']) {
        const r = await call(gwPort, 'GET', p);
        assert.equal(r.status, 503, p);
        assert.equal(r.headers['retry-after'], '5');
        // The lab mounts' flat shape (UI-1): code and request id beside the human message.
        assert.equal(json(r).code, 'UPSTREAM_UNAVAILABLE');
        assert.ok(json(r).requestId);
      }
      assert.equal(json(await call(gwPort, 'GET', '/api/x')).child, 'onboard');
    } finally { state.labs = true; state.status.labs = 'ready'; }
    // Never been ready: STARTING.
    state.labs = false; state.status.labs = 'starting';
    try { assert.equal(json(await call(gwPort, 'GET', '/labs/api/x')).code, 'STARTING'); } finally { state.labs = true; state.status.labs = 'ready'; }
    // Marked ready but the port refuses connections (crashed between probes): UPSTREAM_UNAVAILABLE too.
    await close(labs.server);
    try {
      const r = await call(gwPort, 'GET', '/labs/api/x');
      assert.equal(r.status, 503);
      assert.equal(json(r).code, 'UPSTREAM_UNAVAILABLE');
    } finally { ports.labs = await new Promise((res) => labs.server.listen(ports.labs, '127.0.0.1', () => res(ports.labs))); }
  });

  test('SSE streams through the proxy: two events 100 ms apart both arrive before the end', async () => {
    const r = await call(gwPort, 'GET', '/labs/sse');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/event-stream');
    assert.ok(r.body.includes('event: a') && r.body.includes('event: b'));
    const firstA = r.chunks.find((c) => c.text.includes('event: a')).at;
    const firstB = r.chunks.find((c) => c.text.includes('event: b')).at;
    assert.ok(firstB - firstA >= 50, `events buffered together (a at ${firstA} ms, b at ${firstB} ms)`);
    assert.ok(firstA < r.endedAt - 50, 'first event arrived well before the response ended');
  });

  test('x-request-id: always minted by the gateway (a client-supplied id is never kept); forwarded and echoed', async () => {
    const fresh = await call(gwPort, 'GET', '/api/x');
    assert.match(fresh.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(json(fresh).requestId, fresh.headers['x-request-id'], 'child received the same id');
    // The APIs trust a well-formed inbound id for log correlation, so a client must not be able to choose it.
    const supplied = await call(gwPort, 'GET', '/api/x', { 'x-request-id': 'req_abcdef123456' });
    assert.match(supplied.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.notEqual(supplied.headers['x-request-id'], 'req_abcdef123456');
    assert.equal(json(supplied).requestId, supplied.headers['x-request-id'], 'child received the minted id, not the client one');
    const junk = await call(gwPort, 'GET', '/api/x', { 'x-request-id': 'bad id\twith spaces' });
    assert.match(junk.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    const err = await call(gwPort, 'GET', '/api/internal/x', { 'x-forwarded-for': '1.1.1.1', 'x-request-id': 'req_abcdef123456' });
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

/* ---------------- Merged: the labs child behind the gateway ---------------- */

describe('labs child behind the gateway: the same protections as the APIs, its own CSP for its pages', () => {
  const TARGET_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms";
  const seen = [];
  /** Stands in for deploy/labs-child.mjs: the same front (trust proxy loopback + the gateway's IP stamp as X-Forwarded-For). */
  const child = express();
  child.set('trust proxy', 'loopback');
  child.use(gatewayIpToForwardedFor(CLIENT_IP_HEADER));
  child.use((req, res, next) => {
    const entry = { method: req.method, url: req.originalUrl, headers: req.headers, body: '', complete: false, ip: req.ip };
    seen.push(entry);
    req.setEncoding('utf8');
    req.on('data', (c) => { entry.body += c; });
    req.on('end', () => { entry.complete = true; next(); });
  });
  child.get('/labs/redteam/target-frame.html', (_req, res) => { res.set({ 'content-security-policy': TARGET_FRAME_CSP, 'cache-control': 'no-store', 'content-type': 'text/html' }).send('<p>frame</p>'); });
  child.get('/labs/hang', () => { /* never answers */ });
  child.get('/labs/stream', (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n'); setTimeout(() => res.end('event: done\ndata: {}\n\n'), 400); });
  child.use((req, res) => res.json({ url: req.originalUrl, ip: req.ip, clientIp: req.headers[CLIENT_IP_HEADER] ?? null, requestId: req.headers['x-request-id'] ?? null }));
  const childServer = http.createServer(child);
  let gw;
  let gwPort;
  const state = { onboard: true, interview: true, labs: true, degraded: false, status: { onboard: 'ready', interview: 'ready', labs: 'ready' } };

  before(async () => {
    const labsPort = await listen(childServer);
    const app = await createGateway({ onboardPort: labsPort, interviewPort: labsPort, labsPort, ready: () => state, config: { ...gatewayConfig({}), maxBodyBytes: 1000, upstreamIdleMs: 200 }, log: () => {} });
    gw = http.createServer(app);
    gwPort = await listen(gw);
  });
  after(async () => { await close(gw); await close(childServer); });

  test('the visitor IP reaches the child as its req.ip and its IP header; client-written entries and edge headers do not', async () => {
    for (const p of ['/labs/api/me', '/ar/api/me', '/labs/soc/api/cases']) {
      const r = await request(gwPort, p, { headers: { 'x-forwarded-for': '8.8.8.8, 198.51.100.7, 104.22.17.40', 'cf-connecting-ip': '7.7.7.7', 'true-client-ip': '6.6.6.6', 'x-real-ip': '5.5.5.5', forwarded: 'for=4.4.4.4', [CLIENT_IP_HEADER]: '3.3.3.3' } });
      const body = JSON.parse(r.body);
      assert.equal(body.ip, '198.51.100.7', `${p} req.ip`);
      assert.equal(body.clientIp, '198.51.100.7', `${p} ${CLIENT_IP_HEADER}`);
      const got = seen.at(-1).headers;
      for (const h of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'forwarded']) assert.equal(got[h], undefined, `${p}: ${h} forwarded`);
      assert.equal(got['x-forwarded-for'], '198.51.100.7');
    }
  });

  test('a chunked GET/DELETE body reaches the labs child as exactly one request (no smuggling into /labs or /ar)', async () => {
    for (const [method, p] of [['GET', '/labs/front'], ['DELETE', '/ar/front']]) {
      const before = seen.length;
      await raw(gwPort, `${method} ${p} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk(SMUGGLED)}`);
      await wait(100);
      assert.deepEqual(seen.slice(before).map((s) => `${s.method} ${s.url}`), [`${method} ${p}`]);
      assert.equal(seen.at(-1).body, SMUGGLED);
    }
  });

  test('body cap (declared and streamed), compressed bodies and bad framing are refused before the labs child, with the request id', async () => {
    const before = seen.length;
    const big = await request(gwPort, '/labs/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2000) });
    assert.equal(big.status, 413);
    assert.equal(JSON.parse(big.body).code, 'PAYLOAD_TOO_LARGE');
    assert.equal(JSON.parse(big.body).requestId, big.headers['x-request-id']);
    const gz = await request(gwPort, '/ar/v1/attempts', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: '{}' });
    assert.equal(gz.status, 415);
    assert.equal(JSON.parse(gz.body).requestId, gz.headers['x-request-id']);
    const both = await raw(gwPort, `POST /labs/x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n${chunk('hello')}`);
    assert.match(both, /^HTTP\/1\.1 400/);
    assert.equal(seen.length, before, 'none of them reached the labs child');
    const grown = await raw(gwPort, `POST /labs/stream-up HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n258\r\n${'y'.repeat(600)}\r\n258\r\n${'y'.repeat(600)}\r\n0\r\n\r\n`, 1500);
    assert.match(grown, /^HTTP\/1\.1 413/);
    await wait(100);
    assert.ok(seen.slice(before).every((s) => !s.complete), 'the labs child never sees a complete over-cap request');
  });

  test('a hung labs request gets 504 after the idle timeout; a lab event stream is exempt', async () => {
    const r = await request(gwPort, '/labs/hang');
    assert.equal(r.status, 504);
    assert.equal(JSON.parse(r.body).code, 'UPSTREAM_TIMEOUT');
    assert.equal(JSON.parse(r.body).error, 'Lab Simulations took too long to answer. Try again in a moment.');
    const s = await request(gwPort, '/labs/stream');
    assert.match(s.body, /event: done/);
  });

  test('the child\'s CSP wins for its own pages (Red Team target frame); other lab responses get the platform CSP', async () => {
    const frame = await request(gwPort, '/labs/redteam/target-frame.html');
    assert.equal(frame.status, 200);
    assert.equal(frame.headers['content-security-policy'], TARGET_FRAME_CSP);
    assert.equal(frame.headers['cache-control'], 'no-store');
    assert.equal(frame.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains', 'the other security headers still apply');
    const page = await request(gwPort, '/labs/catalog');
    assert.equal(page.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
  });

  test('one CSP source of truth: CSP_DIRECTIVES (what tools/gen-headers.mjs renders) is the header the gateway sends', () => {
    assert.equal(CSP_DIRECTIVES.join('; '), CONTENT_SECURITY_POLICY);
    const parsed = extractGatewayHeaders(fs.readFileSync(path.join(ROOT, 'deploy/gateway.mjs'), 'utf8'));
    assert.equal(parsed['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
    assert.ok(!/connect-src[^;]*data:/.test(parsed['Content-Security-Policy']), 'connect-src never allows data:');
  });
});

/* ---------------- Merge review UI-1, UI-2, M-BIZ-1: the labs child not answering ---------------- */

describe('labs child not answering: lab clients get text they can show, lab pages get a page (never raw JSON)', () => {
  /** What a browser sends for an address-bar load or a reload. */
  const PAGE = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' };
  const seen = [];
  const child = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/labs/hang' || req.url === '/labs/soc/hang') return; // never answers
    if (/\/api\//.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, url: req.url })); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>lab</title><p>lab page ${req.url}</p>`);
  });
  const api = stubChild('api');
  const state = { onboard: true, interview: true, labs: true, degraded: false, status: { onboard: 'ready', interview: 'ready', labs: 'ready' } };
  const ready = () => ({ ...state, status: { ...state.status } });
  const setLabs = (s) => { state.status.labs = s; state.labs = s === 'ready'; };
  let labsPort;
  let apiPort;
  const servers = [];
  /** A gateway in front of the stub children; pageHoldMs and the idle timeout per test. */
  async function gateway(config) {
    const app = await createGateway({ onboardPort: apiPort, interviewPort: apiPort, labsPort, ready, config: { ...gatewayConfig({}), upstreamIdleMs: 300, ...config }, log: () => {} });
    const srv = http.createServer(app);
    servers.push(srv);
    return listen(srv);
  }
  // How each lab client turns an error body into the text it shows (threatready-lab-001 api.ts, red_team_lab
  // api.ts, soc api.js messageOf, attack-reasoning api.ts).
  const shown = {
    labs: (j) => j.error || 'busyMessage()',
    redteam: (j) => j.message || j.error,
    soc: (j) => j.message || j.error,
    ar: (j) => (typeof j.error === 'string' ? j.error : 'fallback'),
  };

  before(async () => { labsPort = await listen(child); apiPort = await listen(api.server); });
  after(async () => { for (const s of servers) await close(s); await close(child); await close(api.server); setLabs('ready'); });

  test('UI-1: a 503 on /labs and /ar API paths has a string `error` and `message` (the lab\'s own copy), the code and request id beside them', async () => {
    const port = await gateway({ pageHoldMs: 0 });
    const cases = [
      ['/labs/api/catalog', 'Lab Simulations is briefly unavailable. Try again in 5 seconds.', 'labs'],
      ['/labs/api/runs/r1/actions', 'Lab Simulations is briefly unavailable. Try again in 5 seconds.', 'labs'],
      ['/labs/redteam/api/me', 'The Web Pentest Lab is briefly unavailable. Try again in 5 seconds.', 'redteam'],
      ['/labs/soc/api/levels', 'The SOC simulation is briefly unavailable. Try again in 5 seconds.', 'soc'],
      ['/ar/api/me', 'Attack Reasoning is briefly unavailable. Try again in 5 seconds.', 'ar'],
    ];
    for (const [st, code] of [['down', 'UPSTREAM_UNAVAILABLE'], ['starting', 'STARTING']]) {
      setLabs(st);
      try {
        for (const [p, text, client] of cases) {
          // fetch() sends Accept: */* by default; some clients ask for JSON.
          for (const accept of [undefined, '*/*', 'application/json']) {
            const r = await call(port, 'GET', p, accept ? { accept } : {});
            const j = json(r);
            assert.equal(r.status, 503, `${st} ${p}`);
            assert.match(r.headers['content-type'], /^application\/json/);
            assert.equal(r.headers['retry-after'], '5');
            assert.deepEqual(j, { error: text, message: text, code, retryable: true, requestId: r.headers['x-request-id'] }, `${st} ${p}`);
            assert.equal(shown[client](j), text, `${client} client shows the text, never [object Object]`);
          }
        }
        // POSTs are API calls too, whatever they accept.
        const post = await call(port, 'POST', '/labs/api/runs', PAGE);
        assert.equal(json(post).error, 'Lab Simulations is briefly unavailable. Try again in 5 seconds.');
      } finally { setLabs('ready'); }
    }
  });

  test('UI-1: /api and /v1 keep the APIs\' envelope (their clients parse error.code)', async () => {
    const port = await gateway({ pageHoldMs: 0 });
    state.status.onboard = 'down'; state.status.interview = 'starting';
    try {
      const a = json(await call(port, 'GET', '/api/me'));
      assert.equal(a.error.code, 'UPSTREAM_UNAVAILABLE');
      assert.equal(typeof a.error.message, 'string');
      const v = await call(port, 'GET', '/v1/me', PAGE);
      assert.equal(v.status, 503);
      assert.match(v.headers['content-type'], /^application\/json/, 'an API path never gets the HTML page');
      assert.equal(json(v).error.code, 'STARTING');
    } finally { state.status.onboard = 'ready'; state.status.interview = 'ready'; }
  });

  test('UI-1: a refused connection and a 504 under /labs are flat too; the SOC client reads the 504 text', async () => {
    const port = await gateway({ pageHoldMs: 0 });
    const t = await call(port, 'GET', '/labs/soc/hang');
    assert.equal(t.status, 504);
    assert.deepEqual(json(t), { error: 'The SOC simulation took too long to answer. Try again in a moment.', message: 'The SOC simulation took too long to answer. Try again in a moment.', code: 'UPSTREAM_TIMEOUT', retryable: true, requestId: t.headers['x-request-id'] });
    await close(child);
    try {
      const r = await call(port, 'GET', '/labs/redteam/api/catalog');
      assert.equal(r.status, 503);
      assert.equal(shown.redteam(json(r)), 'The Web Pentest Lab is briefly unavailable. Try again in 5 seconds.');
      assert.equal(json(r).code, 'UPSTREAM_UNAVAILABLE');
    } finally { await new Promise((res) => child.listen(labsPort, '127.0.0.1', res)); }
  });

  test('UI-2: a lab page loaded while the labs child is down or starting gets a styled page that reloads itself (no JSON, no script)', async () => {
    const port = await gateway({ pageHoldMs: 0 });
    for (const [st, heading] of [['down', 'is restarting'], ['starting', 'is starting']]) {
      setLabs(st);
      try {
        for (const [p, product] of [['/labs/', 'Lab Simulations'], ['/labs/tracks/blue-team', 'Lab Simulations'], ['/labs/soc/', 'The SOC simulation'], ['/labs/redteam/', 'The Web Pentest Lab'], ['/labs/devsecops/', 'The DevSecOps lab'], ['/ar/', 'Attack Reasoning'], ['/ar/attempts/abc?x=1', 'Attack Reasoning']]) {
          const r = await call(port, 'GET', p, PAGE);
          assert.equal(r.status, 503, `${st} ${p}`);
          assert.match(r.headers['content-type'], /^text\/html/, `${st} ${p}`);
          assert.equal(r.headers['retry-after'], '5');
          assert.equal(r.headers['cache-control'], 'no-store');
          assert.equal(r.headers['content-security-policy'], CONTENT_SECURITY_POLICY, 'the platform CSP holds (no script on the page)');
          assert.ok(r.body.includes(`<h1>${product} ${heading}</h1>`), `${st} ${p}: ${r.body.slice(0, 120)}`);
          assert.ok(r.body.includes('This page reloads in 5 seconds.'));
          assert.ok(r.body.includes('<meta http-equiv="refresh" content="5">'));
          assert.ok(r.body.includes(`<a class="btn primary" href="${p.replace(/&/g, '&amp;')}">Retry</a>`), 'Retry reloads the same page');
          assert.ok(!/<script/i.test(r.body), 'no script');
          assert.ok(!r.body.includes('"error"'), 'never the JSON envelope');
          assert.ok(r.body.includes('#0b1020'), 'dark by default');
        }
        // The learner's theme choice (the platform's tr-theme cookie) is kept.
        const light = await call(port, 'GET', '/labs/', { ...PAGE, cookie: 'a=1; tr-theme=light' });
        assert.ok(light.body.includes('color-scheme:light') && light.body.includes('#ffffff'));
        // HEAD gets the same status without a body.
        const head = await call(port, 'HEAD', '/labs/', PAGE);
        assert.equal(head.status, 503);
        assert.equal(head.body, '');
      } finally { setLabs('ready'); }
    }
    // Once the child answers, the same request is the lab's page.
    const ok = await call(port, 'GET', '/labs/', PAGE);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /lab page \/labs\//);
  });

  test('UI-2: a lab page whose connection is refused or times out gets the page too (503 restarting / 504 took too long)', async () => {
    const port = await gateway({ pageHoldMs: 0 });
    const slow = await call(port, 'GET', '/labs/hang', PAGE);
    assert.equal(slow.status, 504);
    assert.match(slow.headers['content-type'], /^text\/html/);
    assert.ok(slow.body.includes('<h1>Lab Simulations took too long to answer</h1>'));
    await close(child);
    try {
      const r = await call(port, 'GET', '/labs/redteam/', PAGE);
      assert.equal(r.status, 503);
      assert.ok(r.body.includes('<h1>The Web Pentest Lab is restarting</h1>'));
    } finally { await new Promise((res) => child.listen(labsPort, '127.0.0.1', res)); }
  });

  test('UI-2: the page escapes the URL it links back to', () => {
    const page = labUnavailablePage({ originalUrl: '/labs/"><img src=x onerror=alert(1)>', headers: {} }, 'UPSTREAM_UNAVAILABLE');
    assert.ok(!page.includes('<img src=x'), 'markup from the URL is not rendered');
    assert.ok(page.includes('href="/labs/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'));
  });

  test('M-BIZ-1: a lab page requested while the labs child starts waits for it and gets the lab (as before the split); API calls do not wait', async () => {
    const port = await gateway({ pageHoldMs: 3000 });
    for (const st of ['starting', 'down']) {
      setLabs(st);
      const before = seen.length;
      const t0 = Date.now();
      const flip = setTimeout(() => setLabs('ready'), 600);
      const api = call(port, 'GET', '/labs/api/catalog');
      const page = call(port, 'GET', '/ar/', PAGE);
      const a = await api;
      assert.equal(a.status, 503, `${st}: the API call is answered at once`);
      assert.ok(Date.now() - t0 < 400, `${st}: API call not held (${Date.now() - t0} ms)`);
      const r = await page;
      clearTimeout(flip);
      assert.equal(r.status, 200, `${st}: the held page reached the lab`);
      assert.match(r.body, /lab page \/ar\//);
      assert.ok(Date.now() - t0 >= 550, `${st}: it waited for the child`);
      assert.deepEqual(seen.slice(before), ['/ar/'], 'the child saw the page request once, after it was ready');
    }
    // Still not up when the hold ends: the page (not JSON), after about pageHoldMs.
    const short = await gateway({ pageHoldMs: 500 });
    setLabs('down');
    try {
      const t0 = Date.now();
      const r = await call(short, 'GET', '/labs/', PAGE);
      assert.equal(r.status, 503);
      assert.match(r.headers['content-type'], /^text\/html/);
      assert.ok(Date.now() - t0 >= 450, 'held for pageHoldMs first');
    } finally { setLabs('ready'); }
  });

  test('M-BIZ-1: a visitor who leaves while the page is held is never forwarded', async () => {
    const port = await gateway({ pageHoldMs: 3000 });
    setLabs('starting');
    const before = seen.length;
    try {
      await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/labs/', headers: PAGE });
        req.on('error', () => resolve());
        req.end();
        setTimeout(() => { req.destroy(); resolve(); }, 200);
      });
      await wait(100);
      setLabs('ready');
      await wait(500);
      assert.deepEqual(seen.slice(before), [], 'nothing reached the child for the abandoned request');
    } finally { setLabs('ready'); }
  });
});
