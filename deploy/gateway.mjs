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
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
/** Header the gateway sets with the visitor's IP; the APIs read only this one (CLIENT_IP_HEADER). */
export const CLIENT_IP_HEADER = 'x-threatready-client-ip';
const firstIp = (v) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() || '';
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
/** Hop-by-hop headers (RFC 9110 §7.6.1) are for this connection only; never forwarded upstream. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/** Streams a request to a local child process; works for SSE (no buffering, no timeout). */
function proxyTo(port, readiness) {
  return (req, res) => {
    if (!readiness()) {
      res.status(503).set('Retry-After', '5').json({ error: { code: 'STARTING', message: 'ThreatReady is starting up. Try again in a few seconds.', retryable: true } });
      return;
    }
    // req.headers[CLIENT_IP_HEADER] was stamped by the gateway's first middleware (never the client's).
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? 'https';
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.originalUrl, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.setTimeout(0);
    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'This part of ThreatReady is restarting. Try again shortly.', retryable: true } });
      else res.end();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
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

/**
 * The visitor's IP, decided once per request from what the edge adds (Cloudflare first, then Render),
 * falling back to the socket; anything that is not an IP literal is ignored. Written over whatever
 * the client sent in CLIENT_IP_HEADER, so every route (proxied or in-process) keys its limits on it.
 */
export function clientIpOf(req) {
  const socketIp = req.socket.remoteAddress || '';
  const candidate = firstIp(req.headers['cf-connecting-ip']) || firstIp(req.headers['true-client-ip'])
    || firstIp(req.headers['x-forwarded-for']) || socketIp;
  return net.isIP(candidate) ? candidate : socketIp;
}

export async function createGateway({ onboardPort, interviewPort, ready, labsApp, arApp }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // First thing for every request: the client IP header is ours, never the client's.
  app.use((req, _res, next) => {
    req.headers[CLIENT_IP_HEADER] = clientIpOf(req);
    next();
  });

  // Security headers for every response (replaces Cloudflare _headers in this deployment).
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' https://challenges.cloudflare.com 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
      "connect-src 'self' blob: data:",
      "worker-src 'self' blob:",
      "media-src 'self' blob:",
      'frame-src https://challenges.cloudflare.com',
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '));
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), microphone=(self)');
    next();
  });

  // Render health check: the gateway is up (children may still be starting; /readyz tells). Once a
  // child has been up and then stays down for a minute (crash loop), report unhealthy so Render sees it.
  app.get('/healthz', (_req, res) => { const r = ready(); res.status(r.degraded ? 503 : 200).json({ ok: !r.degraded }); });
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

  app.use('/api', proxyTo(onboardPort, () => ready().onboard));
  app.use('/v1', proxyTo(interviewPort, () => ready().interview));
  app.use('/labs', labsApp);
  app.use('/ar', arApp);
  app.use('/interview-prep', spa(path.join(ROOT, 'InterviewPrep/apps/web/dist')));
  app.use('/', spa(path.join(ROOT, 'Threatready-landing-page-main/apps/web/dist')));
  return app;
}
