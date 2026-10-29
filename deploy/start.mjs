// ThreatReady launcher for a single small instance (Render free web service).
//  1. Opens the public port at once (Render expects it). /healthz answers 503 "starting" while steps
//     2-3 run and, on a release's first boot, until step 4 is done (GATEWAY_BOOT_HEALTH), so a deploy
//     only goes live once it works; Render then keeps the old instance.
//  2. Restores the labs' saved state from Postgres (the instance disk is empty after a restart), then
//     starts the labs child (deploy/labs-child.mjs: Lab Simulations, the hosted labs and Attack
//     Reasoning), whose stores read it.
//  3. Prepares both Neon databases under a migration lock: onboard's least-privilege app role, then
//     each app's migrations.
//  4. Starts the onboard and InterviewPrep APIs. Every child runs on a loopback port, memory-capped,
//     restarted on crash, with an explicit environment (deploy/child-env.mjs) and per-caller internal
//     tokens derived from INTERNAL_API_TOKEN (deploy/launcher-lib.mjs); no child's environment carries
//     the raw token in production. Every process runs as the same user, so that is defence in depth:
//     code running in a child can still read this process's /proc/<pid>/environ (deploy/README.md,
//     "Limits of the isolation").
//  5. On SIGTERM: stops taking requests, stops the children (the labs child writes its last lab
//     changes), saves the labs' state, exits, all within Render's 30 s.
// Required env: see render.yaml; optional settings: deploy/README.md. Nothing here prints a secret.
process.env.NODE_ENV ||= 'production';
import { spawn } from 'node:child_process';
import { createHmac, hkdfSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { childEnv, interviewChildEnv, labsChildEnv, onboardChildEnv, testHooksSet, tunables } from './child-env.mjs';
import { MIGRATION_LOCK_KEY, recordBoot, releaseBooted, strictSsl, withAdvisoryLock, withUser } from './db.mjs';
import { CLIENT_IP_HEADER, createGateway, gatewayConfig } from './gateway.mjs';
import { ROLE_PASSWORD_STATE_KEY, boolEnv, captchaCheck, childExitLine, heapUsedOf, internalTokenEnv, passwordDigest, roleSyncNeeded } from './launcher-lib.mjs';
import { createStateMirror, stateMirrorConfig } from './state-mirror.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 10000);
const ONBOARD_PORT = Number(process.env.ONBOARD_INTERNAL_PORT || 3200);
const INTERVIEW_PORT = Number(process.env.INTERVIEW_INTERNAL_PORT || 3100);
const LABS_PORT = Number(process.env.LABS_INTERNAL_PORT || 4000);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const PRODUCTION = process.env.NODE_ENV === 'production';
const log = (msg) => console.log(`[launcher] ${msg}`);
const reason = (err) => (err && typeof err === 'object' ? err.code || err.message : String(err));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`[launcher] Missing environment variable ${name} (see render.yaml).`); process.exit(1); }
  return v;
}
/** Optional settings are checked before anything starts: a typo fails the deploy instead of being ignored. */
function settings() {
  try {
    const ports = [PORT, ONBOARD_PORT, INTERVIEW_PORT, LABS_PORT];
    if (!ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536) || new Set(ports).size !== ports.length) {
      throw new Error('PORT, ONBOARD_INTERNAL_PORT, INTERVIEW_INTERNAL_PORT and LABS_INTERNAL_PORT must be four different port numbers');
    }
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
// The SOC lab (labs child) reads SOC_SESSION_SECRET (older builds: SIM_SESSION_SECRET) at import time; the
// hosted SOC issues no sessions, but its development default is refused in production. An operator value wins.
const SOC_SESSION_SECRET = process.env.SOC_SESSION_SECRET || process.env.SIM_SESSION_SECRET || derived('soc-session');
/**
 * Per-caller internal tokens (TOKEN_SPEC.md): each child accepts only its callers' tokens and presents
 * one minted per callee; none of them is the raw INTERNAL_API_TOKEN, which stays in this process. The raw
 * token is still accepted by the children outside production (INTERNAL_TOKEN_LEGACY_ACCEPT) so local
 * tooling that was configured with it keeps working; in production it opens nothing.
 */
const TOKENS = internalTokenEnv(INTERNAL_TOKEN);
const LEGACY_ACCEPT = boolEnv(process.env.INTERNAL_TOKEN_LEGACY_ACCEPT, !PRODUCTION);
if (LEGACY_ACCEPT && PRODUCTION) log('WARNING: INTERNAL_TOKEN_LEGACY_ACCEPT=true in production: the raw INTERNAL_API_TOKEN opens every internal API.');

/**
 * Cloudflare Turnstile: both keys or none (with exactly one, onboard would refuse to boot). Production
 * without both keys fails here, before anything starts, unless the operator set ALLOW_NO_CAPTCHA=true in
 * the service environment (onboard's own explicit opt-in, audit H4); the launcher never sets it for them.
 */
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const captcha = captchaCheck({ siteKey: TURNSTILE_SITE_KEY, secretKey: TURNSTILE_SECRET_KEY, allowNoCaptcha: process.env.ALLOW_NO_CAPTCHA, production: PRODUCTION });
if (captcha.fatal) { console.error(`[launcher] ${captcha.fatal} (see deploy/README.md, "CAPTCHA").`); process.exit(1); }
if (captcha.warning) log(`WARNING: ${captcha.warning}`);
const captchaOn = captcha.on;
if (!process.env.SENTRY_DSN) log('WARNING: SENTRY_DSN is not set; errors are only in these logs (no error tracking).');

const ONBOARD_APP_DB = withUser(ONBOARD_DB, 'threatready_app', APP_DB_PASSWORD);
const LABS_DATA_FILE = process.env.LABS_DATA_FILE || '/tmp/threatready-labs.json';
const SOC_DATA_FILE = process.env.SOC_DATA_FILE || '/tmp/threatready-soc/cases.json';
const REDTEAM_DATA_FILE = process.env.REDTEAM_DATA_FILE || '/tmp/threatready-redteam.json';
const identityUrl = `http://127.0.0.1:${ONBOARD_PORT}`;

/* ---------------- Shutdown (Render: SIGTERM, then SIGKILL 30 s later) ---------------- */
const children = new Set();
/** The labs child now running (null between restarts): its lab files are final once it has exited. */
let labsChild = null;
let stopping = false;
let server = null;
let mirror = null;
const SHUTDOWN_DEADLINE_MS = 25_000;
const LABS_EXIT_WAIT_MS = 5_000;
/** Resolves true once `child` has exited (at once if it already has), false after `ms`. */
const exitedWithin = (child, ms) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
  const timer = setTimeout(() => resolve(false), ms);
  child.once('exit', () => { clearTimeout(timer); resolve(true); });
});
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`${sig}: shutting down`);
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
  // No new requests; open ones (and event streams) are cut when the children and this process exit.
  server?.close();
  server?.closeIdleConnections?.();
  const labs = labsChild;
  for (const c of children) c.kill('SIGTERM');
  // The labs child flushes SOC's pending writes on its way out (the other stores write at once): the
  // last snapshot is taken only once it is gone, so it holds everything learners did.
  if (labs && !(await exitedWithin(labs, LABS_EXIT_WAIT_MS))) {
    log('labs child did not exit in time; stopping it and saving the lab files as they are');
    labs.kill('SIGKILL');
  }
  await mirror?.stop({ timeoutMs: 15_000 });
  for (let waited = 0; children.size && waited < 5000; waited += 100) await sleep(100);
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { shutdown(sig); });

