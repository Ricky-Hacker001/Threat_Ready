import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { Store, Session } from './store';
import { webLab, LabEngine } from './engine';
import { CATALOG } from './catalog';
import { IdentityResolver, internalTokenMatches, devUserCookie, devLogoutCookie } from './identity';
import { limitFromEnv, rateLimiter } from './ratelimit';

const ENGINES: Record<string, LabEngine> = { [webLab.labId]: webLab };
const hasOwn = (o: object, k: unknown) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
/** A lab engine by id from the URL ("constructor" and friends are not labs). */
const engineOf = (labId: unknown): LabEngine | undefined => (hasOwn(ENGINES, labId) ? ENGINES[labId as string] : undefined);

export interface AppOptions {
  identity: IdentityResolver;
  internalToken?: string;
  appOrigin: string;
  onboardUrl?: string;
  /** Standalone dev login (cookie-based). */
  devLogin?: boolean;
  devSecret?: string;
  apps?: () => Promise<{ key: string; title: string; url: string; status: string }[]>;
  /** Requests per minute per signed-in user / per client IP (defaults 120 / 300; env REDTEAM_RATE_PER_MIN, REDTEAM_RATE_IP_PER_MIN; 0 disables). */
  ratePerMin?: number;
  rateIpPerMin?: number;
}

const pct = (score: number, max: number) => (max > 0 ? Math.round((score / max) * 100) : 0);
const runStatus = (s: Session, st: any) => (st.complete ? 'Completed' : s.status === 'archived' ? 'Archived' : 'In progress');

