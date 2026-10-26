// Labs that ship as their own apps (the SOC simulation, the DevSecOps lab, ThreatReady Firewall),
// served under /labs/<slug>/ behind the platform sign-in. Each keeps its own console and progress;
// ThreatReady gates access, lists them in the catalog and, for labs with their own server (SOC, Red
// Team), folds their progress into the labs summary the profile and admin console show.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptedInternalTokens, type IdentityResolver, type PlatformUser } from './identity';
import { clientIp, type RateLimiter } from './ratelimit';

type Handler = (req: express.Request, res: express.Response, next: express.NextFunction) => void;

/** One learner's progress in a hosted lab with its own server, folded into the labs summary (profile, admin). */
export interface HostedSummary {
  started: boolean; completed: boolean;
  /** Best score, 0–100, or null before anything was scored. */
  best: number | null;
  inProgress: number; runs: number; findingsVerified?: number;
  /** Most recent first; the platform's summary item shape (absolute URLs). */
  items: { id: string; title: string; status: string; score: number | null; at: string; url: string }[];
}

export type HostedLab =
  /** A prebuilt single-page app (built with `vite build --base /labs/<slug>/`). Its progress stays in the browser. */
  | { slug: string; dir: string; allowEval?: boolean; summary?: undefined }
  /** An app with its own server, mounted as middleware. `req.platformUser` is set before it runs. */
  | { slug: string; handler: Handler; summary?: (userId: string) => Promise<HostedSummary | null> };

/** A path under a lab's mount that is its API (any case: Express routes ignore case). */
const API_PATH = /^\/api(?:\/|$)/i;
/** A page request the lab server answers with its index.html (not an API call, not a file). */
const isPage = (req: express.Request) => req.method === 'GET' && !API_PATH.test(req.path) && !/\.[a-z0-9]+$/i.test(req.path) && (req.headers.accept ?? '').includes('text/html');

export interface HostedOptions {
  identity: IdentityResolver;
  /** This app's public origin; state-changing requests must come from it. */
  appOrigin: string;
  /** Public onboard origin, for the sign-in redirect. */
  onboardUrl: string;
  /** Shared API rate limits (per IP before sign-in, per user after). Pages and assets are exempt. */
  limiter?: RateLimiter;
}

const wantsJson = (req: express.Request) => req.method !== 'GET' || API_PATH.test(req.path) || !(req.headers.accept ?? '').includes('text/html');

/** The lab's page with the ThreatReady strip (lab-nav.js: mark, Back, All labs) added, or null if not built. */
const NAV_TAG = '<script src="/labs/lab-nav.js" defer></script>';
export function pageWithNav(index: string): string | null {
  if (!fs.existsSync(index)) return null;
  const html = fs.readFileSync(index, 'utf8');
  if (html.includes('lab-nav.js')) return html;
  return html.includes('</head>') ? html.replace('</head>', `${NAV_TAG}</head>`) : NAV_TAG + html;
}
const sendPage = (res: express.Response, index: string) => {
  const html = pageWithNav(index);
  if (html === null) { res.status(503).type('text').send('This lab is not built yet.'); return; }
  res.set('Cache-Control', 'no-cache').type('html').send(html);
};

/**
 * The policy of a lab's sandbox.html, the one document that may run the learner's code (eval): an
 * opaque origin even when opened directly (no cookies, storage or same-origin requests), and framed
 * only by pages of this origin.
 */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; sandbox allow-scripts; frame-ancestors 'self'";
/** The gateway's page policy with same-origin frames allowed (for a lab page that frames its own sandboxed document). */
const allowSameOriginFrames = (res: express.Response) => {
  const csp = res.getHeader('Content-Security-Policy');
  if (csp) res.setHeader('Content-Security-Policy', String(csp).replace(/frame-src (?!'self')/, "frame-src 'self' "));
};

/** A single-page app: real files first, otherwise index.html (with the ThreatReady strip). Hashed assets are cached for good. */
function spa(dir: string, allowEval: boolean): Handler {
  const index = path.join(dir, 'index.html');
  const router = express.Router();
  if (allowEval) {
    // The lab runs the learner's own code only inside its sandbox.html, framed with sandbox="allow-scripts"
    // (an opaque origin: no cookies, storage or same-origin requests). Only that document may eval, and it
    // is forced into a sandbox even when opened directly (SANDBOX_CSP, below); the lab's pages may frame
    // it and otherwise keep the strict gateway policy (no 'unsafe-eval' on the ThreatReady origin).
    router.use((_req, res, next) => { allowSameOriginFrames(res); next(); });
  }
  router.use(express.static(dir, {
    index: false,
    setHeaders: (res, file) => {
      res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      // Decided by the file actually served, so no spelling of its URL (//sandbox.html, sandbox%2Ehtml)
      // escapes it, and set even where nothing in front sends a policy (the local labs server).
      if (allowEval && path.basename(file) === 'sandbox.html') res.setHeader('Content-Security-Policy', SANDBOX_CSP);
    },
  }));
  router.get(/.*/, (_req, res) => sendPage(res, index));
  return router;
}

