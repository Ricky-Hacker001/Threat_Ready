// ThreatReady launcher for a single small instance (Render free web service).
//  1. Restores the labs' saved state from Postgres (the instance disk is empty after a restart), then
//     opens the public port (Render expects it). /healthz answers 503 "starting" while step 2 runs and,
//     on a release's first boot, until step 3 is done (GATEWAY_BOOT_HEALTH), so a deploy only goes live
//     once it works; Render then keeps the old instance.
//  2. Prepares both Neon databases under a migration lock: onboard's least-privilege app role, then
//     each app's migrations.
//  3. Starts the onboard and InterviewPrep APIs on loopback ports, memory-capped, restarted on crash.
//  4. On SIGTERM: stops taking requests, stops the children, saves the labs' state, exits.
// Required env: see render.yaml; optional settings: deploy/README.md. Nothing here prints a secret.
// Production mode before anything else loads: the in-process SOC lab reads NODE_ENV at import time
// (dev-only session secret, DEV_USER and test hooks are off only in production).
process.env.NODE_ENV ||= 'production';
import { spawn } from 'node:child_process';
import { createHmac, hkdfSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { childEnv, interviewChildEnv, onboardChildEnv, testHooksSet, tunables } from './child-env.mjs';
import { MIGRATION_LOCK_KEY, recordBoot, releaseBooted, strictSsl, withAdvisoryLock, withUser } from './db.mjs';
import { CLIENT_IP_HEADER, createGateway, gatewayConfig } from './gateway.mjs';
import { createStateMirror, stateMirrorConfig } from './state-mirror.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 10000);
const ONBOARD_PORT = Number(process.env.ONBOARD_INTERNAL_PORT || 3200);
const INTERVIEW_PORT = Number(process.env.INTERVIEW_INTERNAL_PORT || 3100);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const log = (msg) => console.log(`[launcher] ${msg}`);
const reason = (err) => (err && typeof err === 'object' ? err.code || err.message : String(err));

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`[launcher] Missing environment variable ${name} (see render.yaml).`); process.exit(1); }
  return v;
}
/** Optional settings are checked before anything starts: a typo fails the deploy instead of being ignored. */
function settings() {
  try {
    return { gateway: gatewayConfig(), mirror: stateMirrorConfig() };
  } catch (err) {
    console.error(`[launcher] ${err instanceof Error ? err.message : String(err)} (see deploy/README.md).`);
    process.exit(1);
  }
}
const SETTINGS = settings();
const ONBOARD_DB = strictSsl(need('ONBOARD_DATABASE_URL'));
const INTERVIEW_DB = strictSsl(need('INTERVIEW_DATABASE_URL'));
const AUTH_SECRET = need('BETTER_AUTH_SECRET');
const INTERNAL_TOKEN = need('INTERNAL_API_TOKEN');
const APP_DB_PASSWORD = need('ONBOARD_APP_DB_PASSWORD');
/** One secret per purpose, derived from the auth secret (HKDF-SHA256) so none is reused across uses. */
const derived = (info) => Buffer.from(hkdfSync('sha256', AUTH_SECRET, 'threatready', info, 32)).toString('hex');
const STORAGE_SIGNING_SECRET = derived('storage-signing');
const SOC_SESSION_SECRET = derived('soc-session');
// The SOC lab (in this process) reads SOC_SESSION_SECRET (older builds: SIM_SESSION_SECRET) at import
// time; set before loadHostedLabs. An operator-provided value wins.
process.env.SOC_SESSION_SECRET ||= process.env.SIM_SESSION_SECRET || SOC_SESSION_SECRET;
process.env.SIM_SESSION_SECRET ||= process.env.SOC_SESSION_SECRET;

/** Cloudflare Turnstile: both keys or none. With exactly one, onboard would refuse to boot. */
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const captchaOn = !!(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);
if (!captchaOn && (TURNSTILE_SITE_KEY || TURNSTILE_SECRET_KEY)) {
  log(`WARNING: ${TURNSTILE_SITE_KEY ? 'TURNSTILE_SECRET_KEY' : 'TURNSTILE_SITE_KEY'} is missing; CAPTCHA is OFF until both Turnstile keys are set.`);
} else if (!captchaOn) {
  log('WARNING: production is running without CAPTCHA (set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY); sign-up relies on rate limits alone.');
}
if (!process.env.SENTRY_DSN) log('WARNING: SENTRY_DSN is not set; errors are only in these logs (no error tracking).');