/* ---------------- Children's environments ---------------- */
// Each child's environment (child-env.mjs): launcher defaults < the operator's optional settings for
// that app < the values the launcher decides (URLs, roles, secrets, tokens, mode).
const ctx = {
  publicUrl: PUBLIC_URL, gatewayPort: PORT, onboardPort: ONBOARD_PORT, interviewPort: INTERVIEW_PORT, labsPort: LABS_PORT, identityUrl, clientIpHeader: CLIENT_IP_HEADER,
  onboardAppDb: ONBOARD_APP_DB, interviewDb: INTERVIEW_DB, authSecret: AUTH_SECRET, storageSigningSecret: STORAGE_SIGNING_SECRET,
  internalToken: INTERNAL_TOKEN, tokens: TOKENS, legacyAccept: LEGACY_ACCEPT,
  // Onboard's config requires an INTERNAL_API_TOKEN; with legacy acceptance off it gets this value, which
  // no other process holds (accepted from no one, presented to no one).
  onboardFillerToken: Buffer.from(hkdfSync('sha256', INTERNAL_TOKEN, 'threatready-internal', 'onboard-unused', 32)).toString('hex'),
  socSessionSecret: SOC_SESSION_SECRET, labsDataFile: LABS_DATA_FILE, socDataFile: SOC_DATA_FILE, redteamDataFile: REDTEAM_DATA_FILE,
  turnstile: captchaOn ? { siteKey: TURNSTILE_SITE_KEY, secretKey: TURNSTILE_SECRET_KEY } : null,
};
const onboardEnv = onboardChildEnv(ctx);
const interviewEnv = interviewChildEnv(ctx);
const labsEnv = labsChildEnv(ctx);
const names = (o) => Object.keys(o).sort().join(', ') || 'none';
log(`optional settings forwarded (names only): onboard: ${names(tunables('onboard'))}; InterviewPrep: ${names(tunables('interview'))}; labs: ${names(tunables('labs'))}`);
for (const [child, what] of [['onboard', 'onboard refuses in production'], ['labs', 'the hosted labs must not get (test or standalone-only)']]) {
  const ignored = testHooksSet(child);
  if (ignored.length) log(`WARNING: ${ignored.join(', ')} ${ignored.length > 1 ? 'are settings' : 'is a setting'} ${what}; not forwarded.`);
}

