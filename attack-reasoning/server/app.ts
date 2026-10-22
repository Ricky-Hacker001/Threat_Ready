import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { DIMENSIONS, LEVELS, SCENARIOS, scenarioById } from './scenarios';
import { IdentityResolver, internalTokenMatches } from './identity';
import { internalGet, proxyToApi } from './proxy';

export interface AppOptions {
  /** Resolves the shared ThreatReady session (onboard.threatready.io). */
  identity: IdentityResolver;
  /** Secret onboard sends on /internal/v1/* (INTERNAL_API_TOKEN). */
  internalToken: string;
  /** This app's public origin (ar.threatready.io). State-changing requests must come from it. */
  appOrigin: string;
  /** Public onboard origin, for sign-in/sign-out links. */
  onboardUrl: string;
  /** Every ThreatReady app (for the shared header). */
  apps?: () => Promise<{ key: string; title: string; url: string; status: string }[]>;
  /**
   * The ThreatReady monolith that runs the reasoning engine (InterviewPrep's API). When set, /v1/* is
   * proxied there for the browser and onboard's summary and AI-usage calls are answered from it.
   * Unset (tests, or before the engine is configured): /v1 answers 503 and the summary reports zeros.
   */
  reasoningApi?: { url: string; clientIpHeader?: string };
}

/**
 * ar.threatready.io. The Attack Reasoning SPA, the scenario catalogue, and this origin's gateway to
 * the reasoning engine, which runs as the `reasoning` module of the ThreatReady monolith (ADD L17b):
 * /v1/* is proxied there so the browser only talks to its own origin, and onboard's internal calls
 * are answered from the monolith's reasoning internal API.
 */
export function createApp(staticDir: string | undefined, opts: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  // Per-user API data must never be cached or revalidated by the browser (privacy on shared machines,
  // and a cached 304 must not stand in for a fresh list).
  app.set('etag', false);
  /* ---------------- Reasoning engine: /v1/* to the monolith ---------------- */
  // Mounted before the body parser so the request streams through untouched, and at the app root so the
  // SPA's calls (/v1/reasoning/...) work unchanged in every layout: the Vite dev proxy locally, the
  // single-origin gateway on Render, this server on ar.threatready.io.
  if (opts.reasoningApi) {
    app.use('/v1', (req, res, next) => {
      // Belt and braces: the monolith checks Origin too, but a state change must come from this origin.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== opts.appOrigin) return res.status(403).json({ error: 'Cross-origin request refused.' });
      next();
    }, proxyToApi({ target: opts.reasoningApi.url, clientIpHeader: opts.reasoningApi.clientIpHeader }));
  } else {
    app.use('/v1', (_req, res) => res.status(503).json({ error: { code: 'REASONING_ENGINE_UNAVAILABLE', message: 'The reasoning engine is not configured.', retryable: true, request_id: 'req_gateway' } }));
  }

  app.use(express.json({ limit: '16kb' }));

  /* ---------------- Internal API for onboard (profile overview, admin console) ---------------- */
  const internal = express.Router();
  internal.use((req, res, next) => { if (!internalTokenMatches(req.headers.authorization, opts.internalToken)) return res.status(401).json({ error: 'Internal token required.' }); next(); });
  const noEngine = () => ({
    app: 'reasoning',
    stats: [
      { label: 'Domains', value: 15, hint: 'Every domain is live' },
      { label: 'Available now', value: 15, hint: 'Cloud Security to GRC & Risk' },
      { label: 'Assessments completed', value: 0 },
    ],
    items: [],
    aiUsage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  });
  internal.get('/users/:userId/summary', async (req, res, next) => {
    if (!req.params.userId || req.params.userId.length > 100) return res.status(400).json({ error: 'Invalid user.' });
    if (!opts.reasoningApi) return res.json(noEngine());
    try {
      const r = await internalGet(opts.reasoningApi.url, `/internal/v1/reasoning/users/${encodeURIComponent(req.params.userId)}/summary?appOrigin=${encodeURIComponent(`${opts.appOrigin}/ar`)}`, opts.internalToken);
      res.status(r.status).json(r.body ?? { error: 'Reasoning engine returned no body.' });
    } catch (e) { next(e); }
  });
  internal.get('/ai-usage', async (req, res, next) => {
    if (!opts.reasoningApi) return res.json({ app: 'reasoning', users: [], byModel: [], byFeature: [] });
    try {
      const q = new URL(req.originalUrl, 'http://local').search;
      const r = await internalGet(opts.reasoningApi.url, `/internal/v1/reasoning/ai-usage${q}`, opts.internalToken);
      res.status(r.status).json(r.body ?? { error: 'Reasoning engine returned no body.' });
    } catch (e) { next(e); }
  });
  app.use('/internal/v1', internal);
  app.use('/internal', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  /* ---------------- Browser API ---------------- */
  const api = express.Router();
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== opts.appOrigin) return res.status(403).json({ error: 'Cross-origin request refused.' });
    next();
  });
  api.use(async (req, res, next) => {
    try {
      const r = await opts.identity(req.headers);
      if (r.ok === false) {
        if (r.reason === 'unavailable') return res.status(503).json({ error: 'Sign-in is briefly unavailable. Try again in a moment.', code: 'AUTH_PROVIDER_UNAVAILABLE' });
        for (const c of r.setCookies) res.append('Set-Cookie', c);
        return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      }
      for (const c of r.setCookies) res.append('Set-Cookie', c);
      if (r.user.isTrial) return res.status(403).json({ error: 'Attack Reasoning needs a ThreatReady account. Create one to continue.', code: 'AUTH_ACCOUNT_REQUIRED' });
      (req as any).user = r.user;
      next();
    } catch (e) { next(e); }
  });
  api.get('/me', (req, res) => { const u = (req as any).user; res.json({ id: u.id, name: u.name, email: u.email, image: u.image, isAdmin: u.isAdmin }); });
  api.get('/platform', async (_req, res) => res.json({ onboardUrl: opts.onboardUrl, apps: opts.apps ? await opts.apps() : [] }));
  api.get('/scenarios', (_req, res) => res.json({ levels: LEVELS, dimensions: DIMENSIONS, scenarios: SCENARIOS.map(({ brief: _b, architecture: _a, ...s }) => s) }));
  api.get('/scenarios/:id', (req, res) => {
    const s = scenarioById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Scenario not found.' });
    res.json({ scenario: s, levels: LEVELS, dimensions: DIMENSIONS });
  });
  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  if (staticDir && fs.existsSync(staticDir)) { app.use(express.static(staticDir)); app.get(/^(?!\/api|\/internal|\/v1).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html'))); }
  app.use((err: any, _req: any, res: any, _next: any) => { if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request body.' }); console.error(err); res.status(500).json({ error: 'Internal error.' }); });
  return app;
}