export function hostedLabs(labs: HostedLab[], opts: HostedOptions) {
  const router = express.Router();
  const onboard = opts.onboardUrl.replace(/\/+$/, '');

  // API calls (not pages or assets) count against the shared rate limits. The gate runs under /<slug>,
  // so req.path is the lab's own path; Express matches routes in any case, so this does too.
  const isApi = (req: express.Request) => req.method !== 'GET' || API_PATH.test(req.path);

  // Platform sign-in for every page, asset and API call. Pages bounce to onboard and back.
  const gate: Handler = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== opts.appOrigin) {
      res.status(403).json({ error: 'forbidden', message: 'Cross-origin request refused.' });
      return;
    }
    const limited = !!opts.limiter && isApi(req);
    const tooMany = (wait: number) => { res.status(429).set('Retry-After', String(wait)).set('Cache-Control', 'no-store').json({ error: 'rate_limited', message: `Too many requests. Try again in ${wait}s.` }); };
    // Per IP: API calls not yet known to be signed in, and any request that needs a session lookup (that
    // protects onboard). A learner the resolver already knows pays only the per-user limit below, so
    // learners sharing one NAT address are not throttled as one client.
    if (opts.limiter && !opts.identity.peek?.(req.headers) && (limited || !!req.headers.cookie)) { const wait = opts.limiter.ipWait(req); if (wait) { tooMany(wait); return; } }
    opts.identity(req.headers, clientIp(req.headers, req.ip)).then((r) => {
      if (r.ok === false && r.reason === 'unavailable') {
        res.status(503).set('Retry-After', '5').json({ error: 'auth_unavailable', message: 'Sign-in is briefly unavailable. Try again in a moment.' });
        return;
      }
      for (const c of r.setCookies) res.append('Set-Cookie', c);
      const back = `${onboard}/?next=${encodeURIComponent(opts.appOrigin + req.originalUrl)}`;
      if (r.ok === false) {
        if (wantsJson(req)) res.status(401).json({ error: 'auth_required', message: 'Your ThreatReady session has ended. Reload the page to sign in again.' });
        else res.redirect(302, back);
        return;
      }
      if (r.user.isTrial) {
        if (wantsJson(req)) res.status(403).json({ error: 'account_required', message: 'Labs need a ThreatReady account.' });
        else res.redirect(302, `${back}&mode=signup`);
        return;
      }
      if (limited) { const wait = opts.limiter!.userWait(r.user.id); if (wait) { tooMany(wait); return; } }
      (req as any).platformUser = r.user;
      next();
    }, next);
  };

  for (const lab of labs) {
    const serve = 'dir' in lab ? spa(lab.dir, !!lab.allowEval) : lab.handler;
    router.use(`/${lab.slug}`, gate, (req, res, next) => {
      // Relative asset URLs need the trailing slash: /labs/soc → /labs/soc/
      const [p, q] = req.originalUrl.split('?');
      if (req.path === '/' && !p.endsWith('/') && req.method === 'GET') { res.redirect(301, `${p}/${q ? `?${q}` : ''}`); return; }
      serve(req, res, next);
    });
  }
  return router;
}

/**
 * The Cookie header without the SOC's own session cookie. Names are read exactly as the SOC reads them
 * (soc/server/auth.js cookies(): split on ";", name = text before the first "=", trimmed), so a pair
 * the SOC would take for `soc_session` (`soc_session =v`, a tab before "=") never passes.
 */
export function withoutSocSession(cookie: string | undefined): string {
  return (cookie ?? '').split(';').filter((part) => { const i = part.indexOf('='); return !(i > 0 && part.slice(0, i).trim() === 'soc_session'); }).join(';');
}

/**
 * The SOC simulation's Express app, signed in as the platform user. Its own name sign-in and
 * session cookie are bypassed: records belong to the ThreatReady account. The SOC also keeps an
 * identity set by its host over any cookie and refuses its own sign-in routes then (soc/server/auth.js).
 */
