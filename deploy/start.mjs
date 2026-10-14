// ThreatReady launcher for a single small instance (Render free web service).
//  1. Opens the public port at once (Render expects it), with the gateway answering 503 until ready.
//  2. Prepares both Neon databases: onboard's least-privilege app role, then each app's migrations.
//  3. Starts the onboard and InterviewPrep APIs on loopback ports, memory-capped, restarted on crash.
// Required env: see render.yaml. Nothing here prints a secret.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createGateway } from './gateway.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 10000);
const ONBOARD_PORT = Number(process.env.ONBOARD_INTERNAL_PORT || 3200);
const INTERVIEW_PORT = Number(process.env.INTERVIEW_INTERNAL_PORT || 3100);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const log = (msg) => console.log(`[launcher] ${msg}`);

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`[launcher] Missing environment variable ${name} (see render.yaml).`); process.exit(1); }
  return v;
}
const ONBOARD_DB = need('ONBOARD_DATABASE_URL');
const INTERVIEW_DB = need('INTERVIEW_DATABASE_URL');
const AUTH_SECRET = need('BETTER_AUTH_SECRET');
const INTERNAL_TOKEN = need('INTERNAL_API_TOKEN');
const APP_DB_PASSWORD = need('ONBOARD_APP_DB_PASSWORD');

/** Same database and host, different login: the API's least-privilege role (no BYPASSRLS). */
function withUser(url, user, password) {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}
const ONBOARD_APP_DB = withUser(ONBOARD_DB, 'threatready_app', APP_DB_PASSWORD);

/* ---------------- Gateway first: Render needs the port bound quickly ---------------- */
const ready = { onboard: false, interview: false };
const store = new (await import('./dist/labs/store.js')).Store(process.env.LABS_DATA_FILE || '/tmp/threatready-labs.json');
const labsMod = await import('./dist/labs/app.js');
const labsId = await import('./dist/labs/identity.js');
const arMod = await import('./dist/ar/app.js');
const arId = await import('./dist/ar/identity.js');
const identityUrl = `http://127.0.0.1:${ONBOARD_PORT}`;
const labsApp = labsMod.createApp(store, path.join(ROOT, 'threatready-lab-001/dist'), {
  identity: labsId.onboardIdentity({ identityUrl, internalToken: INTERNAL_TOKEN }),
  internalToken: INTERNAL_TOKEN, appOrigin: new URL(PUBLIC_URL).origin, onboardUrl: PUBLIC_URL, apps: labsId.onboardApps(identityUrl),
});
const arApp = arMod.createApp(path.join(ROOT, 'attack-reasoning/dist'), {
  identity: arId.onboardIdentity({ identityUrl, internalToken: INTERNAL_TOKEN }),
  internalToken: INTERNAL_TOKEN, appOrigin: new URL(PUBLIC_URL).origin, onboardUrl: PUBLIC_URL, apps: arId.onboardApps(identityUrl),
});
const gateway = await createGateway({ onboardPort: ONBOARD_PORT, interviewPort: INTERVIEW_PORT, ready: () => ({ ...ready }), labsApp, arApp });
gateway.listen(PORT, () => log(`gateway listening on :${PORT} for ${PUBLIC_URL}`));

