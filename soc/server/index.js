import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, checkConfig } from './config.js';
import { store } from './store.js';
import { repo, onWipe } from './repo.js';
import { listScenarios } from './scenarios/index.js';
import {
  getCase, streamFor, tick, publicCase, caseSummary, acknowledge, pinEvent, unpinEvent,
  addIoc, removeIoc, addNote, saveDraft, tool, action, submit, removeCase, aliasFor, requestHint, recordSearch, createCase, dropAll,
} from './engine/cases.js';
import { publicEvent } from './engine/logstream.js';
import { HttpError } from './engine/response.js';
import { exportMarkdown } from './engine/report.js';
import { demoRouter, tourRouter } from './demo/routes.js';
import { authRouter, sessionMiddleware, requireSession } from './auth.js';
import {
  levelState, levelDetail, startAttempt, abandonAttempt, ownAttempt, publicAttempt, heartbeat, aliasAttempt, publicBadge,
} from './attempts.js';
import { buildFinalReport } from './report/final.js';

for (const w of checkConfig()) console.warn(w);

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use('/api', sessionMiddleware);

const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION, time: Date.now() }));
app.use('/api', requireSession);
app.use('/api', authRouter);

// ---------------------------------------------------------------------------
// Cases: ownership, renaming in and out
// ---------------------------------------------------------------------------
// A case belongs to the user who started it. Walkthrough preview tickets
// (read-only, in memory) belong to nobody and can be read by anyone signed in.
function load(req) {
  const c = getCase(req.params.id);
  if (c.kind !== 'preview' && c.userId !== req.user.uid) throw new HttpError(404, 'not_found', { message: 'Case not found.' });
  tick(c);
  return c;
}
const A = (c) => aliasFor(c);
const out = (res, c, obj, status = 200) => res.status(status).json(A(c).outDeep(obj));
const inBody = (req, c) => A(c).inDeep(req.body || {});

app.get('/api/scenarios', (req, res) => res.json(listScenarios()));

app.get('/api/cases', (req, res) => {
  res.json(store.all().filter((c) => !c.kind && c.userId === req.user.uid).sort((a, b) => b.t0 - a.t0).map((c) => A(c).outDeep(caseSummary(c))));
});
app.post('/api/cases', wrap((req, res) => {
  // Level scenarios start through POST /api/attempts; the guided demo has its own routes.
  createCase({ scenarioId: (req.body || {}).scenarioId });
  res.status(400).json({ error: 'use_attempts', message: 'Start scenarios through POST /api/attempts.' });
}));
app.get('/api/cases/:id', wrap((req, res) => { const c = load(req); out(res, c, publicCase(c)); }));
app.delete('/api/cases/:id', wrap((req, res) => {
  const c = load(req);
  if (c.attemptId) {
    if (c.status === 'closed') throw new HttpError(409, 'not_open', { message: 'Closed attempts are kept in your history and cannot be deleted.' });
    abandonAttempt(req.user, c.attemptId);
    return res.json({ ok: true, abandoned: true });
  }
  removeCase(c);
  return res.json({ ok: true });
}));

app.post('/api/cases/:id/ack', wrap((req, res) => { const c = load(req); acknowledge(c); out(res, c, publicCase(c)); }));

app.get('/api/cases/:id/logs', wrap((req, res) => {
  const c = load(req);
  const q = req.query;
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  // The query is matched against what the analyst sees; it is stored in
  // canonical form so response objectives can check what was reviewed.
  // Queries are bounded like their recorded copies: a longer one is an error, not a slow scan.
  if (q.q !== undefined && String(q.q).length > 300) throw new HttpError(400, 'query_too_long', { message: 'Search queries are limited to 300 characters.' });
  if (q.q) recordSearch(c, A(c).in(String(q.q)));
  const r = streamFor(c).query({
    q: q.q, source: q.source, from: num(q.from), to: num(q.to),
    limit: Math.min(500, num(q.limit) || 100), offset: num(q.offset) || 0, order: q.order,
  });
  out(res, c, { total: r.total, bySource: r.bySource, events: r.events.map(publicEvent) });
}));

app.get('/api/cases/:id/events', wrap((req, res) => {
  const c = load(req);
  const s = streamFor(c);
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 200);
  out(res, c, { events: ids.map((i) => s.get(i)).filter(Boolean).map(publicEvent) });
}));

