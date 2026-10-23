import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { Store, Session } from './store';
import { cloudLab001, LabEngine } from './engine';
import { CATALOG } from './catalog';
import { IdentityResolver, internalTokenMatches } from './identity';
import { HostedLab, hostedLabs } from './hosted';
import { limitFromEnv, rateLimiter } from './ratelimit';
export { loadHostedLabs } from './hosted';

const ENGINES: Record<string, LabEngine> = { [cloudLab001.labId]: cloudLab001 };
const hasOwn = (o: object, k: unknown) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
/** A lab engine by id from the URL ("constructor" and friends are not labs). */
const engineOf = (labId: unknown): LabEngine | undefined => (hasOwn(ENGINES, labId) ? ENGINES[labId as string] : undefined);

export interface AppOptions {
  /** Resolves the shared ThreatReady session (onboard.threatready.io). */
  identity: IdentityResolver;
  /** Secret onboard sends on /internal/v1/* (INTERNAL_API_TOKEN). */
  internalToken: string;
  /** This app's public origin (labs.threatready.io). State-changing requests must come from it. */
  appOrigin: string;
  /** Public onboard origin, for sign-in/sign-out links. */
  onboardUrl: string;
  /** Every ThreatReady app (for the shared header). Optional: the header then shows Home only. */
  apps?: () => Promise<{ key: string; title: string; url: string; status: string }[]>;
  /** Labs that are their own apps, served at /labs/<slug>/ (see hosted.ts). */
  hosted?: HostedLab[];
  /** Requests per minute per signed-in user / per client IP (defaults 120 / 300; env LABS_RATE_PER_MIN, LABS_RATE_IP_PER_MIN; 0 disables). */
  ratePerMin?: number;
  rateIpPerMin?: number;
}

const pct = (score: number, max: number) => (max > 0 ? Math.round((score / max) * 100) : 0);
const runStatus = (s: Session, st: any) => (st.complete ? 'Completed' : s.status === 'archived' ? 'Archived' : 'In progress');
/** A run saved by an older build of the engine may no longer evaluate; it must not take the catalog down. */
const safeStatus = (e: LabEngine, s: Session) => { try { return e.status(s.state); } catch (err) { console.error(`run ${s.id} (${s.labId}) cannot be evaluated: ${(err as Error).message}`); return null; } };

