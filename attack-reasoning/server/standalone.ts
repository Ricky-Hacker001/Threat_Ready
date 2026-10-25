// ar.threatready.io on its own (no ThreatReady gateway in front): the app under /ar, the reasoning
// engine's /v1 at the root for the SPA, and the security headers the gateway would otherwise add.
import express from 'express';
import { createApp, type AppOptions } from './app';
import { CLIENT_IP_HEADER } from './ratelimit';

/**
 * Content-Security-Policy and friends for every response, mirroring deploy/gateway.mjs for what this
 * app needs (audit TR-49): everything from this origin, inline styles (React Flow, the loading screen),
 * provider avatars, and no framing.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), payment=(), microphone=()',
};

export interface StandaloneOptions {
  /**
   * Express `trust proxy` (env AR_TRUST_PROXY: a hop count, "loopback", or addresses). Unset: the
   * connection's address is the visitor's, and X-Forwarded-For is ignored.
   */
  trustProxy?: boolean | number | string;
  /** A trusted proxy in front sets CLIENT_IP_HEADER (env AR_TRUST_CLIENT_IP_HEADER=1). Otherwise a client-sent one is dropped. */
  trustClientIpHeader?: boolean;
  /** Send HSTS (HTTPS deployments). */
  hsts?: boolean;
}

/** `trust proxy` from an env string: "1"/"2" hops, "true"/"false", or an address list Express understands. */
export function trustProxyFrom(v: string | undefined): boolean | number | string | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'true' || v === 'false') return v === 'true';
  return /^\d+$/.test(v) ? Number(v) : v;
}

export function createStandaloneServer(staticDir: string | undefined, app: AppOptions, opts: StandaloneOptions = {}) {
  const ar = createApp(staticDir, app);
  const server = express();
  server.disable('x-powered-by');
  if (opts.trustProxy !== undefined) server.set('trust proxy', opts.trustProxy);
  server.use((req, res, next) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (opts.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // The client-IP header is the gateway's to set: standing alone, what a client sent is dropped
    // unless a trusted proxy in front is declared to set it (audit AR-REG5).
    if (!opts.trustClientIpHeader) delete req.headers[CLIENT_IP_HEADER];
    next();
  });
  server.use('/ar', ar);
  // The SPA calls /v1/reasoning/* on its own origin. Handed to the app with the path intact (a mount
  // at '/v1' would strip the prefix and the app's own /v1 proxy would never match).
  if (app.reasoningApi) server.use((req, res, next) => (req.path === '/v1' || req.path.startsWith('/v1/') ? ar(req, res, next) : next()));
  server.get('/', (_req, res) => res.redirect(302, '/ar/'));
  return server;
}
