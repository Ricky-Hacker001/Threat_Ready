// Labs child: Lab Simulations (and the labs it hosts: SOC, Red Team, DevSecOps, Firewall, AI Security) and
// the Attack Reasoning Lab in a process of their own, on a loopback port the gateway proxies to
// (/labs/* and /ar/*, mounted exactly as the gateway used to mount them in-process). A lab emulator
// bug is now contained to this process: it cannot read the gateway's memory or take the public port
// down, and the launcher restarts it like the other children. Started by deploy/start.mjs with an
// explicit environment (deploy/child-env.mjs labsChildEnv); never with the raw INTERNAL_API_TOKEN in
// production.
//
// Lab state: the stores keep their records in the files the launcher restored from its Postgres mirror
// before starting this process (LABS_DATA_FILE, SOC_DATA_FILE, REDTEAM_DATA_FILE). Whether that state
// outlives a restart (TR_STATE_DURABLE, read per request by the labs and SOC) is the mirror's call: the
// launcher sets it in this environment and sends changes over the IPC channel. On SIGTERM the debounced
// SOC writes are flushed before exit; the launcher uploads the final files once this process is gone.
//
// Production mode before anything else loads: the SOC lab reads NODE_ENV at import time.
process.env.NODE_ENV ||= 'production';
import express from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIENT_IP_HEADER, securityHeaders } from './gateway.mjs';
import { boolEnv, gatewayIpToForwardedFor } from './launcher-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || process.env.LABS_INTERNAL_PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';
const ONBOARD_PORT = Number(process.env.ONBOARD_INTERNAL_PORT || 3200);
const INTERVIEW_PORT = Number(process.env.INTERVIEW_INTERNAL_PORT || 3100);
const log = (msg) => console.log(`[labs] ${msg}`);
function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`[labs] Missing environment variable ${name}.`); process.exit(1); }
  return v;
}
const PUBLIC_URL = need('PUBLIC_URL').replace(/\/+$/, '');
const APP_ORIGIN = new URL(PUBLIC_URL).origin;
const identityUrl = `http://127.0.0.1:${ONBOARD_PORT}`;

/* ---------------- Lab state durability (from the launcher's state mirror) ---------------- */
// The starting value comes with the environment (the launcher sets TR_STATE_DURABLE=1 or leaves it out);
// later changes arrive as { type: 'tr-state-durable', on } messages. Nothing else on the channel is read.
process.on('message', (m) => {
  if (!m || typeof m !== 'object' || m.type !== 'tr-state-durable') return;
  if (m.on === true) process.env.TR_STATE_DURABLE = '1';
  else delete process.env.TR_STATE_DURABLE;
});

/**
 * Per-caller tokens (TOKEN_SPEC.md). Each app accepts exactly one caller (onboard) and presents its own
 * token to onboard, so a single value per direction is enough. Local dev without the launcher falls back
 * to INTERNAL_API_TOKEN, as every app does.
 */
const token = (...names) => { for (const n of names) if (process.env[n]) return process.env[n].split(',')[0]; return undefined; };
const RAW = process.env.INTERNAL_API_TOKEN;
/** Whether the raw INTERNAL_API_TOKEN is accepted next to the per-caller tokens (launcher default: only outside production). */
const LEGACY_ACCEPT = boolEnv(process.env.INTERNAL_TOKEN_LEGACY_ACCEPT, process.env.NODE_ENV !== 'production');
const labsAccept = token('LABS_INTERNAL_TOKENS_ACCEPT', 'INTERNAL_TOKENS_ACCEPT') ?? RAW;
const arAccept = token('AR_INTERNAL_TOKENS_ACCEPT') ?? labsAccept;
const labsToOnboard = token('LABS_INTERNAL_TOKEN_TO_ONBOARD', 'INTERNAL_TOKEN_TO_ONBOARD') ?? RAW;
const arToOnboard = token('AR_INTERNAL_TOKEN_TO_ONBOARD') ?? labsToOnboard;
const arToInterview = token('AR_INTERNAL_TOKEN_TO_INTERVIEW', 'INTERNAL_TOKEN_TO_INTERVIEW') ?? RAW;
for (const [k, v] of Object.entries({ labsAccept, arAccept, labsToOnboard, arToOnboard, arToInterview })) {
  if (!v || v.length < 32) { console.error(`[labs] internal token ${k} is missing or shorter than 32 characters (set INTERNAL_API_TOKEN or the launcher's derived tokens).`); process.exit(1); }
}
// Hosted labs that read the environment (Attack Reasoning's call to the reasoning engine, Red Team): the
// spec-named variables, so an app that reads them directly gets the same answer as the options below.
process.env.INTERNAL_TOKEN_TO_INTERVIEW ||= arToInterview;
process.env.INTERNAL_TOKEN_TO_ONBOARD ||= labsToOnboard;

const store = new (await import('./dist/labs/store.js')).Store(process.env.LABS_DATA_FILE || '/tmp/threatready-labs.json');
const labsMod = await import('./dist/labs/app.js');
const labsId = await import('./dist/labs/identity.js');
const arMod = await import('./dist/ar/app.js');
const arId = await import('./dist/ar/identity.js');