const ONBOARD_APP_DB = withUser(ONBOARD_DB, 'threatready_app', APP_DB_PASSWORD);
const LABS_DATA_FILE = process.env.LABS_DATA_FILE || '/tmp/threatready-labs.json';
const SOC_DATA_FILE = process.env.SOC_DATA_FILE || '/tmp/threatready-soc/cases.json';
const REDTEAM_DATA_FILE = process.env.REDTEAM_DATA_FILE || '/tmp/threatready-redteam.json';

/* ---------------- Shutdown (Render: SIGTERM, then SIGKILL 30 s later) ---------------- */
const children = new Set();
let stopping = false;
let server = null;
let mirror = null;
let socFlush = null;
const SHUTDOWN_DEADLINE_MS = 25_000;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`${sig}: shutting down`);
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
  // No new requests; open ones (and event streams) are cut when the process exits.
  server?.close();
  server?.closeIdleConnections?.();
  for (const c of children) c.kill('SIGTERM');
  try { socFlush?.(); } catch (err) { log(`SOC flush failed: ${err instanceof Error ? err.message : String(err)}`); }
  await mirror?.stop({ timeoutMs: 15_000 });
  for (let waited = 0; children.size && waited < 5000; waited += 100) await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { shutdown(sig); });

/* ---------------- Lab state: back before the labs read it ---------------- */
// Lab Simulations, SOC and Red Team keep their records in JSON files on this instance's disk, which
// Render empties on every restart, sleep and deploy. The mirror keeps a copy in the InterviewPrep
// database (its own schema, owner connection) and restores the files before the stores load them.
// TR_STATE_DURABLE=1 (read per request by the labs and SOC, in this process) tells learners their
// records are kept with their account; only the mirror sets it, while what it saves survives a restart.
delete process.env.TR_STATE_DURABLE;
if (SETTINGS.mirror.enabled) {
  // SOC keeps several files next to its cases file; mirror that folder, unless it is a shared one
  // (SOC_DATA_FILE straight in /tmp), where only SOC's own files are taken.
  const socDir = path.resolve(path.dirname(SOC_DATA_FILE));
  const socTargets = [os.tmpdir(), '/tmp', '/'].map((d) => path.resolve(d)).includes(socDir)
    ? [path.basename(SOC_DATA_FILE), 'attempts.json', 'awards.json'].map((name) => ({ key: `soc/${name}`, file: path.join(socDir, name) }))
    : [{ key: 'soc', dir: socDir }];
  mirror = createStateMirror({
    connectionString: INTERVIEW_DB, table: SETTINGS.mirror.table, intervalMs: SETTINGS.mirror.intervalMs, maxBytes: SETTINGS.mirror.maxBytes, log,
    targets: [{ key: 'labs', file: LABS_DATA_FILE }, ...socTargets, { key: 'redteam', file: REDTEAM_DATA_FILE }],
    onDurable: (on) => { if (on) process.env.TR_STATE_DURABLE = '1'; else delete process.env.TR_STATE_DURABLE; },
  });
  await mirror.restore();
} else {
  log('state mirror: off (STATE_MIRROR=off); lab, SOC and Red Team progress is lost on restart');
}

/* ---------------- Gateway first: Render needs the port bound quickly ---------------- */
const ready = { onboard: false, interview: false };
/** Per child: when it was last seen ready (0 = never) and consecutive exits since it was last ready. */
const health = { onboard: { lastReady: 0, exits: 0 }, interview: { lastReady: 0, exits: 0 } };
const DEGRADED_AFTER_MS = 60_000;
/** An API that has not answered once this long after the migrations is stuck, not starting. */
const STUCK_AFTER_MS = 5 * 60_000;
/**
 * Boot phase (/healthz 503 "starting"). Always while the migrations run: a failed migration exits, so
 * the deploy never turns healthy and Render keeps the old instance. Then, on a release's first boot
 * (GATEWAY_BOOT_HEALTH=auto) or always (=wait), until both APIs have answered once, so a deploy whose
 * API never starts (bad setting, crash at boot) is not marked live either. A restart or a wake from
 * sleep of a release that booted before waits for the migrations only: Render restarts an instance
 * whose health check fails for 60 s, and a slow wake must not be held at 503 that long.
 */
