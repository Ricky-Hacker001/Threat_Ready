import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { Store, Session } from './store';
import { cloudLab001, LabEngine } from './engine';
import { CATALOG } from './catalog';
import { IdentityResolver, acceptedInternalTokens, internalTokenMatches } from './identity';
import { HostedLab, HostedSummary, hostedLabs } from './hosted';
import { clientIp, limitFromEnv, rateLimiter } from './ratelimit';
import { requestId, requestIds } from './requestId';
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
  /** Per-caller tokens also accepted on /internal/v1/* (default: env INTERNAL_TOKENS_ACCEPT; see identity.ts). */
  internalTokensAccept?: string[];
  /** Whether the raw `internalToken` is accepted next to the per-caller list (default: env INTERNAL_TOKEN_LEGACY_ACCEPT, false in production). */
  internalTokenLegacyAccept?: boolean;
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
  /** Runs kept per learner and lab: older archived runs are dropped on reset; the best one and the best completed one are always kept (default 5; env LABS_MAX_RUNS_PER_LAB; 0 keeps all). */
  maxRunsPerLab?: number;
  /**
   * Whether server-kept progress outlives a restart of this instance (on Render: the launcher's
   * database mirror is on and saving). Asked per request; default env TR_STATE_DURABLE=1, which
   * deploy/start.mjs sets. Decides whether the catalog says "Saved to your ThreatReady account".
   */
  durable?: () => boolean;
}

/** Set by the launcher (deploy/start.mjs) while lab state is mirrored to its database; read per request. */
export const stateDurable = () => process.env.TR_STATE_DURABLE === '1';
const pct = (score: number, max: number) => (max > 0 ? Math.round((score / max) * 100) : 0);
const runStatus = (s: Session, st: any) => (st.complete ? 'Completed' : s.status === 'archived' ? 'Archived' : 'In progress');
/** A run saved by an older build of the engine may no longer evaluate; it must not take the catalog down. */
const safeStatus = (e: LabEngine, s: Session) => { try { return e.status(s.state); } catch (err) { console.error(`run ${s.id} (${s.labId}) cannot be evaluated: ${(err as Error).message}`); return null; } };
/** A hosted lab's progress for the profile, or null when it cannot answer in time (the summary must not wait on one lab). */
const SUMMARY_TIMEOUT_MS = 1500;
async function hostedSummary(h: HostedLab, userId: string): Promise<HostedSummary | null> {
  if (!h.summary) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([h.summary(userId), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS); })]);
  } catch (err) { console.error(`${h.slug} summary failed: ${(err as Error).message}`); return null; } finally { clearTimeout(timer); }
}

