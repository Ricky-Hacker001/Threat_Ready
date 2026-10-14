import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { DIMENSIONS, LEVELS, SCENARIOS, scenarioById } from './scenarios';
import { IdentityResolver, internalTokenMatches } from './identity';

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
}

/**
 * ar.threatready.io. The scenario list and each scenario's brief, behind ThreatReady sign-in.
 * The reasoning engine (adaptive questions, LLM scoring) is not built yet, so there are no
 * sessions to record; the internal API reports that honestly to onboard.
 */
export function createApp(staticDir: string | undefined, opts: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  /* ---------------- Internal API for onboard (profile overview, admin console) ---------------- */
  const internal = express.Router();
  internal.use((req, res, next) => { if (!internalTokenMatches(req.headers.authorization, opts.internalToken)) return res.status(401).json({ error: 'Internal token required.' }); next(); });
  internal.get('/users/:userId/summary', (req, res) => {
    if (!req.params.userId || req.params.userId.length > 100) return res.status(400).json({ error: 'Invalid user.' });
    res.json({
      app: 'reasoning',
      stats: [
        { label: 'Scenarios', value: SCENARIOS.length, hint: 'In the catalog' },
        { label: 'Available now', value: SCENARIOS.filter(s => s.available).length },
        { label: 'Sessions completed', value: 0 },
        { label: 'Opens with', value: 'V1.0' },
      ],
      items: [],
      // Scoring will call the LLM; until the engine ships there is no usage to report.
      aiUsage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    });
  });
  internal.get('/ai-usage', (_req, res) => res.json({ app: 'reasoning', users: [], byModel: [], byFeature: [] }));
  app.use('/internal/v1', internal);
  app.use('/internal', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  /* ---------------- Browser API ---------------- */
  const api = express.Router();
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

  if (staticDir && fs.existsSync(staticDir)) { app.use(express.static(staticDir)); app.get(/^(?!\/api|\/internal).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html'))); }
  app.use((err: any, _req: any, res: any, _next: any) => { if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request body.' }); console.error(err); res.status(500).json({ error: 'Internal error.' }); });
  return app;
}