const boot = { migrated: 0, done: false, waitForApis: SETTINGS.gateway.bootHealth !== 'migrations', recorded: false };
const bothReadyOnce = () => health.onboard.lastReady > 0 && health.interview.lastReady > 0;
/** A child that was ready once and has been down for over a minute (crash loop), or one that never came up (stuck). */
const degraded = () => Object.keys(health).some((k) => !ready[k] && (health[k].lastReady > 0
  ? Date.now() - health[k].lastReady > DEGRADED_AFTER_MS
  : boot.migrated > 0 && Date.now() - boot.migrated > STUCK_AFTER_MS));
/** Called when the migrations finish and when an API becomes ready. */
function checkBoot() {
  if (boot.migrated && bothReadyOnce() && !boot.recorded) {
    // From now on a restart of this release is not a new deploy (see RELEASE_ID).
    boot.recorded = true;
    recordBoot(INTERVIEW_DB, RELEASE_ID).catch((err) => log(`could not note this release as booted (${reason(err)}); its next restart waits for the APIs again`));
  }
  if (boot.done || !boot.migrated || (boot.waitForApis && !bothReadyOnce())) return;
  boot.done = true;
  // Serving now: the lab state mirror starts uploading (a deploy that never gets here never touches the saved copies).
  mirror?.start();
  log(`boot complete after ${Math.round(process.uptime())} s; /healthz is 200`);
}
const readiness = () => ({ ...ready, starting: !boot.done, degraded: degraded(), exits: { onboard: health.onboard.exits, interview: health.interview.exits } });
const store = new (await import('./dist/labs/store.js')).Store(LABS_DATA_FILE);
const labsMod = await import('./dist/labs/app.js');
const labsId = await import('./dist/labs/identity.js');
const arMod = await import('./dist/ar/app.js');
const arId = await import('./dist/ar/identity.js');
const identityUrl = `http://127.0.0.1:${ONBOARD_PORT}`;
// One labs resolver for the labs gate and the Red Team lab behind it: a request makes one onboard
// lookup, and both share one per-client and one global lookup budget.
const labsIdentity = labsId.onboardIdentity({ identityUrl, internalToken: INTERNAL_TOKEN });
// The SOC simulation and the Red Team lab run in this process; DevSecOps and the Firewall are static.
// Records live in /tmp like the other labs, mirrored to Postgres (above; see deploy/README.md).
const hosted = await labsMod.loadHostedLabs(ROOT, {
  catalogUrl: `${PUBLIC_URL}/labs/`, socDataFile: SOC_DATA_FILE,
  identity: labsIdentity, appOrigin: new URL(PUBLIC_URL).origin, onboardUrl: PUBLIC_URL,
  redTeamServer: path.join(import.meta.dirname, 'dist/redteam'), redTeamDataFile: REDTEAM_DATA_FILE, internalToken: INTERNAL_TOKEN,
});
// SOC debounces its writes; on shutdown they are flushed before the last state upload. Same module
// instance as the one hosted.ts loaded (same file URL).
if (hosted.some((h) => h.slug === 'soc')) {
  const socStore = await import(pathToFileURL(path.join(ROOT, 'soc/server/store.js')).href);
  if (typeof socStore.flushAll === 'function') socFlush = socStore.flushAll;
}
// Every store has read its file now. One that rejected a restored copy (moved it aside as .corrupt)
// starts empty; its saved copy is kept aside before that empty store can replace it.
await mirror?.checkRestored();
const labsApp = labsMod.createApp(store, path.join(ROOT, 'threatready-lab-001/dist'), {
  identity: labsIdentity,
  internalToken: INTERNAL_TOKEN, appOrigin: new URL(PUBLIC_URL).origin, onboardUrl: PUBLIC_URL, apps: labsId.onboardApps(identityUrl), hosted,
});
log(`hosted labs: ${hosted.map((h) => h.slug).join(', ') || 'none'}`);
const arApp = arMod.createApp(path.join(ROOT, 'attack-reasoning/dist'), {
  identity: arId.onboardIdentity({ identityUrl, internalToken: INTERNAL_TOKEN }),
  internalToken: INTERNAL_TOKEN, appOrigin: new URL(PUBLIC_URL).origin, onboardUrl: PUBLIC_URL, apps: arId.onboardApps(identityUrl),
  // The reasoning engine is the InterviewPrep API's `reasoning` module (same origin here: the gateway
  // already routes /v1/* to it; this is for onboard's /ar/internal summary and AI-usage calls).
  reasoningApi: { url: `http://127.0.0.1:${INTERVIEW_PORT}`, clientIpHeader: CLIENT_IP_HEADER },
});
const gateway = await createGateway({ onboardPort: ONBOARD_PORT, interviewPort: INTERVIEW_PORT, ready: readiness, labsApp, arApp, config: SETTINGS.gateway });
server = gateway.listen(PORT, () => log(`gateway listening on :${PORT} for ${PUBLIC_URL} (client IP: ${SETTINGS.gateway.clientIp.source}${SETTINGS.gateway.clientIp.source === 'xff-rightmost' ? `, ${SETTINGS.gateway.clientIp.hops} trusted hops` : ''})`));