/**
 * This release, for the boot rule below: the commit and every value the children get. An HMAC with a
 * purpose-derived key, so the stored fingerprint reveals nothing; new code or new settings = new release.
 */
const sortedEntries = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const RELEASE_ID = createHmac('sha256', derived('boot-record'))
  .update(JSON.stringify([process.env.RENDER_GIT_COMMIT ?? '', sortedEntries(onboardEnv), sortedEntries(interviewEnv), sortedEntries(labsEnv)])).digest('hex');
const releaseKnown = SETTINGS.gateway.bootHealth === 'auto' ? releaseBooted(INTERVIEW_DB, RELEASE_ID) : Promise.resolve(false);

/* ---------------- Readiness and boot phases ---------------- */
const CHILDREN = ['onboard', 'interview', 'labs'];
const ready = Object.fromEntries(CHILDREN.map((k) => [k, false]));
/** Per child: when it was last seen ready (0 = never), consecutive exits since it was last ready, last heap sample. */
const health = Object.fromEntries(CHILDREN.map((k) => [k, { lastReady: 0, exits: 0, heapUsed: null }]));
const DEGRADED_AFTER_MS = 60_000;
/** A child that has not answered once this long after the migrations is stuck, not starting. */
const STUCK_AFTER_MS = 5 * 60_000;
/**
 * Boot phase (/healthz 503 "starting"). Always while the lab state is restored and the migrations run:
 * a failed migration exits, so the deploy never turns healthy and Render keeps the old instance. Then,
 * on a release's first boot (GATEWAY_BOOT_HEALTH=auto) or always (=wait), until every child has
 * answered once, so a deploy whose API or labs child never starts (bad setting, crash at boot) is not
 * marked live either. A restart or a wake from sleep of a release that booted before waits for the
 * migrations only: Render restarts an instance whose health check fails for 60 s, and a slow wake must
 * not be held at 503 that long.
 */
const boot = { migrated: 0, done: false, waitForApis: SETTINGS.gateway.bootHealth !== 'migrations', recorded: false };
const allReadyOnce = () => CHILDREN.every((k) => health[k].lastReady > 0);
/** A child that was ready once and has been down for over a minute (crash loop), or one that never came up (stuck). */
const degraded = () => CHILDREN.some((k) => !ready[k] && (health[k].lastReady > 0
  ? Date.now() - health[k].lastReady > DEGRADED_AFTER_MS
  : boot.migrated > 0 && Date.now() - boot.migrated > STUCK_AFTER_MS));
