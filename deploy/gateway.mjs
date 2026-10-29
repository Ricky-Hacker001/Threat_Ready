// ThreatReady single-origin gateway. Every app behind one URL, so one session cookie signs the user
// in everywhere without a custom domain (onrender.com is a public suffix: its subdomains can't share
// cookies).
//
//   /                 onboard SPA (sign-in, home, profile, admin)        static
//   /api/*            onboard API (NestJS, child process)                proxied
//   /interview-prep/  InterviewPrep SPA                                  static
//   /v1/*             InterviewPrep API (NestJS, child process)          proxied
//   /labs/*           Lab Simulations + hosted labs (Express, labs child process)   proxied
//   /ar/*             Attack Reasoning Lab (Express, labs child process)           proxied
//
// Internal endpoints (identity, summaries, AI usage) answer loopback callers only. Every request
// carries an x-request-id minted here that children receive and gateway errors echo.
// Settings (all optional, see deploy/README.md): CLIENT_IP_SOURCE, TRUSTED_PROXY_HOPS,
// GATEWAY_MAX_BODY_BYTES, GATEWAY_UPSTREAM_TIMEOUT_MS, GATEWAY_BOOT_HEALTH.
import express from 'express';
import { randomUUID } from 'node:crypto';
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

/**
 * The request id of this request: always the one the gateway minted (its first middleware overwrites
 * whatever the client sent). The APIs trust a well-formed inbound x-request-id for log correlation, so
 * a client must never be able to choose it.
 */
export const requestIdOf = (req) => req.headers['x-request-id'] ?? '';

/**
 * The app a lab path belongs to, as learners know it ('' outside /labs and /ar). Used for the gateway's
 * own answers there: the error messages the lab clients show and the page a navigation gets while the
 * labs child is not answering.
 */
const LAB_PRODUCTS = [
  [/^\/labs\/soc(\/|$)/i, 'The SOC simulation'],
  [/^\/labs\/redteam(\/|$)/i, 'The Web Pentest Lab'],
  [/^\/labs\/devsecops(\/|$)/i, 'The DevSecOps lab'],
  [/^\/labs\/threatwall(\/|$)/i, 'ThreatReady Firewall'],
  [/^\/labs\/aisec(\/|$)/i, 'The AI Security Lab'],
  [/^\/labs(\/|$)/i, 'Lab Simulations'],
  [/^\/ar(\/|$)/i, 'Attack Reasoning'],
];
const pathOf = (req) => String(req.originalUrl ?? req.url ?? '').split('?')[0];
export const labProductOf = (req) => LAB_PRODUCTS.find(([re]) => re.test(pathOf(req)))?.[1] ?? '';

/**
 * A gateway-originated error body. /api and /v1 keep the APIs' envelope { error: { code, message, ... } },
 * which the onboard and InterviewPrep clients parse. Under /labs and /ar the lab clients read `error`
 * (Lab Simulations, Attack Reasoning) or `message` (Red Team, SOC) as the text to show, so there both are
 * the human message and the code sits beside them; an envelope there rendered "[object Object]"
 * (merge review UI-1).
 */
const errorBody = (req, code, message, retryable) => (labProductOf(req)
  ? { error: message, message, code, retryable, requestId: requestIdOf(req) }
  : { error: { code, message, retryable, requestId: requestIdOf(req) } });

/* ---------------- Settings ---------------- */

/** Where the visitor's IP comes from. xff-rightmost: Render (deploy/README.md, "Client IP"). */
export const CLIENT_IP_SOURCES = ['xff-rightmost', 'cf-connecting-ip', 'true-client-ip', 'socket'];
/**
 * How long /healthz reports "starting" (503) after boot. wait: until the migrations are done and every
 * child (both APIs and the labs child) has answered once; migrations: only while the migrations run (the
 * children then start behind a 200); auto (default): wait on a release's first boot (a deploy of new code
 * or settings), migrations on a restart or wake of a release that has booted before (deploy/README.md,
 * "Health check").
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
    // How long a page request (/labs, /ar) waits for the labs child to come up before it gets the
    // "restarting" page instead. 0 = answer at once.
    pageHoldMs: int('GATEWAY_PAGE_HOLD_MS', 15_000, 0, 60_000),
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
 * CLIENT_IP_HEADER, so every route (proxied, in the labs child, or in-process) keys its limits on it.
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

/* ---------------- Proxy to the children ---------------- */

