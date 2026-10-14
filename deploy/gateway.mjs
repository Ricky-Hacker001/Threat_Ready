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
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
/** Header the gateway sets with the visitor's IP; the APIs read only this one (CLIENT_IP_HEADER). */
export const CLIENT_IP_HEADER = 'x-threatready-client-ip';
const firstIp = (v) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() || '';
const loopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

/** Streams a request to a local child process; works for SSE (no buffering, no timeout). */
function proxyTo(port, readiness) {
  return (req, res) => {
    if (!readiness()) {
      res.status(503).set('Retry-After', '5').json({ error: { code: 'STARTING', message: 'ThreatReady is starting up. Try again in a few seconds.', retryable: true } });
      return;
    }
    // The visitor's real IP for the APIs' rate limits: set by the gateway (never trusted from the
    // client), taken from what Render's edge adds, falling back to the socket.
    const clientIp = firstIp(req.headers['true-client-ip']) || firstIp(req.headers['cf-connecting-ip'])
      || firstIp(req.headers['x-forwarded-for']) || req.socket.remoteAddress || '';
    const headers = {
      ...req.headers,
      [CLIENT_IP_HEADER]: clientIp,
      'x-forwarded-host': req.headers.host ?? '',
      'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'https',
    };
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

export async function createGateway({ onboardPort, interviewPort, ready, labsApp, arApp }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

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
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), microphone=(self)');
    next();
  });

  // Render health check: the gateway is up (children may still be starting; /readyz tells).
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', (_req, res) => { const r = ready(); res.status(r.onboard && r.interview ? 200 : 503).json(r); });

  // Internal APIs are for the apps' server-to-server calls only.
  app.use(['/api/internal', '/labs/internal', '/ar/internal'], (req, res, next) => (loopback(req) ? next() : res.status(404).json({ error: 'Not found.' })));

  app.use('/api', proxyTo(onboardPort, () => ready().onboard));
  app.use('/v1', proxyTo(interviewPort, () => ready().interview));
  app.use('/labs', labsApp);
  app.use('/ar', arApp);
  app.use('/interview-prep', spa(path.join(ROOT, 'InterviewPrep/apps/web/dist')));
  app.use('/', spa(path.join(ROOT, 'Threatready-landing-page-main/apps/web/dist')));
  return app;
}