export function createApp(store: Store, staticDir: string | undefined, opts: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  // Per-user API data must never be cached or revalidated by the browser (privacy on shared machines,
  // and a cached 304 must not stand in for a fresh list).
  app.set('etag', false);
  // First: the request id (from the gateway, or minted) for every response, error envelope and log line below.
  app.use(requestIds());
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
  const acceptedTokens = acceptedInternalTokens(opts.internalToken, { accept: opts.internalTokensAccept, legacyAccept: opts.internalTokenLegacyAccept });
  if (!acceptedTokens.length) console.warn('labs: no internal token is accepted (INTERNAL_TOKENS_ACCEPT empty and legacy acceptance off); /internal/v1 will answer 401');
  internal.use((req, res, next) => { if (!internalTokenMatches(req.headers.authorization, acceptedTokens)) return res.status(401).json({ error: 'Internal token required.' }); next(); });
  internal.get('/users/:userId/summary', async (req, res) => {
    const userId = req.params.userId;
    if (!userId || userId.length > 100) return res.status(400).json({ error: 'Invalid user.' });
    const runs = store.allSessionsOf(userId).filter(s => ENGINES[s.labId]);
    const rows = runs.flatMap(s => { const e = ENGINES[s.labId]; const st = safeStatus(e, s); return st ? [{ s, e, st, percent: pct(st.score.total, st.score.max) }] : []; });
    // Labs with their own server (SOC simulation, Red Team) report their own progress; browser-graded labs keep theirs in the browser.
    const hosted = (await Promise.all((opts.hosted ?? []).map(h => hostedSummary(h, userId)))).filter((x): x is HostedSummary => !!x);
    const labsStarted = new Set(rows.map(r => r.s.labId)).size + hosted.filter(h => h.started).length;
    const labsCompleted = new Set(rows.filter(r => r.st.complete).map(r => r.s.labId)).size + hosted.filter(h => h.completed).length;
    const bests = [...rows.map(r => r.percent), ...hosted.flatMap(h => (h.best === null ? [] : [h.best]))];
    const best = bests.length ? Math.max(...bests) : null;
    const active = rows.filter(r => r.s.status === 'active' && !r.st.complete).length + hosted.reduce((n, h) => n + h.inProgress, 0);
    const origin = opts.appOrigin.replace(/\/+$/, '');
    const items = [
      ...rows.map(r => ({
        id: r.s.id,
        title: `${r.e.title} · run ${r.s.run}`,
        status: r.st.complete ? 'Completed' : r.s.status === 'archived' ? 'Archived' : `In progress · level ${r.st.level}`,
        score: r.percent,
        at: r.s.updatedAt,
        url: `${origin}/labs/${encodeURIComponent(r.s.labId)}`,
      })),
      ...hosted.flatMap(h => h.items),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    res.json({
      app: 'labs',
      stats: [
        { label: 'Labs started', value: labsStarted, hint: `${Object.keys(ENGINES).length + (opts.hosted?.length ?? 0)} available now` },
        { label: 'Labs completed', value: labsCompleted },
        { label: 'Best score', value: best === null ? '—' : `${best}/100` },
        { label: 'In progress', value: active },
        { label: 'Total runs', value: rows.length + hosted.reduce((n, h) => n + h.runs, 0) },
        { label: 'Findings verified', value: rows.filter(r => r.s.status === 'active').reduce((n, r) => n + (r.st.posture?.resolved ?? 0), 0) + hosted.reduce((n, h) => n + (h.findingsVerified ?? 0), 0) },
      ],
      items: items.slice(0, 10),
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

  // Identity: the ThreatReady session from onboard. No session → 401; a trial session → account required.
  // The per-IP limit covers requests that are not yet known to be signed in (no session, or one that
  // needs a lookup), so it also protects the identity lookup; a learner the resolver already knows
  // pays only the per-user limit, so a classroom behind one NAT address is not throttled as one client.
  api.use(async (req, res, next) => {
    try {
      if (!opts.identity.peek?.(req.headers) && !limiter.ip(req, res)) return;
      const r = await opts.identity(req.headers, clientIp(req.headers, req.ip));
      if (r.ok === false) {
        if (r.reason === 'unavailable') return res.status(503).set('Retry-After', '5').json({ error: 'Sign-in is briefly unavailable. Try again in a moment.', code: 'AUTH_PROVIDER_UNAVAILABLE' });
        for (const c of r.setCookies) res.append('Set-Cookie', c);
        return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      }
      for (const c of r.setCookies) res.append('Set-Cookie', c);
      if (r.user.isTrial) return res.status(403).json({ error: 'Labs need a ThreatReady account. Create one to continue.', code: 'AUTH_ACCOUNT_REQUIRED' });
      if (!limiter.user(req, res, r.user.id)) return;
      // Reads never write: the user mirror is refreshed on the first state-changing request only.
      (req as any).user = req.method === 'GET' || req.method === 'HEAD' ? { id: r.user.id, name: r.user.name } : store.upsertUser(r.user.id, r.user.name);
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
    // Where server-kept progress lives: "account" once it outlives a restart (saved with the platform
    // account), else "server" (this instance only). "browser": the lab keeps it in the learner's browser.
    const kept = (opts.durable ?? stateDurable)() ? 'account' : 'server';
    res.json(CATALOG.map(c => {
      // Hosted labs keep their own progress; they are live when this server serves them.
      if (c.href) { const h = opts.hosted?.find(x => `${x.slug}/` === c.href); return { ...c, available: !!h, progress: null, progressIn: h && 'handler' in h ? kept : 'browser', onProfile: !!h?.summary }; }
      const e = ENGINES[c.id];
      if (!e) return { ...c, available: false, progress: null };
      const runs = store.sessionsOf(user.id, c.id);
      const latest = runs[runs.length - 1];
      const where = { progressIn: kept, onProfile: true };
      if (!latest) return { ...c, available: true, progress: null, ...where };
      const st = safeStatus(e, latest);
      if (!st) return { ...c, available: true, progress: null, ...where };
      return { ...c, available: true, ...where, progress: { runs: runs.length, status: runStatus(latest, st), level: st.level, percent: st.progress, score: st.score.total, max: st.score.max, complete: st.complete, updatedAt: latest.updatedAt } };
    }));
  });

  const maxRuns = opts.maxRunsPerLab ?? limitFromEnv('LABS_MAX_RUNS_PER_LAB', 5);
  api.get('/labs/:labId', (req, res) => { const e = engineOf(req.params.labId); if (!e) return res.status(404).json({ error: 'Lab not found.' }); res.json({ ...e.definition(), maxRuns }); });

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
    // A completed run is read-only (the engine refuses every action once the report is in): nothing is
    // stored, and the reply carries the closed run, so a stale tab turns read-only too.
    if (result.code === 'LabComplete' && state === s.state) return res.json({ ...result, ...snapshot(s) });
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
    const next = store.createSession(s.userId, s.labId, e.createInitialState()); // the previous run is archived
    // Runs are capped per learner and lab (a reset loop must not grow the store without bound): the
    // oldest archived runs go first. The best-scoring run stays, so the profile's best score holds, and so
    // does the best completed run (an incomplete run can score higher than a completed one that used
    // hints), so a completed lab stays completed and its final report stays readable.
    if (maxRuns > 0) {
      type Scored = { r: Session; p: number; done: boolean };
      const scored: Scored[] = store.sessionsOf(s.userId, s.labId).map(r => { const st = safeStatus(e, r); return { r, p: st ? pct(st.score.total, st.score.max) : -1, done: !!st?.complete }; });
      const top = (xs: Scored[]) => xs.reduce<Scored | null>((b, x) => (!b || x.p > b.p ? x : b), null);
      const keep = [top(scored), top(scored.filter(x => x.done))].flatMap(x => (x ? [x.r.id] : []));
      store.pruneRuns(s.userId, s.labId, maxRuns, new Set([next.id, ...keep]));
    }
    res.json(snapshot(next));
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  if (staticDir && fs.existsSync(staticDir)) { app.use(express.static(staticDir)); app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html'))); }
  // A request the parsers refuse (a malformed or too large body, an unsupported encoding or charset, an
  // undecodable URL parameter) is the client's fault: a 4xx, never a 500 with a stack in the log. A real
  // fault is logged with the request id (also in the reply), so a learner's report matches the log line.
  app.use((err: any, req: any, res: any, _next: any) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request body.' });
    const status = Number(err?.status ?? err?.statusCode);
    if (status >= 400 && status < 500) return res.status(status).json({ error: err.type ? 'Invalid request body.' : 'Invalid request.' });
    console.error(`[${requestId(req)}] ${req.method} ${req.originalUrl}:`, err); res.status(500).json({ error: 'Internal error.' });
  });
  return app;
}