/** A gateway-originated error: JSON with the request id, never Express's HTML page. */
const fail = (req, res, status, code, message, extra = {}) => res.status(status).set(extra).json(errorBody(req, code, message, status >= 500));
const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;
const RESTARTING = 'This part of ThreatReady is restarting. Try again shortly.';

/** What a learner reads when a child is not answering: per lab under /labs and /ar (the copy the lab clients use), generic elsewhere. */
function unavailableMessage(req, code) {
  const product = labProductOf(req);
  if (code === 'UPSTREAM_TIMEOUT') return `${product || 'ThreatReady'} took too long to answer. Try again in a moment.`;
  if (product) return `${product} is briefly unavailable. Try again in 5 seconds.`;
  return code === 'STARTING' ? 'ThreatReady is starting up. Try again in a few seconds.' : RESTARTING;
}

/** /api/, /v1/ and /internal/ segments are API calls wherever they sit (/labs/soc/api/..., /ar/v1/...). */
const API_SEGMENT = /\/(api|v1|internal)(\/|$)/i;
/**
 * A browser loading a lab page (address bar, reload, link): GET or HEAD under /labs or /ar, outside an
 * API segment, preferring HTML over JSON. fetch() sends Accept: *\/* (or JSON), so API calls never match.
 */
const isLabPage = (req) => (req.method === 'GET' || req.method === 'HEAD') && !!labProductOf(req) && !API_SEGMENT.test(pathOf(req)) && req.accepts(['json', 'html']) === 'html';

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** The platform's dark and light tokens (Threatready-landing-page-main/apps/web/src/styles/platform.css .trp), for the page below. */
const PAGE_THEME = {
  dark: { scheme: 'dark', bg: '#0b1020', surface: '#111827', border: '#243047', borderStrong: '#33415c', text: '#f3f5f9', text2: '#a3acbf', accent: '#6d5dfc', accentHover: '#5b4bf0', accentText: '#a59bff', onAccent: '#ffffff' },
  light: { scheme: 'light', bg: '#ffffff', surface: '#f7f8fb', border: '#e3e6ee', borderStrong: '#cdd2de', text: '#0e1424', text2: '#475069', accent: '#5545e8', accentHover: '#4636d6', accentText: '#4a3bd9', onAccent: '#ffffff' },
};
/**
 * The page a lab navigation gets while the labs child is not answering (merge review UI-2): the
 * platform's look (its tr-theme cookie picks light or dark), what is happening, an automatic reload
 * after 5 s and a Retry link. No script, so the platform CSP applies unchanged.
 */