const statusOf = (k) => (ready[k] ? 'ready' : health[k].lastReady > 0 ? 'down' : 'starting');
const readiness = () => ({
  ...ready,
  starting: !boot.done,
  degraded: degraded(),
  status: Object.fromEntries(CHILDREN.map((k) => [k, statusOf(k)])),
  exits: Object.fromEntries(CHILDREN.map((k) => [k, health[k].exits])),
  heapUsed: Object.fromEntries(CHILDREN.map((k) => [k, health[k].heapUsed])),
});
/** Set once the labs child's stores have read the restored files and the mirror has checked what they accepted. */
let labsStoresChecked = false;
/** The mirror uploads only once this instance serves AND the restored files were checked (never an empty store over a refused copy). */
const startMirror = () => { if (boot.done && labsStoresChecked && !stopping) mirror?.start(); };
/** Called when the migrations finish and when a child becomes ready. */
function checkBoot() {
  if (boot.migrated && allReadyOnce() && !boot.recorded) {
    // From now on a restart of this release is not a new deploy (see RELEASE_ID).
    boot.recorded = true;
    recordBoot(INTERVIEW_DB, RELEASE_ID).catch((err) => log(`could not note this release as booted (${reason(err)}); its next restart waits for every child again`));
  }
  if (boot.done || !boot.migrated || (boot.waitForApis && !allReadyOnce())) return;
  boot.done = true;
  // Serving now: the lab state mirror starts uploading (a deploy that never gets here never touches the saved copies).
  startMirror();
  log(`boot complete after ${Math.round(process.uptime())} s; /healthz is 200`);
}

/* ---------------- Gateway first: Render needs the port bound quickly ---------------- */
const gateway = await createGateway({ onboardPort: ONBOARD_PORT, interviewPort: INTERVIEW_PORT, labsPort: LABS_PORT, ready: readiness, publicUrl: PUBLIC_URL, config: SETTINGS.gateway });
server = gateway.listen(PORT, () => log(`gateway listening on :${PORT} for ${PUBLIC_URL} (client IP: ${SETTINGS.gateway.clientIp.source}${SETTINGS.gateway.clientIp.source === 'xff-rightmost' ? `, ${SETTINGS.gateway.clientIp.hops} trusted hops` : ''})`));
server.on('error', (err) => { console.error(`[launcher] cannot listen on :${PORT} (${reason(err)})`); process.exit(1); });

/* ---------------- Child processes ---------------- */
const HEAP_SAMPLE_MS = 30_000;
/**
 * Starts a child on a loopback port and keeps it running. `env` is its settings (a function is read at
 * every start). `healthPath` is what the ready probe fetches (any HTTP answer = up); a JSON body with
 * `heapUsed` is recorded and re-sampled while the child is up. `ipc` opens a message channel (the labs
 * child: lab state durability; it also exits when this process goes away). `onStart`/`onReady` get the
 * child process.
 */
function supervise(name, cwd, args, env, port, flag, { healthPath = '/', ipc = false, onStart, onReady } = {}) {
  let backoff = 1000;
  const startChild = () => {
    if (stopping) return;
    log(`starting ${name}`);
    const startedAt = Date.now();
    const vars = typeof env === 'function' ? env() : env;
    // Loopback only: the gateway is the sole public caller, so the child port is never reachable from outside.
    const child = spawn(process.execPath, args, { cwd, env: childEnv({ ...vars, PORT: String(port), HOST: '127.0.0.1' }), stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit' });
    children.add(child);
    child.on('error', (err) => log(`${name}: ${reason(err)}`));
    onStart?.(child);
    const sample = async () => {
      const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(1000) });
      health[flag].heapUsed = heapUsedOf(await res.json().catch(() => null));
    };
    let up = false;
    let heapTimer = null;
    const probe = setInterval(async () => {
      try {
        await sample();
        // Not a stale answer for a child that exited meanwhile, and only once per start.
        if (up || !children.has(child)) return;
        up = true;
        if (!ready[flag]) log(`${name} ready`);
        ready[flag] = true; health[flag].lastReady = Date.now(); health[flag].exits = 0; backoff = 1000; clearInterval(probe);
        heapTimer = setInterval(() => sample().catch(() => { health[flag].heapUsed = null; }), HEAP_SAMPLE_MS);
        Promise.resolve(onReady?.(child)).catch((err) => log(`${name}: ${reason(err)}`));
        checkBoot();
      } catch { /* not up yet */ }
    }, 1000);
    child.on('exit', (code, signal) => {
      children.delete(child);
      clearInterval(probe);
      if (heapTimer) clearInterval(heapTimer);
      if (ready[flag]) health[flag].lastReady = Date.now();
      ready[flag] = false; health[flag].exits += 1; health[flag].heapUsed = null;
      console.log(childExitLine({ name: flag, code, signal, startedAt, exits: health[flag].exits }));
      if (stopping) return;
      log(`${name} exited (${code ?? signal}); restarting in ${backoff / 1000}s (exit ${health[flag].exits} since last ready)`);
      setTimeout(startChild, backoff); backoff = Math.min(backoff * 2, 30_000);
    });
  };
  startChild();
}