/* ---------------- Databases ---------------- */
async function prepareOnboardRole() {
  const client = new pg.Client({ connectionString: ONBOARD_DB });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'threatready_app'");
    // Later boots only refresh the password: a non-superuser may not change BYPASSRLS on ALTER ROLE
    // (PostgreSQL 16), and a role created here is NOBYPASSRLS already. Role statements take no bind
    // parameters, so PostgreSQL's own format(%L) quotes the password.
    const template = rows.length
      ? 'ALTER ROLE threatready_app WITH LOGIN PASSWORD %L'
      : 'CREATE ROLE threatready_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L';
    const { rows: [{ sql: roleSql }] } = await client.query('SELECT format($1::text, $2::text) AS sql', [template, APP_DB_PASSWORD]);
    await client.query(roleSql);
    const bypass = await client.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'threatready_app'");
    if (bypass.rows[0]?.rolbypassrls) throw new Error('threatready_app has BYPASSRLS; row-level security would not apply. Recreate the role without it.');
    const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
    await client.query(`GRANT CONNECT ON DATABASE "${db.replace(/"/g, '""')}" TO threatready_app`);
    await client.query('GRANT USAGE ON SCHEMA public TO threatready_app');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO threatready_app');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO threatready_app');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON TYPES TO threatready_app');
  } finally {
    await client.end();
  }
}

/**
 * One-off task (migrations) with the owner connection: gets only the base env plus what is passed.
 * Asynchronous, so the gateway keeps answering health checks while it runs.
 */
function run(label, cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: childEnv(env), stdio: 'inherit' });
    children.add(child);
    child.on('error', (err) => { children.delete(child); reject(err); });
    child.on('exit', (code, signal) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

/* ---------------- Child processes ---------------- */
function supervise(name, cwd, args, env, port, flag) {
  let backoff = 1000;
  const startChild = () => {
    log(`starting ${name}`);
    // Loopback only: the gateway is the sole caller, so the child port is never reachable from outside.
    const child = spawn(process.execPath, args, { cwd, env: childEnv({ ...env, PORT: String(port), HOST: '127.0.0.1' }), stdio: 'inherit' });
    children.add(child);
    const probe = setInterval(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (!ready[flag]) log(`${name} ready`);
        ready[flag] = true; health[flag].lastReady = Date.now(); health[flag].exits = 0; backoff = 1000; clearInterval(probe);
        checkBoot();
      } catch { /* not up yet */ }
    }, 1000);
    child.on('exit', (code) => {
      children.delete(child);
      clearInterval(probe);
      if (ready[flag]) health[flag].lastReady = Date.now();
      ready[flag] = false; health[flag].exits += 1;
      if (stopping) return;
      log(`${name} exited (${code}); restarting in ${backoff / 1000}s (exit ${health[flag].exits} since last ready)`);
      setTimeout(startChild, backoff); backoff = Math.min(backoff * 2, 30_000);
    });
  };
  startChild();
}

// Each child's environment (child-env.mjs): launcher defaults < the operator's optional settings for
// that app < the values the launcher decides (URLs, roles, secrets, mode).
const ctx = {
  publicUrl: PUBLIC_URL, gatewayPort: PORT, interviewPort: INTERVIEW_PORT, identityUrl, clientIpHeader: CLIENT_IP_HEADER,
  onboardAppDb: ONBOARD_APP_DB, interviewDb: INTERVIEW_DB, authSecret: AUTH_SECRET, internalToken: INTERNAL_TOKEN, storageSigningSecret: STORAGE_SIGNING_SECRET,
  turnstile: captchaOn ? { siteKey: TURNSTILE_SITE_KEY, secretKey: TURNSTILE_SECRET_KEY } : null,
};
const onboardEnv = onboardChildEnv(ctx);
const interviewEnv = interviewChildEnv(ctx);
const names = (o) => Object.keys(o).sort().join(', ') || 'none';
log(`optional settings forwarded (names only): onboard: ${names(tunables('onboard'))}; InterviewPrep: ${names(tunables('interview'))}`);
const ignored = testHooksSet('onboard');
if (ignored.length) log(`WARNING: ${ignored.join(', ')} ${ignored.length > 1 ? 'are test settings' : 'is a test setting'} that onboard refuses in production; not forwarded.`);