// One labs resolver for the labs gate and the hosted labs behind it (Red Team): a request makes one
// onboard lookup, and both share one per-client and one global lookup budget (classroom-safe caps,
// 12 h known-good). It presents the labs->onboard token.
const labsIdentity = labsId.onboardIdentity({ identityUrl, internalToken: labsToOnboard, callerToken: labsToOnboard });
// The SOC simulation and the Red Team lab run in this process; DevSecOps, the Firewall and AI Security are
// static. Each app: the one token it accepts (onboard->app), the token it presents to onboard
// (app->onboard) and, for Attack Reasoning, the token it presents to the reasoning engine (ar->interview).
// SOC and Red Team summaries reach the profile through the labs /internal/v1 summary (hosted.ts).
const hosted = await labsMod.loadHostedLabs(ROOT, {
  catalogUrl: `${PUBLIC_URL}/labs/`, socDataFile: process.env.SOC_DATA_FILE || '/tmp/threatready-soc/cases.json',
  identity: labsIdentity, appOrigin: APP_ORIGIN, onboardUrl: PUBLIC_URL,
  redTeamServer: path.join(import.meta.dirname, 'dist/redteam'), redTeamDataFile: process.env.REDTEAM_DATA_FILE || '/tmp/threatready-redteam.json',
  internalToken: labsAccept, internalTokensAccept: [labsAccept], internalTokenLegacyAccept: LEGACY_ACCEPT,
});
// SOC debounces its writes (250 ms) and, mounted here, installs no signal handler of its own: flushed on
// the way out (below). Same module instance as the one hosted.ts loaded (same file URL).
let socFlush = null;
if (hosted.some((h) => h.slug === 'soc')) {
  const socStore = await import(pathToFileURL(path.join(ROOT, 'soc/server/store.js')).href);
  if (typeof socStore.flushAll === 'function') socFlush = socStore.flushAll;
}
const labsApp = labsMod.createApp(store, path.join(ROOT, 'threatready-lab-001/dist'), {
  identity: labsIdentity,
  internalToken: labsAccept, internalTokensAccept: [labsAccept], internalTokenLegacyAccept: LEGACY_ACCEPT,
  appOrigin: APP_ORIGIN, onboardUrl: PUBLIC_URL, apps: labsId.onboardApps(identityUrl), hosted,
});
log(`hosted labs: ${hosted.map((h) => h.slug).join(', ') || 'none'}`);
const arApp = arMod.createApp(path.join(ROOT, 'attack-reasoning/dist'), {
  identity: arId.onboardIdentity({ identityUrl, internalToken: arToOnboard, callerToken: arToOnboard }),
  internalToken: arAccept, internalTokensAccept: [arAccept], internalTokenLegacyAccept: LEGACY_ACCEPT,
  appOrigin: APP_ORIGIN, onboardUrl: PUBLIC_URL, apps: arId.onboardApps(identityUrl),
  // The reasoning engine is the InterviewPrep API's `reasoning` module (same origin: the gateway already
  // routes /v1/* to it; this is for onboard's /ar/internal summary and AI-usage calls). `token` is what
  // Attack Reasoning presents to InterviewPrep (ar->interview), distinct from the token it accepts.
  reasoningApi: { url: `http://127.0.0.1:${INTERVIEW_PORT}`, clientIpHeader: CLIENT_IP_HEADER, token: arToInterview },
});

const app = express();
app.disable('x-powered-by');
// The gateway is this port's only public caller and stamps CLIENT_IP_HEADER with the visitor's IP on
// every request (over anything the visitor sent). Express derives req.ip from X-Forwarded-For, so that
// value is written there and the loopback peer trusted: every mounted app's req.ip (rate-limit fallback,
// Attack Reasoning's /v1 proxy stamping the engine's client-IP header) is the visitor, not 127.0.0.1.
// The apps that read CLIENT_IP_HEADER directly (per-IP limits, the resolver's per-client caps) keep it.
app.set('trust proxy', 'loopback');
app.use(gatewayIpToForwardedFor(CLIENT_IP_HEADER));
// The platform's security headers on every response from this process: the hosted labs adjust the CSP
// per path (DevSecOps sandbox, Red Team target frame) on top of this base, and the gateway lets an
// upstream CSP win, so the base must be set here, not only in the gateway.
app.use(securityHeaders);
// Readiness probe for the launcher (loopback only; the gateway never routes "/" here). The stores have
// read their files once this answers (the launcher then checks what they accepted).
app.get('/', (_req, res) => res.json({ ok: true, heapUsed: process.memoryUsage().heapUsed, labs: hosted.map((h) => h.slug) }));
app.use('/labs', labsApp);
app.use('/ar', arApp);
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

const server = app.listen(PORT, HOST, () => log(`labs child listening on ${HOST}:${PORT}`));
server.on('error', (err) => { console.error(`[labs] cannot listen on ${HOST}:${PORT}: ${err.message}`); process.exit(1); });

/* ---------------- Shutdown ---------------- */
const flushSoc = (when) => {
  try { socFlush?.(); } catch (err) { console.error(`[labs] SOC flush ${when} failed: ${err instanceof Error ? err.message : String(err)}`); }
};
// Whatever ends the process (SIGTERM, a fatal error, the launcher going away), pending SOC writes reach
// the disk first. The Lab Simulations and Red Team stores write synchronously.
process.on('exit', () => flushSoc('at exit'));
let stopping = false;
function stop(why) {
  if (stopping) return;
  stopping = true;
  log(`${why}: stopping`);
  // Stop accepting, drop idle keep-alive connections from the gateway (otherwise close() waits for them),
  // write SOC's pending changes now, and exit once open requests finish; 2 s later regardless (event
  // streams never finish). The 'exit' handler flushes again for anything written meanwhile.
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  flushSoc('on shutdown');
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stop(sig));
// Started by the launcher with an IPC channel: if the launcher goes away, so does this process (it must
// never keep serving, or hold the port, unsupervised).
if (process.send) process.on('disconnect', () => stop('launcher gone'));
