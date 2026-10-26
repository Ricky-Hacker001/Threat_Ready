// ThreatReady launcher for a single small instance (Render free web service).
//  1. Opens the public port at once (Render expects it), with the gateway answering 503 until ready.
//  2. Prepares both Neon databases: onboard's least-privilege app role, then each app's migrations.
//  3. Starts three children on loopback ports, memory-capped, restarted on crash: the onboard API, the
//     InterviewPrep API (+ worker) and the labs child (Lab Simulations, hosted labs, Attack Reasoning).
// Required env: see render.yaml. Nothing here prints a secret.
process.env.NODE_ENV ||= 'production';
import { spawn, spawnSync } from 'node:child_process';
import { hkdfSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { CLIENT_IP_HEADER, createGateway } from './gateway.mjs';
import { ROLE_PASSWORD_STATE_KEY, boolEnv, childExitLine, heapUsedOf, internalTokenEnv, passwordDigest, roleSyncNeeded } from './launcher-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 10000);
const ONBOARD_PORT = Number(process.env.ONBOARD_INTERNAL_PORT || 3200);
const INTERVIEW_PORT = Number(process.env.INTERVIEW_INTERNAL_PORT || 3100);
const LABS_PORT = Number(process.env.LABS_INTERNAL_PORT || 4000);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const PRODUCTION = process.env.NODE_ENV === 'production';
const log = (msg) => console.log(`[launcher] ${msg}`);

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`[launcher] Missing environment variable ${name} (see render.yaml).`); process.exit(1); }
  return v;
}
/**
 * Neon strings say sslmode=require, which pg treats as verify-full today (and warns it will change).
 * State verify-full explicitly: same secure behaviour now and after pg v9.
 */
const strictSsl = (url) => {
  const u = new URL(url);
  if (['require', 'prefer', 'verify-ca'].includes(u.searchParams.get('sslmode') ?? '')) u.searchParams.set('sslmode', 'verify-full');
  return u.toString();
};
const ONBOARD_DB = strictSsl(need('ONBOARD_DATABASE_URL'));
const INTERVIEW_DB = strictSsl(need('INTERVIEW_DATABASE_URL'));
const AUTH_SECRET = need('BETTER_AUTH_SECRET');
const INTERNAL_TOKEN = need('INTERNAL_API_TOKEN');
const APP_DB_PASSWORD = need('ONBOARD_APP_DB_PASSWORD');
/** One secret per purpose, derived from the auth secret (HKDF-SHA256) so none is reused across uses. */
const derived = (info) => Buffer.from(hkdfSync('sha256', AUTH_SECRET, 'threatready', info, 32)).toString('hex');
const STORAGE_SIGNING_SECRET = derived('storage-signing');
// The SOC lab (labs child) reads SOC_SESSION_SECRET (older builds: SIM_SESSION_SECRET). An operator value wins.
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

/** Cloudflare Turnstile: both keys or none. With exactly one, onboard would refuse to boot. */
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const captchaOn = !!(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);
if (!captchaOn && (TURNSTILE_SITE_KEY || TURNSTILE_SECRET_KEY)) {
  log(`WARNING: ${TURNSTILE_SITE_KEY ? 'TURNSTILE_SECRET_KEY' : 'TURNSTILE_SITE_KEY'} is missing; CAPTCHA is OFF until both Turnstile keys are set.`);
} else if (!captchaOn) {
  log('WARNING: production is running without CAPTCHA (set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY); sign-up relies on rate limits alone.');
}

/**
 * Children get an explicit allowlist, never this process's whole environment: the owner DB URL, the
 * other app's database, its API keys, the role password and the raw internal token stay here.
 */
