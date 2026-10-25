// ThreatReady single-origin gateway. Every app behind one URL, so one session cookie signs the user
// in everywhere without a custom domain (onrender.com is a public suffix: its subdomains can't share
// cookies).
//
//   /                 onboard SPA (sign-in, home, profile, admin)        static
//   /api/*            onboard API (NestJS, child process)                proxied
//   /interview-prep/  InterviewPrep SPA                                  static
//   /v1/*             InterviewPrep API (NestJS, child process)          proxied
//   /labs/*           Lab Simulations (Express, in this process)
//   /ar/*             Attack Reasoning Lab (Express, in this process)
//
// Internal endpoints (identity, summaries, AI usage) answer loopback callers only.
// Settings (all optional, see deploy/README.md): CLIENT_IP_SOURCE, TRUSTED_PROXY_HOPS,
// GATEWAY_MAX_BODY_BYTES, GATEWAY_UPSTREAM_TIMEOUT_MS, GATEWAY_BOOT_HEALTH.
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
/** Header the gateway sets with the visitor's IP; the APIs read only this one (CLIENT_IP_HEADER). */
export const CLIENT_IP_HEADER = 'x-threatready-client-ip';
const loopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
/**
 * Headers an edge (Render, Cloudflare) adds to every request it forwards. Behind Render the socket
 * peer is always loopback, so the socket check alone cannot tell an internet request from a
 * server-to-server call; the apps' own internal calls (plain http to 127.0.0.1) carry none of these.
 */
const EDGE_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'cf-connecting-ip', 'true-client-ip', 'cf-ray', 'rndr-id', 'x-real-ip', 'forwarded', 'via'];
const internalCaller = (req) => loopback(req) && !EDGE_HEADERS.some((h) => req.headers[h] !== undefined);
/** /api/internal/*, /labs/internal/*, /ar/internal/* and any sub-mounted lab's /internal/ segment. */
const INTERNAL_PATH = /^\/(api|labs|ar)(\/.*)?\/internal(\/|$)/i;
/** Hop-by-hop headers (RFC 9110 §7.6.1) are for one connection only; never forwarded either way. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
/** Client-address headers from the edge or the client: the children get CLIENT_IP_HEADER instead. */
const IP_HEADERS = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'forwarded'];

/* ---------------- Settings ---------------- */

/** Where the visitor's IP comes from. xff-rightmost: Render (deploy/README.md, "Client IP"). */
export const CLIENT_IP_SOURCES = ['xff-rightmost', 'cf-connecting-ip', 'true-client-ip', 'socket'];
/**
 * How long /healthz reports "starting" (503) after boot. wait: until the migrations are done and both
 * APIs have answered once; migrations: only while the migrations run (the APIs then start behind a 200);
 * auto (default): wait on a release's first boot (a deploy of new code or settings), migrations on a
 * restart or wake of a release that has booted before (deploy/README.md, "Health check").
 */
export const BOOT_HEALTH_MODES = ['auto', 'wait', 'migrations'];

/**
 * Gateway settings from the environment. A malformed value throws (the launcher then exits and the
 * deploy fails) rather than silently trusting the wrong header or dropping a limit. "0" turns the
 * body cap or the upstream timeout off.
 */
export function gatewayConfig(env = process.env) {
  const source = (env.CLIENT_IP_SOURCE || 'xff-rightmost').trim().toLowerCase();
  if (!CLIENT_IP_SOURCES.includes(source)) throw new Error(`CLIENT_IP_SOURCE must be one of ${CLIENT_IP_SOURCES.join(', ')} (got "${env.CLIENT_IP_SOURCE}")`);
  const bootHealth = (env.GATEWAY_BOOT_HEALTH || 'auto').trim().toLowerCase();
  if (!BOOT_HEALTH_MODES.includes(bootHealth)) throw new Error(`GATEWAY_BOOT_HEALTH must be one of ${BOOT_HEALTH_MODES.join(', ')} (got "${env.GATEWAY_BOOT_HEALTH}")`);
  const int = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
    return n;
  };
  return {
    // Render: Cloudflare's edge appends the client, then Render's proxy appends the edge: 2 hops.
    clientIp: { source, hops: int('TRUSTED_PROXY_HOPS', 2, 1, 10) },
    // Largest legitimate body is an InterviewPrep upload (6 MB file + multipart framing).
    maxBodyBytes: int('GATEWAY_MAX_BODY_BYTES', 15 * 1024 * 1024, 0, 2 ** 31),
    // Idle time (no bytes either way) before a proxied request is abandoned; event streams are exempt.
    upstreamIdleMs: int('GATEWAY_UPSTREAM_TIMEOUT_MS', 180_000, 0, 3_600_000),
    bootHealth,
  };
}

