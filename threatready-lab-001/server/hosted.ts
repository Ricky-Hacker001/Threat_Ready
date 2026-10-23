// Labs that ship as their own apps (the SOC simulation, the DevSecOps lab, ThreatReady Firewall),
// served under /labs/<slug>/ behind the platform sign-in. Each keeps its own console and progress;
// ThreatReady only gates access and lists them in the catalog.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IdentityResolver, PlatformUser } from './identity';
import type { RateLimiter } from './ratelimit';

type Handler = (req: express.Request, res: express.Response, next: express.NextFunction) => void;

export type HostedLab =
  /** A prebuilt single-page app (built with `vite build --base /labs/<slug>/`). */
  | { slug: string; dir: string; allowEval?: boolean }
  /** An app with its own server, mounted as middleware. `req.platformUser` is set before it runs. */
  | { slug: string; handler: Handler };

export interface HostedOptions {
  identity: IdentityResolver;
  /** This app's public origin; state-changing requests must come from it. */
  appOrigin: string;
  /** Public onboard origin, for the sign-in redirect. */
  onboardUrl: string;
  /** Shared API rate limits (per IP before sign-in, per user after). Pages and assets are exempt. */
  limiter?: RateLimiter;
}

const wantsJson = (req: express.Request) => req.method !== 'GET' || /\/api\//.test(req.originalUrl) || !(req.headers.accept ?? '').includes('text/html');

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

/** A single-page app: real files first, otherwise index.html (with the ThreatReady strip). Hashed assets are cached for good. */
function spa(dir: string, allowEval: boolean): Handler {
  const index = path.join(dir, 'index.html');
  const router = express.Router();
  if (allowEval) {
    // The lab runs the learner's own code only inside its sandbox.html, framed with sandbox="allow-scripts"
    // (an opaque origin: no cookies, storage or same-origin requests). Only that document may eval, and it
    // is forced into a sandbox even when opened directly; the lab's pages may frame it and otherwise keep
    // the strict gateway policy (no 'unsafe-eval' on the ThreatReady origin).
    router.use((req, res, next) => {
      const csp = res.getHeader('Content-Security-Policy');
      if (csp) {
        res.setHeader('Content-Security-Policy', req.path === '/sandbox.html'
          ? "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; sandbox allow-scripts"
          : String(csp).replace(/frame-src (?!'self')/, "frame-src 'self' "));
      }
      next();
    });
  }
  router.use(express.static(dir, {
    index: false,
    setHeaders: (res, file) => res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  }));
  router.get(/.*/, (_req, res) => sendPage(res, index));
  return router;
}

export function hostedLabs(labs: HostedLab[], opts: HostedOptions) {
  const router = express.Router();
  const onboard = opts.onboardUrl.replace(/\/+$/, '');

  // API calls (not pages or assets) count against the shared rate limits.
  const isApi = (req: express.Request) => req.method !== 'GET' || /\/api\//.test(req.originalUrl.split('?')[0]);

  // Platform sign-in for every page, asset and API call. Pages bounce to onboard and back.
  const gate: Handler = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== opts.appOrigin) {
      res.status(403).json({ error: 'forbidden', message: 'Cross-origin request refused.' });
      return;
    }
    const limited = !!opts.limiter && isApi(req);
    const tooMany = (wait: number) => { res.status(429).set('Retry-After', String(wait)).set('Cache-Control', 'no-store').json({ error: 'rate_limited', message: `Too many requests. Try again in ${wait}s.` }); };
    if (limited) { const wait = opts.limiter!.ipWait(req); if (wait) { tooMany(wait); return; } }
    opts.identity(req.headers).then((r) => {
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
 * The SOC simulation's Express app, signed in as the platform user. Its own name sign-in and
 * session cookie are bypassed: records belong to the ThreatReady account.
 */
export function socHandler(socApp: Handler, index: string): Handler {
  return (req, res, next) => {
    // The page itself gets the ThreatReady strip; the SOC app serves everything else (API, assets).
    if (req.method === 'GET' && !req.path.startsWith('/api') && !/\.[a-z0-9]+$/i.test(req.path) && (req.headers.accept ?? '').includes('text/html')) { sendPage(res, index); return; }
    const u = (req as any).platformUser as PlatformUser;
    req.headers.cookie = (req.headers.cookie ?? '').split(';').filter((c) => c.trim().split('=')[0] !== 'soc_session').join(';');
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
  /** For the Red Team lab, which checks the platform session itself (same resolver as this app). */
  identity: IdentityResolver;
  appOrigin: string;
  onboardUrl: string;
  redTeamDataFile?: string;
  /** Folder with the Red Team lab's server modules (app, store). Default: its TypeScript sources. */
  redTeamServer?: string;
  /** Onboard's internal token, so the Red Team lab's /internal/v1 summary (progress on the profile) is served. Default: INTERNAL_API_TOKEN. */
  internalToken?: string;
}

export async function loadHostedLabs(root: string, opts: HostedLoadOptions): Promise<HostedLab[]> {
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
    labs.push({ slug: 'soc', handler: socHandler(mod.app, path.join(root, 'soc', 'client', 'dist', 'index.html')) });
  }
  const red = path.join(root, 'red_team_lab', 'web');
  if (fs.existsSync(path.join(red, 'dist', 'index.html'))) {
    // The web pentest lab (TR-RED-001) in platform mode: no dev login, records per ThreatReady account.
    const srv = opts.redTeamServer ?? path.join(red, 'server');
    const ext = opts.redTeamServer ? '.js' : '.ts';
    const { createApp } = await import(pathToFileURL(path.join(srv, `app${ext}`)).href);
    const { Store } = await import(pathToFileURL(path.join(srv, `store${ext}`)).href);
    const internalToken = opts.internalToken ?? process.env.INTERNAL_API_TOKEN;
    const app = createApp(new Store(opts.redTeamDataFile ?? path.join(red, 'data', 'store.json')), path.join(red, 'dist'), {
      identity: opts.identity, appOrigin: opts.appOrigin, onboardUrl: opts.onboardUrl, devLogin: false,
      // Same token onboard sends this app: its /internal/v1 router stays token-checked.
      internalToken: internalToken && internalToken.length >= 32 ? internalToken : undefined,
    });
    const redIndex = path.join(red, 'dist', 'index.html');
    labs.push({ slug: 'redteam', handler: (req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !/\.[a-z0-9]+$/i.test(req.path) && (req.headers.accept ?? '').includes('text/html')) { sendPage(res, redIndex); return; }
      app(req, res, next);
    } });
  }
  return labs;
}