const BASE_KEYS = ['NODE_ENV', 'PATH', 'HOME', 'TZ', 'LANG', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
function childEnv(extra) {
  const env = {};
  for (const k of BASE_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (k.startsWith('RENDER')) env[k] = process.env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') env[k] = String(v);
  return env;
}

/** Same database and host, different login: the API's least-privilege role (no BYPASSRLS). */
function withUser(url, user, password) {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}
const ONBOARD_APP_DB = withUser(ONBOARD_DB, 'threatready_app', APP_DB_PASSWORD);

/* ---------------- Gateway first: Render needs the port bound quickly ---------------- */
const CHILDREN = ['onboard', 'interview', 'labs'];
const ready = Object.fromEntries(CHILDREN.map((k) => [k, false]));
/** Per child: when it was last seen ready (0 = never), consecutive exits since it was last ready, last heap sample. */
const health = Object.fromEntries(CHILDREN.map((k) => [k, { lastReady: 0, exits: 0, heapUsed: null }]));
const DEGRADED_AFTER_MS = 60_000;
/** A child that was ready once and has now been down for over a minute: a crash loop, not a boot. */
const degraded = () => CHILDREN.some((k) => !ready[k] && health[k].lastReady > 0 && Date.now() - health[k].lastReady > DEGRADED_AFTER_MS);
const statusOf = (k) => (ready[k] ? 'ready' : health[k].lastReady > 0 ? 'down' : 'starting');
const readiness = () => ({
  ...ready,
  degraded: degraded(),
  status: Object.fromEntries(CHILDREN.map((k) => [k, statusOf(k)])),
  exits: Object.fromEntries(CHILDREN.map((k) => [k, health[k].exits])),
  heapUsed: Object.fromEntries(CHILDREN.map((k) => [k, health[k].heapUsed])),
});
const gateway = await createGateway({ onboardPort: ONBOARD_PORT, interviewPort: INTERVIEW_PORT, labsPort: LABS_PORT, ready: readiness });
gateway.listen(PORT, () => log(`gateway listening on :${PORT} for ${PUBLIC_URL}`));

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

/** One-off task (migrations) with the owner connection: gets only the base env plus what is passed. */
function run(label, cwd, args, env) {
  const r = spawnSync(process.execPath, args, { cwd, env: childEnv(env), stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

/* ---------------- Child processes ---------------- */
const children = new Set();
let stopping = false;
const HEAP_SAMPLE_MS = 30_000;
/**
 * Starts a child on a loopback port and keeps it running. `healthPath` is what the ready probe fetches
 * (any HTTP answer = up); a JSON body with `heapUsed` is recorded and re-sampled while the child is up.
 */
function supervise(name, cwd, args, env, port, flag, healthPath = '/') {
  let backoff = 1000;
  const startChild = () => {
    log(`starting ${name}`);
    const startedAt = Date.now();
    // Loopback only: the gateway is the sole caller, so the child port is never reachable from outside.
    const child = spawn(process.execPath, args, { cwd, env: childEnv({ ...env, PORT: String(port), HOST: '127.0.0.1' }), stdio: 'inherit' });
    children.add(child);
    const sample = async () => {
      const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(1000) });
      health[flag].heapUsed = heapUsedOf(await res.json().catch(() => null));
    };
    let heapTimer = null;
    const probe = setInterval(async () => {
      try {
        await sample();
        if (!ready[flag]) log(`${name} ready`);
        ready[flag] = true; health[flag].lastReady = Date.now(); health[flag].exits = 0; backoff = 1000; clearInterval(probe);
        heapTimer = setInterval(() => sample().catch(() => { health[flag].heapUsed = null; }), HEAP_SAMPLE_MS);
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

/** Pass-through of optional operator settings, by exact key (childEnv drops the unset ones). */
const pick = (...keys) => Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const prefixed = (...prefixes) => pick(...Object.keys(process.env).filter((k) => prefixes.some((p) => k.startsWith(p))));
const common = { NODE_ENV: 'production', CLIENT_IP_HEADER, INTERNAL_TOKEN_LEGACY_ACCEPT: LEGACY_ACCEPT ? 'true' : 'false', ...pick('SENTRY_DSN') };
// The raw token reaches a child only while legacy acceptance is on (never in production by default).
const legacyToken = LEGACY_ACCEPT ? INTERNAL_TOKEN : undefined;
// Onboard: the app role's DATABASE_URL only. The owner URL (DATABASE_MIGRATION_URL) is for run() above.
const onboardEnv = {
  ...common,
  DATABASE_URL: ONBOARD_APP_DB,
  BETTER_AUTH_SECRET: AUTH_SECRET,
  BETTER_AUTH_URL: PUBLIC_URL,
  WEB_ORIGIN: PUBLIC_URL,
  PUBLIC_URL,
  // Onboard's config requires INTERNAL_API_TOKEN (>= 32 chars); with legacy acceptance off it is a value
  // nobody else holds, so it is accepted by no one and presented to no one (the per-caller tokens are).
  INTERNAL_API_TOKEN: legacyToken ?? Buffer.from(hkdfSync('sha256', INTERNAL_TOKEN, 'threatready-internal', 'onboard-unused', 32)).toString('hex'),
  ...TOKENS.onboard,
  INTERVIEW_APP_URL: `${PUBLIC_URL}/interview-prep/`,
  LABS_APP_URL: `${PUBLIC_URL}/labs/`,
  REASONING_APP_URL: `${PUBLIC_URL}/ar/`,
  INTERVIEW_INTERNAL_URL: `http://127.0.0.1:${INTERVIEW_PORT}`,
  // Straight to the labs child, not through the gateway: fewer hops, no dependency on the public port.
  LABS_INTERNAL_URL: `http://127.0.0.1:${LABS_PORT}/labs`,
  REASONING_INTERNAL_URL: `http://127.0.0.1:${LABS_PORT}/ar`,
  REASONING_STATUS: 'live',
  EMAIL_DRIVER: process.env.RESEND_API_KEY ? 'resend' : 'log',
  TURNSTILE_SITE_KEY: captchaOn ? TURNSTILE_SITE_KEY : undefined,
  TURNSTILE_SECRET_KEY: captchaOn ? TURNSTILE_SECRET_KEY : undefined,
  ALLOW_NO_CAPTCHA: captchaOn ? 'false' : 'true',
  ...pick('RESEND_API_KEY', 'EMAIL_FROM', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ADMIN_EMAILS', 'COOKIE_DOMAIN', 'GEO_COUNTRY_MMDB', 'INTERVIEW_STATUS', 'LABS_STATUS'),
};
// InterviewPrep: its own database and the Anthropic key; never onboard's secrets. Storage links are
// signed with a purpose-specific derived key, not the platform auth secret.
const interviewEnv = {
  ...common,
  DATABASE_URL: INTERVIEW_DB,
  APP_ORIGIN: new URL(PUBLIC_URL).origin,
  API_BASE_URL: PUBLIC_URL,
  ONBOARD_URL: PUBLIC_URL,
  IDENTITY_URL: `http://127.0.0.1:${ONBOARD_PORT}`,
  INTERNAL_API_TOKEN: legacyToken ?? TOKENS.interview.INTERNAL_TOKEN_TO_ONBOARD,
  ...TOKENS.interview,
  STORAGE_SIGNING_SECRET,
  STORAGE_DRIVER: 'fs',
  FS_STORAGE_DIR: '/tmp/threatready-storage',
  ALLOW_EPHEMERAL_STORAGE: 'true',
  ALLOW_NO_SENTRY: process.env.SENTRY_DSN ? 'false' : 'true',
  LLM_DRIVER: 'anthropic',
  LLM_VERIFY_MODELS_ON_BOOT: 'false',
  EMAIL_DRIVER: 'log',
  REPORT_EMAIL_ENABLED: 'false',
  DATABASE_POOL_MAX: '5',
  ALLOWED_APP_ORIGINS: process.env.ALLOWED_APP_ORIGINS || '',
  // LLM_MODEL_SMALL is required in production since Patch 2 (declared in render.yaml with its default).
  ...pick('ANTHROPIC_API_KEY', 'LLM_MODEL_SMALL', 'LLM_MODEL_LARGE', 'LLM_REFUSAL_FALLBACK_MODEL', 'LLM_PRICING_OVERRIDES', 'SENTRY_ENVIRONMENT', 'RELEASE', 'LOG_LEVEL', 'CONTENT_DIR'),
  ...prefixed('REASONING_', 'AI_', 'INTERVIEW_M'),
};
// Labs child: Lab Simulations, the hosted labs and Attack Reasoning. No database, no API keys; the
// per-caller tokens (its own accept token and what it presents to onboard / InterviewPrep), the lab
// data files, the SOC session secret and the rate-limit tunables.
const labsEnv = {
  ...common,
  PUBLIC_URL,
  ONBOARD_INTERNAL_PORT: String(ONBOARD_PORT),
  INTERVIEW_INTERNAL_PORT: String(INTERVIEW_PORT),
  LABS_INTERNAL_PORT: String(LABS_PORT),
  INTERNAL_API_TOKEN: legacyToken,
  ...TOKENS.labs,
  SOC_SESSION_SECRET,
  SIM_SESSION_SECRET: SOC_SESSION_SECRET,
  ...pick('LABS_DATA_FILE', 'SOC_DATA_FILE', 'REDTEAM_DATA_FILE', 'IDENTITY_CACHE_SECONDS'),
  ...prefixed('LABS_RATE_', 'AR_RATE_', 'REDTEAM_RATE_', 'SOC_'),
};

// Licensed 3D interviewer (never in git): a Render Secret File named interviewer.glb, if provided.
const glbSecret = '/etc/secrets/interviewer.glb';
const glbTarget = path.join(ROOT, 'InterviewPrep/apps/api/assets/interviewer.glb');
if (fs.existsSync(glbSecret) && !fs.existsSync(glbTarget)) {
  fs.mkdirSync(path.dirname(glbTarget), { recursive: true });
  fs.copyFileSync(glbSecret, glbTarget);
  log('interviewer model installed from secret file');
}

try {
  if (onboardEnv.EMAIL_DRIVER === 'log') throw new Error('RESEND_API_KEY is not set: sign-up and password-reset codes could not be emailed.');
  need('ANTHROPIC_API_KEY');
  log('preparing onboard database');
  await prepareOnboardRole();
  run('onboard migrations', path.join(ROOT, 'Threatready-landing-page-main/apps/api'), ['dist/db/migrate.js'], { DATABASE_MIGRATION_URL: ONBOARD_DB });
  log('preparing InterviewPrep database');
  run('InterviewPrep migrations', path.join(ROOT, 'InterviewPrep/packages/db'), ['dist/migrate.js'], { DATABASE_URL: INTERVIEW_DB });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[launcher] ${msg}`);
  if (/permission denied to (alter|create) role/.test(msg)) {
    console.error('[launcher] The database user must be able to create roles (Neon\'s owner role can). If a role named threatready_app already exists and belongs to another user, drop it or use a fresh project.');
  }
  process.exit(1);
}

// Heap caps keep the four Node processes inside a 512 MB instance: gateway 48 (render.yaml) + onboard 110 +
// InterviewPrep 180 + labs 150 = 488 MB of old space at the very worst, with each process's baseline
// (code, buffers, semi-spaces) counted against the measured ~375 MB PSS at rest. See deploy/README.md.
supervise('onboard API', path.join(ROOT, 'Threatready-landing-page-main/apps/api'), ['--max-old-space-size=110', '--max-semi-space-size=2', 'dist/main.js'], onboardEnv, ONBOARD_PORT, 'onboard', '/__health');
supervise('InterviewPrep API + worker', path.join(ROOT, 'InterviewPrep/apps/api'), ['--max-old-space-size=180', '--max-semi-space-size=2', 'dist/main.js', 'all'], interviewEnv, INTERVIEW_PORT, 'interview');
supervise('labs child', import.meta.dirname, ['--max-old-space-size=150', '--max-semi-space-size=2', 'labs-child.mjs'], labsEnv, LABS_PORT, 'labs');

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    for (const c of children) c.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000).unref();
    if (!children.size) process.exit(0);
  });
}