export function socHandler(socApp: Handler, index: string): Handler {
  return (req, res, next) => {
    // The page itself gets the ThreatReady strip; the SOC app serves everything else (API, assets).
    if (isPage(req)) { sendPage(res, index); return; }
    const u = (req as any).platformUser as PlatformUser;
    req.headers.cookie = withoutSocSession(req.headers.cookie);
    (req as any).user = { uid: `tr_${u.id}`, name: u.name };
    // Express 5 serves req.query from a prototype getter, which the SOC app's Express 4 replaces
    // with its own prototype; keep the parsed query as a plain property.
    Object.defineProperty(req, 'query', { value: { ...req.query }, writable: true, configurable: true, enumerable: true });
    socApp(req, res, next);
  };
}

/**
 * The hosted labs found next to this app in the ThreatReady checkout (root = the folder holding
 * soc/, DevSecOps-Simulation/, ThreatWall/, AI-Security/ and red_team_lab/). A lab that isn't built is left out (shown as coming soon).
 */
export interface HostedLoadOptions {
  catalogUrl: string;
  socDataFile?: string;
  /**
   * For the Red Team lab, which checks the platform session itself. In-process (deploy/start.mjs) it is
   * this app's resolver; the labs child passes one presenting the Red Team's own to-onboard token.
   */
  identity: IdentityResolver;
  appOrigin: string;
  onboardUrl: string;
  redTeamDataFile?: string;
  /** Folder with the Red Team lab's server modules (app, store). Default: its TypeScript sources. */
  redTeamServer?: string;
  /**
   * The token onboard sends this app on /internal/v1 (onboard→labs); the Red Team lab's /internal/v1 accepts
   * what this app accepts. Its summary (folded into the labs summary) is fetched with a process-local token,
   * so it is served whatever is passed here. Default: INTERNAL_API_TOKEN.
   */
  internalToken?: string;
  /** Per-caller tokens the Red Team lab's /internal/v1 also accepts (same list as this app: onboard→labs). Default: env INTERNAL_TOKENS_ACCEPT. */
  internalTokensAccept?: string[];
  /** Whether the raw token stays accepted beside the per-caller list. Default: env INTERNAL_TOKEN_LEGACY_ACCEPT (false in production). */
  internalTokenLegacyAccept?: boolean;
}

const SUMMARY_FETCH_MS = 1200;
const int = (v: unknown) => { const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : null; };

/** The SOC simulation's own summary (soc/server/summary.js userSummary) in the labs summary's terms. */
export function socSummary(s: any, origin: string): HostedSummary | null {
  if (!s || typeof s !== 'object') return null;
  const url = (caseId?: string | null) => `${origin}/labs/soc/${caseId ? `#/case/${encodeURIComponent(caseId)}` : ''}`;
  return {
    started: (s.attempts ?? 0) > 0, completed: !!s.complete, best: int(s.best), inProgress: s.open ?? 0, runs: (s.attempts ?? 0) - (s.abandoned ?? 0),
    items: (Array.isArray(s.items) ? s.items : []).map((i: any) => ({ id: String(i.attemptId), title: `SOC Simulation · ${i.code} ${i.title}`, status: String(i.status), score: int(i.score), at: String(i.at), url: url(i.caseId) })),
  };
}

/**
 * The Red Team lab's /internal/v1 summary (red_team_lab/web/server/app.ts) in the labs summary's terms.
 * Reads `totals` when the lab sends them, otherwise its stat labels; links point at its mount here.
 */
export function redTeamSummary(body: any, origin: string): HostedSummary | null {
  if (!body || !Array.isArray(body.stats)) return null;
  const stat = (label: string) => body.stats.find((x: any) => x?.label === label)?.value;
  const t = body.totals && typeof body.totals === 'object' ? body.totals : {};
  const items = (Array.isArray(body.items) ? body.items : []).map((i: any) => ({ id: String(i.id), title: String(i.title), status: String(i.status), score: int(i.score), at: String(i.at), url: `${origin}/labs/redteam/` }));
  return {
    started: (int(t.started) ?? int(stat('Engagements started')) ?? 0) > 0,
    completed: (int(t.completed) ?? int(stat('Completed')) ?? 0) > 0,
    best: int(t.best) ?? int(stat('Best score')),
    inProgress: int(t.inProgress) ?? items.filter((i: any) => /^In progress/.test(i.status)).length,
    runs: int(t.runs) ?? items.length,
    findingsVerified: int(t.findingsVerified) ?? int(stat('Findings verified')) ?? 0,
    items,
  };
}