app.post('/api/cases/:id/pins', wrap((req, res) => { const c = load(req); const b = inBody(req, c); pinEvent(c, b.eventId, b.note); out(res, c, publicCase(c)); }));
app.delete('/api/cases/:id/pins/:eventId', wrap((req, res) => { const c = load(req); unpinEvent(c, req.params.eventId); out(res, c, publicCase(c)); }));
app.post('/api/cases/:id/iocs', wrap((req, res) => { const c = load(req); addIoc(c, inBody(req, c)); out(res, c, publicCase(c)); }));
app.post('/api/cases/:id/iocs/remove', wrap((req, res) => { const c = load(req); removeIoc(c, inBody(req, c).value); out(res, c, publicCase(c)); }));
app.post('/api/cases/:id/notes', wrap((req, res) => { const c = load(req); addNote(c, inBody(req, c).text); out(res, c, publicCase(c)); }));
app.put('/api/cases/:id/draft', wrap((req, res) => { const c = load(req); saveDraft(c, inBody(req, c)); res.json({ ok: true }); }));

app.post('/api/cases/:id/tools/:tool', wrap((req, res) => {
  const c = load(req);
  const raw = req.body || {};
  const body = { ...inBody(req, c), _visibleInput: typeof raw.input === 'string' ? raw.input : undefined };
  const result = tool(c, req.params.tool, body);
  out(res, c, { result, case: publicCase(c) });
}));

app.post('/api/cases/:id/actions', wrap(async (req, res) => {
  // Security consoles take a moment to apply a change; the action is
  // executed when that round-trip completes.
  await new Promise((r) => setTimeout(r, process.env.SOC_SIM_FAST ? 0 : 600));
  const c = load(req);
  const rec = action(c, inBody(req, c));
  out(res, c, { action: rec, case: publicCase(c) });
}));

app.post('/api/cases/:id/submit', wrap((req, res) => {
  const c = load(req);
  const outcome = submit(c, inBody(req, c));
  const body = { outcome, case: publicCase(c) };
  if (c.attemptResult) {
    const r = c.attemptResult;
    body.attempt = { attemptId: c.attemptId, score: r.score, passMark: r.passMark, passed: r.passed, best: r.best, newBest: r.newBest };
    body.awards = r.awards;
    delete c.attemptResult;
  }
  out(res, c, body);
}));

app.post('/api/cases/:id/hint', wrap((req, res) => {
  const c = load(req);
  const b = req.body || {};
  out(res, c, requestHint(c, String(b.stageId || ''), String(b.fieldId || '')));
}));

app.post('/api/cases/:id/heartbeat', wrap((req, res) => {
  const c = load(req);
  heartbeat(c, !!(req.body || {}).visible);
  res.status(204).end();
}));

app.get('/api/cases/:id/export', wrap((req, res) => {
  const c = load(req);
  const pub = A(c).outDeep(publicCase(c));
  if (req.query.format === 'md') {
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${pub.ticket}.md"`);
    res.send(exportMarkdown(pub));
  } else {
    res.set('Content-Disposition', `attachment; filename="${pub.ticket}.json"`);
    res.json(pub);
  }
}));

// Live stream: new log lines every second, plus a nudge whenever the case changes.
// Each connection holds a timer and a response for as long as the tab is open, so a user gets at
// most MAX_SSE_PER_USER at once and a closed case ends its stream rather than ticking for ever.
// Every "logs" message carries the last sequence number as its SSE id, so a
// browser that reconnects (Last-Event-ID) or a client that reopens the stream
// (?after=<seq>) receives the lines it missed instead of a silent gap.
const MAX_SSE_PER_USER = 3;
const sseOpen = new Map(); // uid -> open connections
export const openStreamsOf = (uid) => sseOpen.get(uid) || 0;
app.get('/api/cases/:id/stream', wrap((req, res) => {
  const c = load(req);
  const uid = req.user.uid;
  if (openStreamsOf(uid) >= MAX_SSE_PER_USER) throw new HttpError(429, 'too_many_streams', { message: `At most ${MAX_SSE_PER_USER} live consoles can be open at once. Close another tab and retry.`, retryAfter: 5 });
  const stream = streamFor(c);
  const alias = A(c);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  sseOpen.set(uid, openStreamsOf(uid) + 1);
  const resume = Number(req.get('Last-Event-ID') ?? req.query.after);
  // A resume point from before a restart may be ahead of this stream: start live then.
  let seq = Number.isInteger(resume) && resume >= 0 && resume <= stream.seq ? resume : stream.seq;
  let rev = c.rev;
  let done = false;
  const send = (event, data, id) => res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    const n = openStreamsOf(uid) - 1;
    if (n > 0) sseOpen.set(uid, n); else sseOpen.delete(uid);
  };
  send('hello', { time: Date.now(), rev });
  const timer = setInterval(() => {
    try {
      if (!store.get(c.id) && c.kind !== 'preview') { send('closed', {}); finish(); res.end(); return; }
      tick(c);
      const fresh = stream.since(seq);
      if (fresh.length) {
        seq = fresh[fresh.length - 1].seq;
        send('logs', alias.outDeep(fresh.map(publicEvent)), seq);
      } else res.write(': keep-alive\n\n');
      if (c.rev !== rev) { rev = c.rev; send('case', { rev }); }
      if (c.status === 'closed') { send('closed', {}); finish(); res.end(); }
    } catch (err) {
      console.error(err);
    }
  }, 1000);
  req.on('close', finish);
  res.on('close', finish);
}));