/* ---------------- Lab state: back before the labs read it ---------------- */
// Lab Simulations, SOC and Red Team keep their records in JSON files on this instance's disk, which
// Render empties on every restart, sleep and deploy. The mirror keeps a copy in the InterviewPrep
// database (its own schema, owner connection) and restores the files before the labs child starts and
// its stores load them. TR_STATE_DURABLE=1 (read per request by the labs and SOC in the labs child) tells
// learners their records are kept with their account; only the mirror decides it, while what it saves
// survives a restart. The labs child gets it in its environment and every change over IPC.
let durable = false;
const tellLabs = () => {
  if (!labsChild?.connected) return;
  try { labsChild.send({ type: 'tr-state-durable', on: durable }, () => {}); } catch { /* exited meanwhile; the next start gets it in its environment */ }
};
if (SETTINGS.mirror.enabled) {
  // SOC keeps several files next to its cases file; mirror that folder, unless it is a shared one
  // (SOC_DATA_FILE straight in /tmp), where only SOC's own files are taken.
  const socDir = path.resolve(path.dirname(SOC_DATA_FILE));
  const socTargets = [os.tmpdir(), '/tmp', '/'].map((d) => path.resolve(d)).includes(socDir)
    ? [path.basename(SOC_DATA_FILE), 'attempts.json', 'awards.json'].map((file) => ({ key: `soc/${file}`, file: path.join(socDir, file) }))
    : [{ key: 'soc', dir: socDir }];
  mirror = createStateMirror({
    connectionString: INTERVIEW_DB, table: SETTINGS.mirror.table, intervalMs: SETTINGS.mirror.intervalMs, maxBytes: SETTINGS.mirror.maxBytes, log,
    targets: [{ key: 'labs', file: LABS_DATA_FILE }, ...socTargets, { key: 'redteam', file: REDTEAM_DATA_FILE }],
    onDurable: (on) => { durable = !!on; tellLabs(); },
  });
  await mirror.restore();
} else {
  log('state mirror: off (STATE_MIRROR=off); lab, SOC and Red Team progress is lost on restart');
}

// Heap caps keep the four Node processes inside a 512 MB instance: gateway 48 (render.yaml) + onboard 110 +
// InterviewPrep 180 + labs 150 = 488 MB of old space at the very worst, with each process's baseline
// (code, buffers, semi-spaces) counted against the measured ~375 MB PSS at rest. See deploy/README.md.
if (!stopping) {
  supervise('labs child', import.meta.dirname, ['--max-old-space-size=150', '--max-semi-space-size=2', 'labs-child.mjs'],
    () => ({ ...labsEnv, TR_STATE_DURABLE: durable ? '1' : undefined }), LABS_PORT, 'labs', {
      ipc: true,
      onStart: (child) => { labsChild = child; },
      onReady: async () => {
        tellLabs();
        if (labsStoresChecked) return;
        // Every store has read its file now. One that rejected a restored copy (moved it aside as
        // .corrupt) starts empty; its saved copy is kept aside before that empty store can replace it.
        await mirror?.checkRestored();
        labsStoresChecked = true;
        startMirror();
      },
    });
}