/* ---------------- Client IP ---------------- */

/** A header or X-Forwarded-For entry as a bare IP literal ('' if it is not one): port, brackets and IPv4-mapped prefix removed. */
export function ipLiteral(value) {
  let s = String(value ?? '').trim();
  if (s.startsWith('[')) s = s.slice(1, s.includes(']') ? s.indexOf(']') : undefined);
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(s)) s = s.slice(7);
  return net.isIP(s) ? s : '';
}
const single = (v) => (Array.isArray(v) ? v[0] : v);
/** X-Forwarded-For entries, left (claimed by the client) to right (appended by the last proxy). Node joins repeated headers with ", ". */
const forwardedChain = (req) => {
  const raw = req.headers['x-forwarded-for'];
  return (Array.isArray(raw) ? raw.join(',') : raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
};

/**
 * The visitor's IP, decided once per request and written over whatever the client sent in
 * CLIENT_IP_HEADER, so every route (proxied or in-process) keys its limits on it.
 *  - xff-rightmost (default): the X-Forwarded-For entry `hops` places from the right. Proxies append,
 *    never reset, so everything left of the entries our own proxies added is client-written; with
 *    fewer entries than hops the left-most one (the farthest proxy's view) is used.
 *  - cf-connecting-ip / true-client-ip: that header, only for an edge that always overwrites it.
 *  - socket: the TCP peer (no proxy in front).
 * Anything that is not an IP literal falls back to the socket address.
 */
export function clientIpOf(req, { source = 'xff-rightmost', hops = 2 } = {}) {
  const socketIp = ipLiteral(req.socket?.remoteAddress) || req.socket?.remoteAddress || '';
  if (source === 'socket') return socketIp;
  if (source === 'cf-connecting-ip' || source === 'true-client-ip') return ipLiteral(single(req.headers[source])) || socketIp;
  const chain = forwardedChain(req);
  if (!chain.length) return socketIp;
  return ipLiteral(chain[Math.max(0, chain.length - hops)]) || socketIp;
}

/**
 * Operator check of TRUSTED_PROXY_HOPS (no address is logged): on requests that carry both headers,
 * where in X-Forwarded-For is Cloudflare's CF-Connecting-IP? Behind Render it should sit `hops` from
 * the right. Logs after the first such request and once more after `sample` of them, then stops.
 */
function hopCheck(cfg, log, sample = 50) {
  const positions = new Map();
  let n = 0;
  const summary = () => {
    const [best] = [...positions.entries()].sort((a, b) => b[1] - a[1]);
    const where = [...positions.entries()].map(([k, c]) => `${k ? `${k} from the right` : 'not present'}: ${c}`).join(', ');
    const warn = cfg.source === 'xff-rightmost' && best && best[0] > 0 && best[0] !== cfg.hops
      ? ` WARNING: client IPs look wrong; set TRUSTED_PROXY_HOPS=${best[0]} (or CLIENT_IP_SOURCE=cf-connecting-ip).` : '';
    log(`client IP: CLIENT_IP_SOURCE=${cfg.source} TRUSTED_PROXY_HOPS=${cfg.hops}; CF-Connecting-IP position in X-Forwarded-For over ${n} request(s): ${where}.${warn}`);
  };
  return (req) => {
    if (n >= sample) return;
    const cf = ipLiteral(single(req.headers['cf-connecting-ip']));
    const chain = forwardedChain(req);
    if (!cf || !chain.length) return;
    const at = chain.map(ipLiteral).lastIndexOf(cf);
    const fromRight = at < 0 ? 0 : chain.length - at;
    positions.set(fromRight, (positions.get(fromRight) ?? 0) + 1);
    n += 1;
    if (n === 1 || n === sample) summary();
  };
}

/* ---------------- Proxy to the child APIs ---------------- */

const fail = (res, status, code, message, extra = {}) => res.status(status).set(extra).json({ error: { code, message, retryable: status >= 500 } });
const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Request headers for a child: hop-by-hop and Connection-nominated names removed, then the gateway's own set last. */
function forwardHeaders(req) {
  const headers = { ...req.headers };
  const nominated = String(req.headers.connection ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const h of [...HOP_BY_HOP, ...nominated, ...IP_HEADERS, 'content-length', 'expect']) delete headers[h];
  // Written after the deletes, so a client cannot drop them by naming them in Connection.
  headers.host = req.headers.host ?? '';
  headers[CLIENT_IP_HEADER] = req.headers[CLIENT_IP_HEADER];
  headers['x-forwarded-for'] = req.headers[CLIENT_IP_HEADER];
  headers['x-forwarded-host'] = req.headers.host ?? '';
  headers['x-forwarded-proto'] = single(req.headers['x-forwarded-proto']) ?? 'https';
  return headers;
}
const responseHeaders = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !HOP_BY_HOP.includes(k)));
const isEventStream = (v) => /text\/event-stream/i.test(String(v ?? ''));