export function createApp(store: Store, staticDir: string | undefined, opts: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  const limiter = rateLimiter({
    perUserPerMin: opts.ratePerMin ?? limitFromEnv('REDTEAM_RATE_PER_MIN', 120),
    perIpPerMin: opts.rateIpPerMin ?? limitFromEnv('REDTEAM_RATE_IP_PER_MIN', 300),
    body: (wait) => ({ error: `Too many requests. Try again in ${wait}s.`, code: 'RATE_LIMITED' }),
  });
  app.use(express.json({ limit: '128kb' }));

  /* ---------- internal API for onboard (optional platform parity) ---------- */
  if (opts.internalToken) {
    const internal = express.Router();
    internal.use((req, res, next) => { if (!internalTokenMatches(req.headers.authorization, opts.internalToken!)) return res.status(401).json({ error: 'Internal token required.' }); next(); });
    internal.get('/users/:userId/summary', (req, res) => {
      const userId = req.params.userId;
      if (!userId || userId.length > 100) return res.status(400).json({ error: 'Invalid user.' });
      const runs = store.allSessionsOf(userId).filter(s => ENGINES[s.labId]);
      const rows = runs.map(s => { const e = ENGINES[s.labId]; const st = e.status(s.state); return { s, e, st, percent: pct(st.score.total, st.score.max) }; });
      const origin = opts.appOrigin.replace(/\/+$/, '');
      res.json({
        app: 'web-pentest',
        stats: [
          { label: 'Engagements started', value: new Set(rows.map(r => r.s.labId)).size },
          { label: 'Completed', value: new Set(rows.filter(r => r.st.complete).map(r => r.s.labId)).size },
          { label: 'Best score', value: rows.length ? `${Math.max(...rows.map(r => r.percent))}/100` : '—' },
          { label: 'Findings verified', value: rows.filter(r => r.s.status === 'active').reduce((n, r) => n + (r.st.posture?.verified ?? 0), 0) },
        ],
        items: rows.slice(0, 10).map(r => ({ id: r.s.id, title: `${r.e.title} · run ${r.s.run}`, status: r.st.complete ? 'Completed' : r.s.status === 'archived' ? 'Archived' : `In progress · level ${r.st.level}`, score: r.percent, at: r.s.updatedAt, url: `${origin}/lab/` })),
        aiUsage: null,
      });
    });
    internal.get('/ai-usage', (_req, res) => res.json({ app: 'web-pentest', users: [], byModel: [], byFeature: [] }));
    app.use('/internal/v1', internal);
    app.use('/internal', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  }

  /* ---------- browser API ---------- */
  const api = express.Router();
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  api.get('/health', (_req, res) => res.json({ ok: true, lab: webLab.labId }));

  // Per-IP limit before sign-in is resolved (covers dev login and the identity lookup), per-user limit after.
  api.use(limiter.ipMiddleware);

  // Dev login (standalone). Disabled when devLogin is off.
  if (opts.devLogin && opts.devSecret) {
    api.post('/dev/login', (req, res) => {
      const name = String(req.body?.name || '').trim().slice(0, 60);
      if (!name || !/^[\w .'-]{2,60}$/.test(name)) return res.status(400).json({ error: 'Enter a display name (2–60 letters).', code: 'VALIDATION_FAILED' });
      res.append('Set-Cookie', devUserCookie(name, opts.devSecret!));
      res.json({ ok: true, name });
    });
    api.post('/dev/logout', (_req, res) => { res.append('Set-Cookie', devLogoutCookie()); res.json({ ok: true }); });
  }

  // State-changing requests must originate from this app's own pages (CSRF defence). Accept the
  // configured public origin (e.g. the Vite dev server behind a proxy) OR a genuine same-origin request
  // (Origin equals the server origin serving the page) — same-origin is always safe, and it lets the
  // built client be served directly from this server on any port without extra configuration.
  api.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.path === '/dev/login' || req.path === '/dev/logout') return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const selfOrigin = req.headers.host ? `${proto}://${req.headers.host}` : null;
    if (origin === opts.appOrigin || origin === selfOrigin) return next();
    return res.status(403).json({ error: 'Cross-origin request refused.', code: 'VALIDATION_FAILED' });
  });

  // Identity.
  api.use(async (req, res, next) => {
    try {
      const r = await opts.identity(req.headers);
      if (r.ok === false) {
        if (r.reason === 'unavailable') return res.status(503).set('Retry-After', '5').json({ error: 'Sign-in is briefly unavailable. Try again.', code: 'AUTH_PROVIDER_UNAVAILABLE' });
        for (const c of r.setCookies) res.append('Set-Cookie', c);
        return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED', devLogin: !!(opts.devLogin && opts.devSecret) });
      }
      for (const c of r.setCookies) res.append('Set-Cookie', c);
      if (r.user.isTrial) return res.status(403).json({ error: 'A ThreatReady account is required.', code: 'AUTH_ACCOUNT_REQUIRED' });
      if (!limiter.user(req, res, r.user.id)) return;
      (req as any).user = store.upsertUser(r.user.id, r.user.name);
      (req as any).platformUser = r.user;
      next();
    } catch (e) { next(e); }
  });

  api.get('/me', (req, res) => { const u = (req as any).platformUser; res.json({ id: u.id, name: u.name, email: u.email, image: u.image, isAdmin: u.isAdmin, onboardUrl: opts.onboardUrl || null }); });

  api.get('/platform', async (_req, res) => { res.json({ onboardUrl: opts.onboardUrl || null, apps: opts.apps ? await opts.apps() : [] }); });

  api.get('/catalog', (req, res) => {
    const user = (req as any).user;
    res.json(CATALOG.map(c => {
      const e = ENGINES[c.id];
      if (!e) return { ...c, available: false, progress: null };
      const runs = store.sessionsOf(user.id, c.id); const latest = runs[runs.length - 1];
      if (!latest) return { ...c, available: true, progress: null };
      const st = e.status(latest.state);
      return { ...c, available: true, progress: { runs: runs.length, status: runStatus(latest, st), level: st.level, percent: st.progress, score: st.score.total, max: st.score.max, complete: st.complete, updatedAt: latest.updatedAt } };
    }));
  });

  api.get('/labs/:labId', (req, res) => { const e = engineOf(req.params.labId); if (!e) return res.status(404).json({ error: 'Lab not found.', code: 'SCENARIO_NOT_FOUND' }); res.json(e.definition()); });

  const snapshot = (s: Session) => { const e = ENGINES[s.labId]; return { session: { id: s.id, run: s.run, status: s.status, createdAt: s.createdAt }, view: e.view(s.state), status: e.status(s.state) }; };

  api.post('/labs/:labId/sessions', (req, res) => {
    const e = engineOf(req.params.labId); if (!e) return res.status(404).json({ error: 'Lab not found.', code: 'SCENARIO_NOT_FOUND' });
    const user = (req as any).user;
    const mode = ['beginner', 'intermediate', 'advanced'].includes(req.body?.mode) ? req.body.mode : undefined;
    const active = store.sessionsOf(user.id, e.labId).find(s => s.status === 'active') || store.createSession(user.id, e.labId, e.createInitialState(mode));
    res.json(snapshot(active));
  });
  api.get('/labs/:labId/runs', (req, res) => {
    const user = (req as any).user; const e = engineOf(req.params.labId); if (!e) return res.status(404).json({ error: 'Lab not found.', code: 'SCENARIO_NOT_FOUND' });
    res.json(store.sessionsOf(user.id, e.labId).map(s => { const st = e.status(s.state); return { id: s.id, run: s.run, status: s.status, createdAt: s.createdAt, level: st.level, score: st.score.total, max: st.score.max, complete: st.complete }; }));
  });

  api.param('sid', (req, res, next, sid) => {
    const s = store.session(sid);
    if (!s || s.userId !== (req as any).user.id) return res.status(404).json({ error: 'Session not found.', code: 'LAB_INSTANCE_NOT_FOUND' });
    (req as any).session = s; next();
  });
  api.get('/sessions/:sid', (req, res) => res.json(snapshot((req as any).session)));

  api.post('/sessions/:sid/actions', (req, res) => {
    const s: Session = (req as any).session; const e = ENGINES[s.labId];
    const { type, params, requestId } = req.body || {};
    if (typeof type !== 'string' || type.length > 60) return res.status(400).json({ error: 'Invalid action.', code: 'VALIDATION_FAILED' });
    if (typeof requestId !== 'string' || !/^[\w-]{8,64}$/.test(requestId)) return res.status(400).json({ error: 'requestId is required.', code: 'VALIDATION_FAILED' });
    if (s.status !== 'active') return res.status(409).json({ error: 'This run is archived and read-only.', code: 'LAB_INSTANCE_EXPIRED' });
    if (hasOwn(s.requests, requestId)) return res.json({ ...s.requests[requestId], replayed: true, ...snapshot(s) });
    const { state, result } = e.dispatch(s.state, { type, params });
    store.commit(s, state, requestId, result);
    res.json({ ...result, ...snapshot(s) });
  });

  api.get('/sessions/:sid/report', (req, res) => { const s: Session = (req as any).session; res.json(ENGINES[s.labId].report(s.state, { learner: (req as any).user.name, run: s.run, sessionId: s.id })); });

  api.post('/sessions/:sid/reset', (req, res) => {
    const s: Session = (req as any).session; const e = ENGINES[s.labId];
    if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: 'Reset must be confirmed.', code: 'VALIDATION_FAILED' });
    const mode = ['beginner', 'intermediate', 'advanced'].includes(req.body?.mode) ? req.body.mode : s.state.mode;
    res.json(snapshot(store.createSession(s.userId, s.labId, e.createInitialState(mode))));
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.', code: 'SCENARIO_NOT_FOUND' }));

  if (staticDir && fs.existsSync(staticDir)) { app.use(express.static(staticDir)); app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html'))); }
  app.use((err: any, _req: any, res: any, _next: any) => { if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request body.', code: 'VALIDATION_FAILED' }); console.error(err); res.status(500).json({ error: 'Internal error.', code: 'INTERNAL_ERROR' }); });
  return app;
}