/* ---------------- Databases ---------------- */
async function prepareOnboardRole() {
  const client = new pg.Client({ connectionString: ONBOARD_DB });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'threatready_app'");
    const pw = APP_DB_PASSWORD.replace(/'/g, "''");
    // Later boots only refresh the password: a non-superuser may not change BYPASSRLS on ALTER ROLE
    // (PostgreSQL 16), and a role created here is NOBYPASSRLS already.
    await client.query(rows.length
      ? `ALTER ROLE threatready_app WITH LOGIN PASSWORD '${pw}'`
      : `CREATE ROLE threatready_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
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

function run(label, cwd, args, env) {
  const r = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

/* ---------------- Child processes ---------------- */
const children = new Set();
let stopping = false;
function supervise(name, cwd, args, env, port, flag) {
  let backoff = 1000;
  const startChild = () => {
    log(`starting ${name}`);
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env, PORT: String(port) }, stdio: 'inherit' });
    children.add(child);
    const probe = setInterval(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (!ready[flag]) log(`${name} ready`);
        ready[flag] = true; backoff = 1000; clearInterval(probe);
      } catch { /* not up yet */ }
    }, 1000);
    child.on('exit', (code) => {
      children.delete(child);
      clearInterval(probe); ready[flag] = false;
      if (stopping) return;
      log(`${name} exited (${code}); restarting in ${backoff / 1000}s`);
      setTimeout(startChild, backoff); backoff = Math.min(backoff * 2, 30_000);
    });
  };
  startChild();
}

const common = { NODE_ENV: 'production' };
const onboardEnv = {
  ...common,
  DATABASE_URL: ONBOARD_APP_DB,
  DATABASE_MIGRATION_URL: ONBOARD_DB,
  BETTER_AUTH_SECRET: AUTH_SECRET,
  BETTER_AUTH_URL: PUBLIC_URL,
  WEB_ORIGIN: PUBLIC_URL,
  INTERNAL_API_TOKEN: INTERNAL_TOKEN,
  INTERVIEW_APP_URL: `${PUBLIC_URL}/`,
  LABS_APP_URL: `${PUBLIC_URL}/labs/`,
  REASONING_APP_URL: `${PUBLIC_URL}/ar/`,
  INTERVIEW_INTERNAL_URL: `http://127.0.0.1:${INTERVIEW_PORT}`,
  LABS_INTERNAL_URL: `http://127.0.0.1:${PORT}/labs`,
  REASONING_INTERNAL_URL: `http://127.0.0.1:${PORT}/ar`,
  REASONING_STATUS: 'live',
  EMAIL_DRIVER: process.env.RESEND_API_KEY ? 'resend' : 'log',
  ALLOW_NO_CAPTCHA: process.env.TURNSTILE_SECRET_KEY ? 'false' : 'true',
  CLIENT_IP_HEADER: 'x-forwarded-for',
};
const interviewEnv = {
  ...common,
  DATABASE_URL: INTERVIEW_DB,
  APP_ORIGIN: new URL(PUBLIC_URL).origin,
  API_BASE_URL: PUBLIC_URL,
  ONBOARD_URL: PUBLIC_URL,
  IDENTITY_URL: identityUrl,
  INTERNAL_API_TOKEN: INTERNAL_TOKEN,
  BETTER_AUTH_SECRET: AUTH_SECRET,
  STORAGE_DRIVER: 'fs',
  FS_STORAGE_DIR: '/tmp/threatready-storage',
  ALLOW_EPHEMERAL_STORAGE: 'true',
  ALLOW_NO_SENTRY: process.env.SENTRY_DSN ? 'false' : 'true',
  LLM_DRIVER: 'anthropic',
  LLM_VERIFY_MODELS_ON_BOOT: 'false',
  EMAIL_DRIVER: 'log',
  REPORT_EMAIL_ENABLED: 'false',
  DATABASE_POOL_MAX: '5',
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

// Heap caps keep the three Node processes inside a 512 MB instance (measured: ~375 MB PSS at rest).
supervise('onboard API', path.join(ROOT, 'Threatready-landing-page-main/apps/api'), ['--max-old-space-size=120', '--max-semi-space-size=2', 'dist/main.js'], onboardEnv, ONBOARD_PORT, 'onboard');
supervise('InterviewPrep API + worker', path.join(ROOT, 'InterviewPrep/apps/api'), ['--max-old-space-size=200', '--max-semi-space-size=2', 'dist/main.js', 'all'], interviewEnv, INTERVIEW_PORT, 'interview');

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    for (const c of children) c.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000).unref();
    if (!children.size) process.exit(0);
  });
}