export function createApp(store: Store, staticDir: string | undefined, opts: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  // Per-user API data must never be cached or revalidated by the browser (privacy on shared machines,
  // and a cached 304 must not stand in for a fresh list).
  app.set('etag', false);
  // Token-bucket rate limits for every API call, this app's and the hosted labs' alike (one process on Render).
  const limiter = rateLimiter({
    perUserPerMin: opts.ratePerMin ?? limitFromEnv('LABS_RATE_PER_MIN', 120),
    perIpPerMin: opts.rateIpPerMin ?? limitFromEnv('LABS_RATE_IP_PER_MIN', 300),
    body: (wait) => ({ error: `Too many requests. Try again in ${wait}s.`, code: 'RATE_LIMITED' }),
  });
  // Before the JSON parser: hosted labs read their own request bodies.
  if (opts.hosted?.length) app.use(hostedLabs(opts.hosted, { ...opts, limiter }));
  app.use(express.json({ limit: '64kb' }));

  /* ---------------- Internal API for onboard (profile overview, admin console) ---------------- */
  // Reached in-VPC only, never routed through Cloudflare, and every call carries the internal token.
  const internal = express.Router();
  internal.use((req, res, next) => { if (!internalTokenMatches(req.headers.authorization, opts.internalToken)) return res.status(401).json({ error: 'Internal token required.' }); next(); });
  internal.get('/users/:userId/summary', (req, res) => {
    const userId = req.params.userId;
    if (!userId || userId.length > 100) return res.status(400).json({ error: 'Invalid user.' });
    const runs = store.allSessionsOf(userId).filter(s => ENGINES[s.labId]);
    const rows = runs.flatMap(s => { const e = ENGINES[s.labId]; const st = safeStatus(e, s); return st ? [{ s, e, st, percent: pct(st.score.total, st.score.max) }] : []; });
    const labsStarted = new Set(rows.map(r => r.s.labId)).size;
    const labsCompleted = new Set(rows.filter(r => r.st.complete).map(r => r.s.labId)).size;
    const best = rows.length ? Math.max(...rows.map(r => r.percent)) : null;
    const active = rows.filter(r => r.s.status === 'active' && !r.st.complete);
    const origin = opts.appOrigin.replace(/\/+$/, '');
    res.json({
      app: 'labs',
      stats: [
        { label: 'Labs started', value: labsStarted, hint: `${Object.keys(ENGINES).length + (opts.hosted?.length ?? 0)} available now` },
        { label: 'Labs completed', value: labsCompleted },
        { label: 'Best score', value: best === null ? '—' : `${best}/100` },
        { label: 'In progress', value: active.length },
        { label: 'Total runs', value: rows.length },
        { label: 'Findings verified', value: rows.filter(r => r.s.status === 'active').reduce((n, r) => n + (r.st.posture?.resolved ?? 0), 0) },
      ],
      items: rows.slice(0, 10).map(r => ({
        id: r.s.id,
        title: `${r.e.title} · run ${r.s.run}`,
        status: r.st.complete ? 'Completed' : r.s.status === 'archived' ? 'Archived' : `In progress · level ${r.st.level}`,
        score: r.percent,
        at: r.s.updatedAt,
        url: `${origin}/labs/${encodeURIComponent(r.s.labId)}`,
      })),
      // Labs run on server-side emulators; no LLM calls, so no AI usage.
      aiUsage: null,
    });
  });
  internal.get('/ai-usage', (_req, res) => res.json({ app: 'labs', users: [], byModel: [], byFeature: [] }));
  app.use('/internal/v1', internal);
  app.use('/internal', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  /* ---------------- Browser API ---------------- */
  const api = express.Router();
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // State-changing requests must come from this app's own pages (the session cookie is SameSite=Lax).
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== opts.appOrigin) return res.status(403).json({ error: 'Cross-origin request refused.' });
    next();
  });

  // Per-IP limit before sign-in is resolved (protects the identity lookup too), per-user limit after.
  api.use(limiter.ipMiddleware);

  // Identity: the ThreatReady session from onboard. No session → 401; a trial session → account required.
  api.use(async (req, res, next) => {
    try {
      const r = await opts.identity(req.headers);
      if (r.ok === false) {
        if (r.reason === 'unavailable') return res.status(503).set('Retry-After', '5').json({ error: 'Sign-in is briefly unavailable. Try again in a moment.', code: 'AUTH_PROVIDER_UNAVAILABLE' });
        for (const c of r.setCookies) res.append('Set-Cookie', c);
        return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      }
      for (const c of r.setCookies) res.append('Set-Cookie', c);
      if (r.user.isTrial) return res.status(403).json({ error: 'Labs need a ThreatReady account. Create one to continue.', code: 'AUTH_ACCOUNT_REQUIRED' });
      if (!limiter.user(req, res, r.user.id)) return;
      (req as any).user = store.upsertUser(r.user.id, r.user.name);
      (req as any).platformUser = r.user;
      next();
    } catch (e) { next(e); }
  });

  api.get('/me', (req, res) => {
    const u = (req as any).platformUser;
    res.json({ id: u.id, name: u.name, email: u.email, image: u.image, isAdmin: u.isAdmin, onboardUrl: opts.onboardUrl });
  });

  /** The platform header: onboard plus every app, with this one marked. */
  api.get('/platform', async (_req, res) => {
    res.json({ onboardUrl: opts.onboardUrl, apps: opts.apps ? await opts.apps() : [] });
  });

  /** The catalog with this learner's progress in each playable lab. */
  api.get('/labs', (req, res) => {
    const user = (req as any).user;
    res.json(CATALOG.map(c => {
      // Hosted labs keep their own progress; they are live when this server serves them.
      if (c.href) return { ...c, available: !!opts.hosted?.some(h => `${h.slug}/` === c.href), progress: null };
      const e = ENGINES[c.id];
      if (!e) return { ...c, available: false, progress: null };
      const runs = store.sessionsOf(user.id, c.id);
      const latest = runs[runs.length - 1];
      if (!latest) return { ...c, available: true, progress: null };
      const st = safeStatus(e, latest);
      if (!st) return { ...c, available: true, progress: null };
      return { ...c, available: true, progress: { runs: runs.length, status: runStatus(latest, st), level: st.level, percent: st.progress, score: st.score.total, max: st.score.max, complete: st.complete, updatedAt: latest.updatedAt } };
    }));
  });

  api.get('/labs/:labId', (req, res) => { const e = engineOf(req.params.labId); if (!e) return res.status(404).json({ error: 'Lab not found.' }); res.json(e.definition()); });

  const snapshot = (s: Session) => { const e = ENGINES[s.labId]; return { session: { id: s.id, run: s.run, status: s.status, createdAt: s.createdAt }, cloud: e.view(s.state), status: e.status(s.state) }; };

  api.post('/labs/:labId/sessions', (req, res) => {
    const e = engineOf(req.params.labId); if (!e) return res.status(404).json({ error: 'Lab not found.' });
    const user = (req as any).user;
    const active = store.sessionsOf(user.id, e.labId).find(s => s.status === 'active') || store.createSession(user.id, e.labId, e.createInitialState());
    res.json(snapshot(active));
  });
  api.get('/labs/:labId/runs', (req, res) => {
    const user = (req as any).user; const e = engineOf(req.params.labId); if (!e) return res.status(404).json({ error: 'Lab not found.' });
    // safeStatus: one run saved by an older engine must not hide the others ("Previous runs" in the console).
    res.json(store.sessionsOf(user.id, e.labId).map(s => { const st = safeStatus(e, s); return { id: s.id, run: s.run, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, level: st?.level ?? null, score: st?.score.total ?? null, max: st?.score.max ?? null, complete: !!st?.complete }; }));
  });

  // Ownership check for every session route. 404 (not 403) so session IDs are not confirmed to other users.
  api.param('sid', (req, res, next, sid) => {
    const s = store.session(sid);
    if (!s || s.userId !== (req as any).user.id) return res.status(404).json({ error: 'Session not found.' });
    (req as any).session = s; next();
  });
  api.get('/sessions/:sid', (req, res) => res.json(snapshot((req as any).session)));

  api.post('/sessions/:sid/actions', (req, res) => {
    const s: Session = (req as any).session; const e = ENGINES[s.labId];
    const { type, params, requestId } = req.body || {};
    if (typeof type !== 'string' || type.length > 60) return res.status(400).json({ error: 'Invalid action.' });
    if (typeof requestId !== 'string' || !/^[\w-]{8,64}$/.test(requestId)) return res.status(400).json({ error: 'requestId is required.' });
    if (s.status !== 'active') return res.status(409).json({ error: 'This run is archived and read-only.' });
    if (hasOwn(s.requests, requestId)) return res.json({ ...s.requests[requestId], replayed: true, ...snapshot(s) });
    const { state, result } = e.dispatch(s.state, { type, params });
    store.commit(s, state, requestId, result);
    res.json({ ...result, ...snapshot(s) });
  });

  api.get('/sessions/:sid/cloudtrail', (req, res) => {
    const s: Session = (req as any).session; const q = String(req.query.q || '').toLowerCase().slice(0, 80);
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1); const size = Math.min(50, Math.max(5, parseInt(String(req.query.size || '15'), 10) || 15));
    let rows = [...s.state.cloudtrail.events].reverse();
    if (q) rows = rows.filter((e: any) => [e.id, e.name, e.actor, e.sourceIp, e.resource, e.accessKeyId, e.source, e.outcome, e.region].some(v => String(v || '').toLowerCase().includes(q)));
    if (req.query.readOnly === 'true' || req.query.readOnly === 'false') rows = rows.filter((e: any) => String(e.readOnly) === req.query.readOnly);
    res.json({ total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size) });
  });
  api.get('/sessions/:sid/activity', (req, res) => {
    const s: Session = (req as any).session; const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1); const size = 20;
    const rows = [...s.state.labEvents].reverse();
    res.json({ total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size) });
  });
  api.get('/sessions/:sid/report', (req, res) => { const s: Session = (req as any).session; res.json(ENGINES[s.labId].report(s.state, { learner: (req as any).user.name, run: s.run, sessionId: s.id })); });
  api.post('/sessions/:sid/reset', (req, res) => {
    const s: Session = (req as any).session; const e = ENGINES[s.labId];
    if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: 'Reset must be confirmed.' });
    res.json(snapshot(store.createSession(s.userId, s.labId, e.createInitialState()))); // previous run is archived, not deleted
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  if (staticDir && fs.existsSync(staticDir)) { app.use(express.static(staticDir)); app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html'))); }
  app.use((err: any, _req: any, res: any, _next: any) => { if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request body.' }); console.error(err); res.status(500).json({ error: 'Internal error.' }); });
  return app;
}