/**
 * Streams a request to a local child process. Framing is re-established here, never inherited: a
 * body is sent with exactly the framing it arrived with (Content-Length, or chunked when it came
 * chunked), whatever the method, and a request without one sends none. Stripping the framing headers
 * and piping the rest would let a GET/DELETE body reach the child as a second, unchecked request.
 * Bodies over the cap are refused (413) before the child sees a complete request. Requests time out
 * after `upstreamIdleMs` without traffic, except event streams (Accept or response text/event-stream).
 */
function proxyTo(port, readiness, cfg) {
  return (req, res) => {
    if (!readiness()) {
      fail(res, 503, 'STARTING', 'ThreatReady is starting up. Try again in a few seconds.', { 'Retry-After': '5' });
      return;
    }
    // req.headers[CLIENT_IP_HEADER] was stamped by the gateway's first middleware (never the client's).
    const headers = forwardHeaders(req);
    const chunked = req.headers['transfer-encoding'] !== undefined;
    const length = chunked ? 0 : Number(req.headers['content-length'] ?? 0);
    if (chunked) headers['transfer-encoding'] = 'chunked';
    else if (req.headers['content-length'] !== undefined) headers['content-length'] = String(length);
    const stream = isEventStream(req.headers.accept);
    let refused = false;
    let answered = false;
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.originalUrl, headers }, (up) => {
      if (isEventStream(up.headers['content-type'])) upstream.setTimeout(0);
      up.on('end', () => { answered = true; });
      res.writeHead(up.statusCode ?? 502, responseHeaders(up.headers));
      up.pipe(res);
    });
    if (cfg.upstreamIdleMs && !stream) {
      upstream.setTimeout(cfg.upstreamIdleMs, () => upstream.destroy(Object.assign(new Error('upstream idle'), { code: 'UPSTREAM_TIMEOUT' })));
    }
    upstream.on('error', (err) => {
      // The child's answer already arrived in full (a later write error means it stopped reading the body): keep it.
      if (refused || answered || res.writableEnded || res.destroyed) return;
      // A response already under way can't become an error page: cut it so the client sees it is incomplete.
      if (res.headersSent) { res.destroy(); return; }
      if (err?.code === 'UPSTREAM_TIMEOUT') fail(res, 504, 'UPSTREAM_TIMEOUT', 'ThreatReady took too long to answer. Try again in a moment.', { 'Retry-After': '5' });
      else fail(res, 502, 'UPSTREAM_UNAVAILABLE', 'This part of ThreatReady is restarting. Try again shortly.', { 'Retry-After': '5' });
    });
    // The visitor went away (tab closed, stream aborted): release the child's request too.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    if (!chunked && !(length > 0)) { upstream.end(); return; }

    let received = 0;
    req.on('data', (chunk) => {
      if (refused) return;
      received += chunk.length;
      if (cfg.maxBodyBytes && received > cfg.maxBodyBytes) {
        refused = true;
        upstream.destroy();
        if (res.headersSent) { res.destroy(); return; }
        // Discard what is still in flight for a moment so the client can read the 413, then hang up.
        res.on('finish', () => setTimeout(() => req.destroy(), 1000).unref());
        fail(res, 413, 'PAYLOAD_TOO_LARGE', `This upload is too large. The limit is ${mb(cfg.maxBodyBytes)}.`, { Connection: 'close' });
        return;
      }
      if (!upstream.write(chunk)) req.pause();
    });
    upstream.on('drain', () => req.resume());
    req.on('end', () => { if (!refused) upstream.end(); });
  };
}

/** Static SPA: real files first, otherwise index.html (client-side routes). Hashed assets cached long. */
function spa(dir) {
  const index = path.join(dir, 'index.html');
  const router = express.Router();
  router.use(express.static(dir, {
    index: false,
    setHeaders: (res, file) => res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  }));
  router.get(/.*/, (_req, res) => (fs.existsSync(index) ? res.sendFile(index, { headers: { 'Cache-Control': 'no-cache' } }) : res.status(503).send('Not built')));
  return router;
}