/* ---------------- Databases ---------------- */
async function prepareOnboardRole() {
  const client = new pg.Client({ connectionString: ONBOARD_DB });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'threatready_app'");
    const roleExists = rows.length > 0;
    // Launcher-only state (owner role): the digest of the app role's current password, so ALTER ROLE
    // runs only when ONBOARD_APP_DB_PASSWORD actually changed (FORCE_ROLE_SYNC=true re-issues it).
    await client.query('CREATE TABLE IF NOT EXISTS threatready_launcher_state (key text PRIMARY KEY, value text NOT NULL)');
    const stored = (await client.query('SELECT value FROM threatready_launcher_state WHERE key = $1', [ROLE_PASSWORD_STATE_KEY])).rows[0]?.value ?? null;
    const force = boolEnv(process.env.FORCE_ROLE_SYNC, false);
    if (roleSyncNeeded({ roleExists, stored, password: APP_DB_PASSWORD, force })) {
      // Later boots only refresh the password: a non-superuser may not change BYPASSRLS on ALTER ROLE
      // (PostgreSQL 16), and a role created here is NOBYPASSRLS already. Role statements take no bind
      // parameters, so PostgreSQL's own format(%L) quotes the password.
      const template = roleExists
        ? 'ALTER ROLE threatready_app WITH LOGIN PASSWORD %L'
        : 'CREATE ROLE threatready_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L';
      const { rows: [{ sql: roleSql }] } = await client.query('SELECT format($1::text, $2::text) AS sql', [template, APP_DB_PASSWORD]);
      await client.query(roleSql);
      await client.query('INSERT INTO threatready_launcher_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [ROLE_PASSWORD_STATE_KEY, passwordDigest(APP_DB_PASSWORD)]);
      log(roleExists ? (force ? 'app role password re-synced (FORCE_ROLE_SYNC)' : 'app role password updated') : 'app role created');
    } else {
      log('app role password unchanged; ALTER ROLE skipped');
    }
    const bypass = await client.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'threatready_app'");
    if (bypass.rows[0]?.rolbypassrls) throw new Error('threatready_app has BYPASSRLS; row-level security would not apply. Recreate the role without it.');
    const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
    await client.query(`GRANT CONNECT ON DATABASE "${db.replace(/"/g, '""')}" TO threatready_app`);
    await client.query('GRANT USAGE ON SCHEMA public TO threatready_app');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO threatready_app');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO threatready_app');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON TYPES TO threatready_app');
    // The launcher's own table is not the API's business (the default privileges above would expose it).
    await client.query('REVOKE ALL ON threatready_launcher_state FROM threatready_app');
  } finally {
    await client.end();
  }
}
/**
 * Onboard's migration 0001 grants the app role every table in the schema, which on a fresh database
 * includes the launcher's table created just before it: taken back after every migration run.
 */
async function revokeLauncherState() {
  const client = new pg.Client({ connectionString: ONBOARD_DB });
  await client.connect();
  try {
    await client.query('REVOKE ALL ON threatready_launcher_state FROM threatready_app');
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
  // InterviewPrep refuses to start in production without the small-tier model id (declared in render.yaml).
  need('LLM_MODEL_SMALL');
  // One launcher at a time per database (a deploy overlaps the old instance; a second instance waits).
  log('preparing onboard database');
  await withAdvisoryLock(ONBOARD_DB, MIGRATION_LOCK_KEY, async () => {
    await prepareOnboardRole();
    await run('onboard migrations', path.join(ROOT, 'Threatready-landing-page-main/apps/api'), ['dist/db/migrate.js'], { DATABASE_MIGRATION_URL: ONBOARD_DB });
    await revokeLauncherState();
  }, { log });
  log('preparing InterviewPrep database');
  await withAdvisoryLock(INTERVIEW_DB, MIGRATION_LOCK_KEY, () => run('InterviewPrep migrations', path.join(ROOT, 'InterviewPrep/packages/db'), ['dist/migrate.js'], { DATABASE_URL: INTERVIEW_DB }), { log });
}

// A SIGTERM during the restore skips the rest: shutdown() saves state and exits.
if (!stopping) {
  try {
    await prepareDatabases();
    if (await releaseKnown) {
      boot.waitForApis = false;
      log('restart of a release that booted before: /healthz is 200 from now on while the APIs start');
    } else if (boot.waitForApis) {
      log('first boot of this release (new code or settings): /healthz stays 503 until every child (onboard, InterviewPrep, labs) has started');
    }
    if (!stopping) {
      boot.migrated = Date.now();
      checkBoot();
    }
  } catch (err) {
    // While shutting down, the migration was stopped on purpose; shutdown() saves state and exits.
    if (!stopping) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[launcher] ${msg}`);
      if (/permission denied to (alter|create) role/.test(msg)) {
        console.error('[launcher] The database user must be able to create roles (Neon\'s owner role can). If a role named threatready_app already exists and belongs to another user, drop it or use a fresh project.');
      }
      // This instance never served, so the mirror has uploaded nothing: the saved lab state is unchanged.
      // The labs child exits when this process does (its IPC channel closes).
      process.exit(1);
    }
  }
}

if (!stopping) {
  supervise('onboard API', path.join(ROOT, 'Threatready-landing-page-main/apps/api'), ['--max-old-space-size=110', '--max-semi-space-size=2', 'dist/main.js'], onboardEnv, ONBOARD_PORT, 'onboard', { healthPath: '/__health' });
  supervise('InterviewPrep API + worker', path.join(ROOT, 'InterviewPrep/apps/api'), ['--max-old-space-size=180', '--max-semi-space-size=2', 'dist/main.js', 'all'], interviewEnv, INTERVIEW_PORT, 'interview');
}