// ---------------------------------------------------------------------------
// Levels, attempts, internal badges, report
// ---------------------------------------------------------------------------
app.get('/api/levels', (req, res) => res.json(levelState(req.user.uid)));
app.get('/api/levels/:level', wrap((req, res) => res.json(levelDetail(req.user.uid, req.params.level))));

app.post('/api/attempts', wrap((req, res) => {
  const b = req.body || {};
  const a = startAttempt(req.user, String(b.scenarioId || ''), { canonical: b.canonical, seed: b.seed, backdate: b.backdate });
  res.status(201).json({ attemptId: a.attemptId, caseId: a.caseId });
}));
app.get('/api/attempts', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20));
  const before = req.query.before ? String(req.query.before) : null;
  const all = repo.listAttempts(req.user.uid).filter((a) => !before || a.startedAt < before);
  res.json({ total: all.length, attempts: all.slice(0, limit).map((a) => publicAttempt(a)) });
});
app.get('/api/attempts/:id', wrap((req, res) => {
  const a = ownAttempt(req.user, req.params.id);
  res.json(aliasAttempt(a, publicAttempt(a, { full: true })));
}));
app.post('/api/attempts/:id/abandon', wrap((req, res) => res.json(publicAttempt(abandonAttempt(req.user, req.params.id)))));

app.get('/api/awards', (req, res) => res.json({ badges: repo.listAwards(req.user.uid).map(publicBadge) }));
app.get('/api/report', (req, res) => res.json(buildFinalReport(req.user)));

app.get('/api/me/export', (req, res) => {
  const attempts = repo.listAttempts(req.user.uid).map((a) => {
    const { canonical, ...rec } = a;
    return aliasAttempt(a, rec);
  });
  res.set('Content-Disposition', `attachment; filename="soc-simulation-record-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    schema: 'soc-record/1', exportedAt: new Date().toISOString(),
    note: `Practice record from the ThreatReady SOC Simulation. Internal progress only; not a certification or professional qualification.${config.dailyWipe ? ' Records reset daily at 00:00 UTC.' : ''}`,
    user: { uid: req.user.uid, name: req.user.name },
    attempts,
    badges: repo.listAwards(req.user.uid),
  });
});

// Admin-portal pull (section 8.5). Disabled unless TR_EXPORT_TOKEN is set.
app.get('/api/export/attempts', (req, res) => {
  if (!config.exportToken) return res.status(404).json({ error: 'not_found', message: 'Export is not enabled.' });
  const auth = String(req.headers.authorization || '');
  const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(config.exportToken);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'unauthorized', message: 'Bearer token required.' });
  const since = req.query.since ? String(req.query.since) : '';
  return res.json({ attempts: repo.allAttempts().filter((a) => a.status !== 'open' && (!since || (a.closedAt || a.startedAt) >= since)) });
});

app.use('/api/demo', demoRouter);
app.use('/api/tour', tourRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'Not found.' }));

const dist = path.join(here, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('Client not built. Run: npm run build'));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    const code = /^[a-z_]+$/.test(err.message);
    if (err.status === 429) res.set('Retry-After', String(err.extra?.retryAfter ?? 5));
    return res.status(err.status).json({ error: err.message, message: err.extra?.message ?? err.message, ...(err.extra || {}), ...(code ? {} : {}) });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request', message: 'Malformed JSON.' });
  console.error(err);
  return res.status(500).json({ error: 'internal', message: 'Internal error.' });
});

// ---------------------------------------------------------------------------
// Daily wipe at 00:00 UTC (section 8.4)
// ---------------------------------------------------------------------------
onWipe(() => dropAll());
export function msToMidnightUtc(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}
function scheduleWipe() {
  const t = setTimeout(() => {
    console.log('Daily wipe: removing all cases, attempts and badges.');
    repo.wipeAll();
    scheduleWipe();
  }, msToMidnightUtc() + 1000);
  t.unref?.();
}

const port = Number(process.env.PORT) || 4000;
if (process.env.SOC_SIM_NO_LISTEN !== '1') {
  if (config.dailyWipe) scheduleWipe();
  app.listen(port, () => console.log(`SOC simulation running at http://localhost:${port}${config.devUser ? ` (DEV_USER=${config.devUser})` : ''}`));
}

export { app };