/** The Content-Security-Policy every response gets (an app may narrow it for its own pages). */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
  // blob: only: three.js loads the 3D interviewer's embedded textures with fetch(blob:) (GLTFLoader ->
  // ImageBitmapLoader). No app fetches a data: URL, so data: is not allowed here.
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  'frame-src https://challenges.cloudflare.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export async function createGateway({ onboardPort, interviewPort, ready, labsApp, arApp, config = gatewayConfig(), log = (m) => console.log(`[gateway] ${m}`) }) {
  const app = express();
  app.disable('x-powered-by');
  // For req.protocol / req.hostname only; req.ip is pinned to the gateway's decision below.
  app.set('trust proxy', 1);
  const checkHops = hopCheck(config.clientIp, log);

  // First thing for every request: the client IP header is ours, never the client's. The in-process
  // apps (labs, Attack Reasoning, SOC) see the same address as req.ip, whatever their trust proxy says.
  app.use((req, _res, next) => {
    const ip = clientIpOf(req, config.clientIp);
    req.headers[CLIENT_IP_HEADER] = ip;
    Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true, writable: true });
    checkHops(req);
    next();
  });

  // Message framing, for every route: both Transfer-Encoding and Content-Length (RFC 9112 §6.1: a
  // smuggling attempt), or a transfer coding other than plain chunked, is refused; so is a declared
  // body over the cap. Node's parser rejects most of these too; this does not depend on it.
  app.use((req, res, next) => {
    const te = req.headers['transfer-encoding'];
    const cl = req.headers['content-length'];
    if (te !== undefined && (cl !== undefined || !/^chunked$/i.test(String(te).trim()))) {
      fail(res, 400, 'BAD_REQUEST', 'This request could not be read.', { Connection: 'close' });
      return;
    }
    if (config.maxBodyBytes && cl !== undefined && Number(cl) > config.maxBodyBytes) {
      fail(res, 413, 'PAYLOAD_TOO_LARGE', `This upload is too large. The limit is ${mb(config.maxBodyBytes)}.`, { Connection: 'close' });
      return;
    }
    // Compressed request bodies: browsers never send them, and the apps' JSON parsers would inflate
    // them (body-parser advisory GHSA-27r3-jxmh-p828). Refused here for every app in one place.
    const ce = req.headers['content-encoding'];
    if (ce !== undefined && !/^\s*identity\s*$/i.test(String(ce))) {
      fail(res, 415, 'UNSUPPORTED_ENCODING', 'Compressed request bodies are not accepted.', { Connection: 'close' });
      return;
    }
    next();
  });

  // Security headers for every response (replaces Cloudflare _headers in this deployment).
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), microphone=(self)');
    next();
  });

  // Render health check. 503 while the launcher is still starting (`starting`: migrations, then the
  // APIs' first start), so a deploy whose migration fails or whose API never comes up is not marked
  // live and Render keeps the old instance. After that 200, until a child that was up stays down for a
  // minute (crash loop): 503 again so Render sees it. /readyz has the detail.
  app.get('/healthz', (_req, res) => {
    const r = ready();
    if (r.starting) { res.status(503).set('Retry-After', '5').json({ ok: false, phase: 'starting' }); return; }
    res.status(r.degraded ? 503 : 200).json({ ok: !r.degraded });
  });
  app.get('/readyz', (_req, res) => { const r = ready(); res.status(r.onboard && r.interview ? 200 : 503).json(r); });

  // Internal APIs are for the apps' server-to-server calls only: loopback peer AND no edge headers
  // (behind Render every peer is loopback). Covers /api/internal, /labs/internal, /ar/internal and
  // any /internal/ segment under a sub-mounted lab (e.g. /labs/redteam/internal/...).
  app.use((req, res, next) => (INTERNAL_PATH.test(req.path) && !internalCaller(req) ? res.status(404).json({ error: 'Not found.' }) : next()));

  // Crawler and disclosure files are real files, never the SPA shell.
  const webPublic = path.join(ROOT, 'Threatready-landing-page-main/apps/web/public');
  app.get('/robots.txt', (_req, res) => res.sendFile(path.join(webPublic, 'robots.txt'), { headers: { 'Cache-Control': 'public, max-age=3600' } }));
  // sendFile ignores dot-segments by default; the directory is .well-known, so allow them here.
  app.get('/.well-known/security.txt', (_req, res) => res.type('text/plain').sendFile(path.join(webPublic, '.well-known/security.txt'), { dotfiles: 'allow', headers: { 'Cache-Control': 'public, max-age=3600' } }));

  app.use('/api', proxyTo(onboardPort, () => ready().onboard, config));
  app.use('/v1', proxyTo(interviewPort, () => ready().interview, config));
  app.use('/labs', labsApp);
  app.use('/ar', arApp);
  app.use('/interview-prep', spa(path.join(ROOT, 'InterviewPrep/apps/web/dist')));
  app.use('/', spa(path.join(ROOT, 'Threatready-landing-page-main/apps/web/dist')));
  return app;
}