export function labUnavailablePage(req, code) {
  const product = labProductOf(req) || 'ThreatReady';
  const t = PAGE_THEME[/(?:^|;\s*)tr-theme=light(?:;|$)/.test(String(req.headers.cookie ?? '')) ? 'light' : 'dark'];
  const what = code === 'STARTING' ? 'is starting' : code === 'UPSTREAM_TIMEOUT' ? 'took too long to answer' : 'is restarting';
  const here = escapeHtml(req.originalUrl || '/');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<meta name="robots" content="noindex">
<title>${escapeHtml(product)} · ThreatReady</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:${t.scheme}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:${t.bg};color:${t.text};font:400 16px/1.6 "Inter Variable","Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:440px;padding:24px;border:1px solid ${t.border};border-radius:14px;background:${t.surface}}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 16px;font-weight:700;letter-spacing:.01em}
h1{font-size:18px;line-height:1.35;margin:0 0 6px}
p{margin:0 0 20px;color:${t.text2}}
.actions{display:flex;flex-wrap:wrap;gap:10px}
a.btn{display:inline-flex;align-items:center;justify-content:center;height:42px;padding:0 18px;border-radius:6px;font-weight:600;font-size:15px;text-decoration:none;border:1px solid transparent}
a.primary{background:${t.accent};color:${t.onAccent}}
a.primary:hover{background:${t.accentHover}}
a.secondary{color:${t.text};border-color:${t.borderStrong}}
a.secondary:hover{background:${t.bg}}
a:focus-visible{outline:2px solid ${t.accentText};outline-offset:2px}
</style>
</head>
<body>
<main role="status" aria-live="polite">
<div class="brand"><img src="/logo-sm.png" width="26" height="25" alt="">ThreatReady</div>
<h1>${escapeHtml(product)} ${what}</h1>
<p>This page reloads in 5 seconds.</p>
<div class="actions"><a class="btn primary" href="${here}">Retry</a><a class="btn secondary" href="/app">ThreatReady home</a></div>
</main>
</body>
</html>
`;
}
/** Answers a lab navigation with that page (503, or 504 for a timeout), Retry-After 5, never cached. */
const sendLabPage = (req, res, status, code) => res.status(status).set({ 'Retry-After': '5', 'Cache-Control': 'no-store' }).type('html').send(labUnavailablePage(req, code));

/**
 * The scheme the children are told the visitor used (X-Forwarded-Proto): the configured public URL's,
 * never the client's header. A client can send `X-Forwarded-Proto: http` (or a second value, which Node
 * joins into "http, https" and the apps read from the left), and the apps use it for same-origin checks
 * (the Red Team CSRF check's self origin) and absolute URLs. Unset or unparsable: https.
 */
export function forwardedProtoOf(publicUrl) {
  try { return publicUrl ? new URL(publicUrl).protocol.replace(/:$/, '') || 'https' : 'https'; } catch { return 'https'; }
}

/** Request headers for a child: hop-by-hop and Connection-nominated names removed, then the gateway's own set last. */
function forwardHeaders(req, proto) {
  const headers = { ...req.headers };
  const nominated = String(req.headers.connection ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const h of [...HOP_BY_HOP, ...nominated, ...IP_HEADERS, 'content-length', 'expect']) delete headers[h];
  // Written after the deletes, so a client cannot drop them by naming them in Connection.
  headers.host = req.headers.host ?? '';
  headers[CLIENT_IP_HEADER] = req.headers[CLIENT_IP_HEADER];
  headers['x-forwarded-for'] = req.headers[CLIENT_IP_HEADER];
  headers['x-forwarded-host'] = req.headers.host ?? '';
  headers['x-forwarded-proto'] = proto;
  headers['x-request-id'] = requestIdOf(req);
  return headers;
}
/** A child's response headers without its hop-by-hop ones (Node frames this response itself). */
const responseHeaders = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !HOP_BY_HOP.includes(k)));
const isEventStream = (v) => /text\/event-stream/i.test(String(v ?? ''));

/**
 * Streams a request to a local child process. `state()` says whether the child is 'ready', still
 * 'starting' (never been up) or 'down' (was up, now restarting); a boolean is read as ready/starting.
 * Framing is re-established here, never inherited: a body is sent with exactly the framing it arrived
 * with (Content-Length, or chunked when it came chunked), whatever the method, and a request without one
 * sends none. Stripping the framing headers and piping the rest would let a GET/DELETE body reach the
 * child as a second, unchecked request. Bodies over the cap are refused (413) before the child sees a
 * complete request. Requests time out after `upstreamIdleMs` without traffic, except event streams
 * (Accept or response text/event-stream), which are never buffered. The child's own headers win over
 * the gateway's (a lab may set its own CSP for its pages). While the child is not answering, API calls
 * get a 503/504 JSON error in their mount's shape (errorBody) and a lab page navigation first waits up
 * to `pageHoldMs` for it, then gets labUnavailablePage, never raw JSON as the document.
 */
function proxyTo(port, state, cfg, proto = 'https') {
  const stateNow = () => { const st = state(); return st === true ? 'ready' : st === false ? 'starting' : st; };
  const notReady = (req, res, s) => {
    const code = s === 'down' ? 'UPSTREAM_UNAVAILABLE' : 'STARTING';
    if (isLabPage(req)) sendLabPage(req, res, 503, code);
    else fail(req, res, 503, code, unavailableMessage(req, code), { 'Retry-After': '5' });
  };
  return (req, res) => {
    const s = stateNow();
    if (s === 'ready') { forward(req, res); return; }
    // A lab page requested while the labs child starts (a free-plan wake, a restart) waits for it, up to
    // pageHoldMs, as on a single process where the port opened only once the labs had loaded (merge
    // review M-BIZ-1); API calls are answered at once, their clients handle STARTING themselves.
    if (!cfg.pageHoldMs || !isLabPage(req)) { notReady(req, res, s); return; }
    const deadline = Date.now() + cfg.pageHoldMs;
    let gone = false;
    res.on('close', () => { gone = true; });
    const poll = () => {
      if (gone) return;
      const now = stateNow();
      if (now === 'ready') forward(req, res);
      else if (Date.now() >= deadline) notReady(req, res, now);
      else setTimeout(poll, PAGE_POLL_MS);
    };
    setTimeout(poll, PAGE_POLL_MS);
  };

  function forward(req, res) {
    // req.headers[CLIENT_IP_HEADER] was stamped by the gateway's first middleware (never the client's).
    const headers = forwardHeaders(req, proto);
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
    } else {
      upstream.setTimeout(0);
    }
    upstream.on('error', (err) => {
      // The child's answer already arrived in full (a later write error means it stopped reading the body): keep it.
      if (refused || answered || res.writableEnded || res.destroyed) return;
      // A response already under way can't become an error page: cut it so the client sees it is incomplete.
      if (res.headersSent) { res.destroy(); return; }
      // Connection refused or reset: the child crashed between readiness probes and is restarting.
      const [status, code] = err?.code === 'UPSTREAM_TIMEOUT' ? [504, 'UPSTREAM_TIMEOUT'] : [503, 'UPSTREAM_UNAVAILABLE'];
      if (isLabPage(req)) sendLabPage(req, res, status, code);
      else fail(req, res, status, code, unavailableMessage(req, code), { 'Retry-After': '5' });
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
        fail(req, res, 413, 'PAYLOAD_TOO_LARGE', `This upload is too large. The limit is ${mb(cfg.maxBodyBytes)}.`, { Connection: 'close' });
        return;
      }
      if (!upstream.write(chunk)) req.pause();
    });
    upstream.on('drain', () => req.resume());
    req.on('end', () => { if (!refused) upstream.end(); });
  }
}
/** How often a held lab page request looks at the labs child's state again. */
const PAGE_POLL_MS = 250;

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

/* ---------------- Security headers ---------------- */

/**
 * The platform's Content-Security-Policy directives, one source of truth (tools/gen-headers.mjs renders
 * the onboard _headers file from this array; keep it a plain list of string literals). connect-src is
 * 'self' blob: only: three.js loads the 3D interviewer's embedded textures with fetch(blob:) (GLTFLoader,
 * ImageBitmapLoader). No app fetches a data: URL, so data: is not allowed there. Every app ships its own
 * fonts (@fontsource-variable), so style-src and font-src name no third-party origin.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  'frame-src https://challenges.cloudflare.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
];
/** The Content-Security-Policy every response gets (a lab may adjust it for its own pages, see below). */
export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join('; ');

/**
 * Security headers for every response. Used by the gateway and by the labs child: the hosted labs adjust
 * the CSP per path (frame-src 'self' on the DevSecOps and Red Team pages, the DevSecOps sandbox.html
 * policy; the Red Team target-frame.html sets its own) with res.getHeader/setHeader, so the base policy
 * must already be on the response in the process that serves them; the proxy lets the child's CSP win
 * over the gateway's.
 */
export function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Clickjacking fallback for user agents without frame-ancestors (which, when present, wins). SAMEORIGIN,
  // not DENY: the labs' sandboxed documents (DevSecOps sandbox.html, the Red Team target frame) are framed
  // by pages of this origin.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), microphone=(self)');
  // Nothing on the platform (sign-in, dashboards, labs, reports) belongs in search results; robots.txt keeps
  // crawling allowed so this directive is seen. The SPA shells carry the same noindex meta for previews.
  res.setHeader('X-Robots-Tag', 'noindex');
  next();
}

/* ---------------- The gateway ---------------- */

/**
 * `ready()` returns the launcher's readiness summary: `{ onboard, interview, labs, starting, degraded, ... }`
 * and optionally `status.<child>` = 'ready' | 'starting' | 'down'. Labs and Attack Reasoning are proxied to
 * the labs child on `labsPort`; passing `labsApp`/`arApp` instead mounts them in this process (local
 * development and tests only). `publicUrl` (the launcher's PUBLIC_URL) decides the scheme the children
 * get in X-Forwarded-Proto; unset, https.
 */
export async function createGateway({ onboardPort, interviewPort, labsPort, ready, labsApp, arApp, publicUrl, config = gatewayConfig(), log = (m) => console.log(`[gateway] ${m}`) }) {
  const app = express();
  app.disable('x-powered-by');
  // For req.protocol / req.hostname only; req.ip is pinned to the gateway's decision below.
  app.set('trust proxy', 1);
  const checkHops = hopCheck(config.clientIp, log);
  const proto = forwardedProtoOf(publicUrl);
  const stateOf = (k) => { const r = ready(); return r.status?.[k] ?? (r[k] ? 'ready' : 'starting'); };

  // First thing for every request: the client IP header is ours, never the client's, and every request
  // gets a fresh id that children receive and that gateway-originated errors echo (a client-supplied id
  // is never kept). In-process apps see the same address as req.ip, whatever their trust proxy says;
  // the labs child turns the header into its req.ip (deploy/labs-child.mjs).
  app.use((req, res, next) => {
    const ip = clientIpOf(req, config.clientIp);
    req.headers[CLIENT_IP_HEADER] = ip;
    Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true, writable: true });
    const id = randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    checkHops(req);
    next();
  });

  // Security headers for every response, error answers included (replaces Cloudflare _headers in this
  // deployment).
  app.use(securityHeaders);

  // Message framing, for every route: both Transfer-Encoding and Content-Length (RFC 9112 §6.1: a
  // smuggling attempt), or a transfer coding other than plain chunked, is refused; so is a declared
  // body over the cap. Node's parser rejects most of these too; this does not depend on it.
  app.use((req, res, next) => {
    const te = req.headers['transfer-encoding'];
    const cl = req.headers['content-length'];
    if (te !== undefined && (cl !== undefined || !/^chunked$/i.test(String(te).trim()))) {
      fail(req, res, 400, 'BAD_REQUEST', 'This request could not be read.', { Connection: 'close' });
      return;
    }
    if (config.maxBodyBytes && cl !== undefined && Number(cl) > config.maxBodyBytes) {
      fail(req, res, 413, 'PAYLOAD_TOO_LARGE', `This upload is too large. The limit is ${mb(config.maxBodyBytes)}.`, { Connection: 'close' });
      return;
    }
    // Compressed request bodies: browsers never send them, and the apps' JSON parsers would inflate
    // them (body-parser advisory GHSA-27r3-jxmh-p828). Refused here for every app in one place.
    const ce = req.headers['content-encoding'];
    if (ce !== undefined && !/^\s*identity\s*$/i.test(String(ce))) {
      fail(req, res, 415, 'UNSUPPORTED_ENCODING', 'Compressed request bodies are not accepted.', { Connection: 'close' });
      return;
    }
    next();
  });

  // Render health check. 503 while the launcher is still starting (`starting`: migrations, then the
  // children's first start), so a deploy whose migration fails or whose child never comes up is not
  // marked live and Render keeps the old instance. After that 200, until a child that was up stays down
  // for a minute (crash loop) or one never came up (stuck): 503 again so Render sees it. /readyz has the
  // detail (each child's status, exits since it was last ready, last heap sample) for internal callers
  // (loopback, no edge header: an operator on the instance); the internet gets the status code and
  // `ready` alone, so nobody can watch a child's heap or count its crashes from outside.
  app.get('/healthz', (_req, res) => {
    const r = ready();
    if (r.starting) { res.status(503).set('Retry-After', '5').json({ ok: false, phase: 'starting' }); return; }
    res.status(r.degraded ? 503 : 200).json({ ok: !r.degraded });
  });
  app.get('/readyz', (req, res) => {
    const r = ready();
    const isReady = !!(r.onboard && r.interview && (labsApp ? true : r.labs));
    res.status(isReady ? 200 : 503).json(internalCaller(req) ? r : { ready: isReady });
  });

  // Internal APIs are for the apps' server-to-server calls only: loopback peer AND no edge headers
  // (behind Render every peer is loopback). Covers /api/internal, /labs/internal, /ar/internal and
  // any /internal/ segment under a sub-mounted lab (e.g. /labs/redteam/internal/...).
  app.use((req, res, next) => (INTERNAL_PATH.test(req.path) && !internalCaller(req) ? res.status(404).json({ error: 'Not found.', requestId: requestIdOf(req) }) : next()));

  // Crawler and disclosure files are real files, never the SPA shell.
  const webPublic = path.join(ROOT, 'Threatready-landing-page-main/apps/web/public');
  app.get('/robots.txt', (_req, res) => res.sendFile(path.join(webPublic, 'robots.txt'), { headers: { 'Cache-Control': 'public, max-age=3600' } }));
  // sendFile ignores dot-segments by default; the directory is .well-known, so allow them here.
  app.get('/.well-known/security.txt', (_req, res) => res.type('text/plain').sendFile(path.join(webPublic, '.well-known/security.txt'), { dotfiles: 'allow', headers: { 'Cache-Control': 'public, max-age=3600' } }));

  app.use('/api', proxyTo(onboardPort, () => stateOf('onboard'), config, proto));
  app.use('/v1', proxyTo(interviewPort, () => stateOf('interview'), config, proto));
  // Labs, hosted labs and Attack Reasoning run in their own process (deploy/labs-child.mjs): a lab
  // emulator bug cannot read this process's memory or take the gateway down. The child trusts the
  // client-IP header stamped above because its port is loopback-only and the gateway is its only
  // public caller.
  app.use('/labs', labsApp ?? proxyTo(labsPort, () => stateOf('labs'), config, proto));
  app.use('/ar', arApp ?? proxyTo(labsPort, () => stateOf('labs'), config, proto));
  app.use('/interview-prep', spa(path.join(ROOT, 'InterviewPrep/apps/web/dist')));
  app.use('/', spa(path.join(ROOT, 'Threatready-landing-page-main/apps/web/dist')));

  // Anything else (a non-GET to a static path, for instance) and any error thrown in this process: JSON
  // with the request id, never Express's HTML page or a stack trace. The security headers above apply.
  app.use((req, res) => fail(req, res, 404, 'NOT_FOUND', 'Not found.'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    console.error(JSON.stringify({ event: 'gateway_error', requestId: requestIdOf(req), status, message: err instanceof Error ? err.message : String(err) }));
    if (res.headersSent) { res.end(); return; }
    fail(req, res, status, status === 500 ? 'INTERNAL' : 'REQUEST_REJECTED', status === 500 ? 'Something went wrong on our side.' : 'The request could not be processed.');
  });
  return app;
}