export async function loadHostedLabs(root: string, opts: HostedLoadOptions): Promise<HostedLab[]> {
  const origin = opts.appOrigin.replace(/\/+$/, '');
  const labs: HostedLab[] = [];
  const devsecops = path.join(root, 'DevSecOps-Simulation', 'dist');
  if (fs.existsSync(path.join(devsecops, 'index.html'))) labs.push({ slug: 'devsecops', dir: devsecops, allowEval: true });
  const threatwall = path.join(root, 'ThreatWall', 'dist');
  if (fs.existsSync(path.join(threatwall, 'index.html'))) labs.push({ slug: 'threatwall', dir: threatwall });
  const aisec = path.join(root, 'AI-Security', 'dist');
  if (fs.existsSync(path.join(aisec, 'index.html'))) labs.push({ slug: 'aisec', dir: aisec });
  const soc = path.join(root, 'soc', 'server', 'index.js');
  if (fs.existsSync(soc) && fs.existsSync(path.join(root, 'soc', 'client', 'dist', 'index.html'))) {
    // Read once when the module loads: mounted here (no listener of its own), records kept, a link back.
    process.env.SOC_SIM_NO_LISTEN = '1';
    process.env.DAILY_WIPE ??= 'false';
    process.env.TR_HOME_URL = opts.catalogUrl;
    if (opts.socDataFile) process.env.SOC_SIM_DATA = opts.socDataFile;
    const mod = await import(pathToFileURL(soc).href);
    // SOC uids are `tr_<platform id>` here (socHandler); older SOC builds have no summary to give.
    const summary = typeof mod.userSummary === 'function' ? async (userId: string) => socSummary(mod.userSummary(`tr_${userId}`), origin) : undefined;
    labs.push({ slug: 'soc', handler: socHandler(mod.app, path.join(root, 'soc', 'client', 'dist', 'index.html')), summary });
  }
  const red = path.join(root, 'red_team_lab', 'web');
  if (fs.existsSync(path.join(red, 'dist', 'index.html'))) {
    // The web pentest lab (TR-RED-001) in platform mode: no dev login, records per ThreatReady account.
    const srv = opts.redTeamServer ?? path.join(red, 'server');
    const ext = opts.redTeamServer ? '.js' : '.ts';
    const { createApp } = await import(pathToFileURL(path.join(srv, `app${ext}`)).href);
    const { Store } = await import(pathToFileURL(path.join(srv, `store${ext}`)).href);
    const given = opts.internalToken ?? process.env.INTERNAL_API_TOKEN;
    // Its /internal/v1 router stays token-checked. It accepts exactly what this app's /internal/v1 accepts
    // (onboard's per-caller tokens; the shared raw INTERNAL_API_TOKEN only with legacy acceptance), plus a
    // token only this process knows, which the labs summary below (its one real caller) presents, so the
    // summary works whatever tokens the launcher passes. (Calls to onboard go through the identity
    // resolver above, which already presents the to-onboard token.)
    const ownToken = crypto.randomBytes(32).toString('hex');
    const accepted = acceptedInternalTokens(given && given.length >= 32 ? given : undefined, { accept: opts.internalTokensAccept, legacyAccept: opts.internalTokenLegacyAccept });
    const app = createApp(new Store(opts.redTeamDataFile ?? path.join(red, 'data', 'store.json')), path.join(red, 'dist'), {
      identity: opts.identity, appOrigin: opts.appOrigin, onboardUrl: opts.onboardUrl, devLogin: false,
      internalToken: ownToken, internalTokensAccept: accepted, internalTokenLegacyAccept: opts.internalTokenLegacyAccept,
      // The gate in front (hostedLabs) already applies the shared per-user and per-IP limits.
      ratePerMin: 0, rateIpPerMin: 0,
    });
    // Its summary is served by its own internal router: called over a loopback-only listener, opened
    // on first use (an Express app needs a real request to answer).
    let loopback: Promise<string> | null = null;
    const base = () => (loopback ??= new Promise<string>((resolve, reject) => {
      const srv = http.createServer(app);
      srv.once('error', (e) => { loopback = null; reject(e); });
      srv.listen(0, '127.0.0.1', () => { srv.unref(); resolve(`http://127.0.0.1:${(srv.address() as any).port}`); });
    }));
    const summary = async (userId: string) => {
      const r = await fetch(`${await base()}/internal/v1/users/${encodeURIComponent(userId)}/summary`, { headers: { authorization: `Bearer ${ownToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(SUMMARY_FETCH_MS) });
      return r.ok ? redTeamSummary(await r.json(), origin) : null;
    };
    const redIndex = path.join(red, 'dist', 'index.html');
    labs.push({ slug: 'redteam', summary, handler: (req, res, next) => {
      // The browser tool frames the lab's own target-frame.html (TR-44), which the Red Team app serves
      // with its own policy (sandboxed, no network, framed only by this origin). Only the lab's pages may
      // frame it (frame-src 'self' added to the base policy); everything else keeps the strict policy.
      if (isPage(req)) { allowSameOriginFrames(res); sendPage(res, redIndex); return; }
      app(req, res, next);
    } });
  }
  return labs;
}