/**
 * This release, for the boot rule above: the commit and every value the children get. An HMAC with a
 * purpose-derived key, so the stored fingerprint reveals nothing; new code or new settings = new release.
 */
const sortedEntries = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const RELEASE_ID = createHmac('sha256', derived('boot-record'))
  .update(JSON.stringify([process.env.RENDER_GIT_COMMIT ?? '', sortedEntries(onboardEnv), sortedEntries(interviewEnv)])).digest('hex');
const releaseKnown = SETTINGS.gateway.bootHealth === 'auto' ? releaseBooted(INTERVIEW_DB, RELEASE_ID) : Promise.resolve(false);

// Licensed 3D interviewer (never in git): a Render Secret File named interviewer.glb, if provided.
const glbSecret = '/etc/secrets/interviewer.glb';
const glbTarget = path.join(ROOT, 'InterviewPrep/apps/api/assets/interviewer.glb');
if (fs.existsSync(glbSecret) && !fs.existsSync(glbTarget)) {
  fs.mkdirSync(path.dirname(glbTarget), { recursive: true });
  fs.copyFileSync(glbSecret, glbTarget);
  log('interviewer model installed from secret file');
}

async function prepareDatabases() {
  if (onboardEnv.EMAIL_DRIVER === 'log') throw new Error('RESEND_API_KEY is not set: sign-up and password-reset codes could not be emailed.');
  need('ANTHROPIC_API_KEY');
  // One launcher at a time per database (a deploy overlaps the old instance; a second instance waits).
  log('preparing onboard database');
  await withAdvisoryLock(ONBOARD_DB, MIGRATION_LOCK_KEY, async () => {
    await prepareOnboardRole();
    await run('onboard migrations', path.join(ROOT, 'Threatready-landing-page-main/apps/api'), ['dist/db/migrate.js'], { DATABASE_MIGRATION_URL: ONBOARD_DB });
  }, { log });
  log('preparing InterviewPrep database');
  await withAdvisoryLock(INTERVIEW_DB, MIGRATION_LOCK_KEY, () => run('InterviewPrep migrations', path.join(ROOT, 'InterviewPrep/packages/db'), ['dist/migrate.js'], { DATABASE_URL: INTERVIEW_DB }), { log });
}

try {
  await prepareDatabases();
  if (await releaseKnown) {
    boot.waitForApis = false;
    log('restart of a release that booted before: /healthz is 200 from now on while the APIs start');
  } else if (boot.waitForApis) {
    log('first boot of this release (new code or settings): /healthz stays 503 until both APIs have started');
  }
  boot.migrated = Date.now();
  checkBoot();
} catch (err) {
  // While shutting down, the migration was stopped on purpose; shutdown() saves state and exits.
  if (!stopping) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[launcher] ${msg}`);
    if (/permission denied to (alter|create) role/.test(msg)) {
      console.error('[launcher] The database user must be able to create roles (Neon\'s owner role can). If a role named threatready_app already exists and belongs to another user, drop it or use a fresh project.');
    }
    // This instance never served, so the mirror has uploaded nothing: the saved lab state is unchanged.
    process.exit(1);
  }
}

if (!stopping) {
  // Heap caps keep the three Node processes inside a 512 MB instance (measured: ~375 MB PSS at rest).
  supervise('onboard API', path.join(ROOT, 'Threatready-landing-page-main/apps/api'), ['--max-old-space-size=120', '--max-semi-space-size=2', 'dist/main.js'], onboardEnv, ONBOARD_PORT, 'onboard');
  supervise('InterviewPrep API + worker', path.join(ROOT, 'InterviewPrep/apps/api'), ['--max-old-space-size=200', '--max-semi-space-size=2', 'dist/main.js', 'all'], interviewEnv, INTERVIEW_PORT, 'interview');
}
