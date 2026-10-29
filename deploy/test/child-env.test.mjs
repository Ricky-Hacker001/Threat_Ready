// What each child process receives (TR-19 allowlist, OPS-REG2 tunables pass-through, TR-14 Sentry,
// security patch 2: per-caller internal tokens, the labs child).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, interviewChildEnv, labsChildEnv, onboardChildEnv, testHooksSet, tunables } from '../child-env.mjs';
import { internalTokenEnv } from '../launcher-lib.mjs';

/** The Render service's environment: required keys plus operator tunables of both apps (dummy values). */
const SERVICE = {
  NODE_ENV: 'production', PATH: '/usr/bin', HOME: '/home/render', RENDER: 'true', RENDER_GIT_COMMIT: 'abc123', NODE_VERSION: '24',
  ONBOARD_DATABASE_URL: 'postgres://owner:pw@db/onboard', INTERVIEW_DATABASE_URL: 'postgres://owner:pw@db/interview', ONBOARD_APP_DB_PASSWORD: 'role-pw',
  BETTER_AUTH_SECRET: 'auth-secret', INTERNAL_API_TOKEN: 'internal-token', ANTHROPIC_API_KEY: 'sk-ant-x', RESEND_API_KEY: 're_x', EMAIL_FROM: 'TR <a@b.c>',
  GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs', GITHUB_CLIENT_ID: 'h', GITHUB_CLIENT_SECRET: 'hs', ADMIN_EMAILS: 'a@b.c',
  TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1', SENTRY_ENVIRONMENT: 'production',
  // onboard tunables
  TRIAL_ENABLED: 'false', SIGNIN_LOCKOUT_FAILURES: '5', OTP_ISSUE_PER_IP_PER_HOUR: '5', ACTIVITY_PING_PER_USER_PER_MINUTE: '0', RETENTION_INTERVAL_HOURS: '24', RATE_LIMIT_MULTIPLIER: '1', AWS_REGION: 'ap-south-1', GEO_COUNTRY_MMDB: '/etc/secrets/geo.mmdb',
  // InterviewPrep tunables (the ones the 2026-10-23 validation found dropped, and the new ones)
  RATE_LIMIT_SCALE: '2', LLM_TIMEOUT_MS_SMALL: '30000', LLM_TIMEOUT_MS_LARGE: '150000', LLM_MAX_RETRIES: '1', IDENTITY_CACHE_SECONDS: '30', IDENTITY_MAX_IN_FLIGHT: '64',
  REPORT_PDF_ENABLED: 'true', WORKER_DATABASE_URL: 'postgres://worker:pw@db/interview', S3_BUCKET: 'tr-uploads', AWS_ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST', AWS_ENDPOINT_URL_S3: 'https://acct.r2.cloudflarestorage.com',
  SES_FROM_ADDRESS: 'r@b.c', REASONING_POOL_ENABLED: 'false', REASONING_READY_TTL_HOURS: '24', AI_USER_DAILY_CAP_USD: '1', INTERVIEW_MONTHLY_QUOTA_FREE: '5', INTERVIEW_DATA_STORAGE_LOCATION: 'Singapore', DATA_RETENTION_DAYS: '90',
  STORAGE_DRIVER: 's3', LLM_DRIVER: 'fake', LOG_LEVEL: 'info',
  // launcher-only and lab settings
  CLIENT_IP_SOURCE: 'xff-rightmost', TRUSTED_PROXY_HOPS: '2', STATE_MIRROR: 'on', ONBOARD_INTERNAL_PORT: '3200', SOC_SESSION_SECRET: 'soc',
  LABS_INTERNAL_PORT: '4000', FORCE_ROLE_SYNC: 'true', INTERNAL_TOKEN_LEGACY_ACCEPT: 'true', INTERNAL_TOKENS_ACCEPT: 'operator-set-token-list', INTERNAL_TOKEN_FROM_ONBOARD: 'operator-set-onboard-token', TR_STATE_DURABLE: '1',
  // labs child tunables (and SOC test hooks / standalone-only settings it must not get)
  LABS_RATE_PER_MIN: '90', LABS_MAX_RUNS_PER_LAB: '7', LABS_IDENTITY_MAX_PER_CLIENT: '12', AR_RATE_IP_PER_MIN: '300', AR_IDENTITY_MAX_IN_FLIGHT: '40',
  REDTEAM_MAX_RUNS_PER_LAB: '15', REDTEAM_RATE_PER_MIN: '60', SOC_MAX_STREAMS_PER_USER: '4', DAILY_WIPE: 'false',
  SOC_SIM_TEST: '1', SOC_SIM_FAST: '1', SOC_INTERNAL_TOKEN: 'soc-standalone-token-soc-standalone-token',
  LABS_DATA_FILE: '/operator/labs.json',
};
const RAW = 'i'.repeat(64);
const TOKENS = internalTokenEnv(RAW);
const CTX = {
  publicUrl: 'https://threatready.onrender.com', gatewayPort: 10000, onboardPort: 3200, interviewPort: 3100, labsPort: 4000, identityUrl: 'http://127.0.0.1:3200', clientIpHeader: 'x-threatready-client-ip',
  onboardAppDb: 'postgres://threatready_app:role-pw@db/onboard', interviewDb: 'postgres://owner:pw@db/interview', authSecret: 'auth-secret', internalToken: RAW,
  onboardFillerToken: 'f'.repeat(64), tokens: TOKENS, legacyAccept: false,
  socSessionSecret: 'derived-soc', labsDataFile: '/tmp/threatready-labs.json', socDataFile: '/tmp/threatready-soc/cases.json', redteamDataFile: '/tmp/threatready-redteam.json',
  storageSigningSecret: 'derived-storage', turnstile: { siteKey: 'site', secretKey: 'secret' },
};
const LAUNCHER_SECRETS = ['ONBOARD_DATABASE_URL', 'INTERVIEW_DATABASE_URL', 'ONBOARD_APP_DB_PASSWORD', 'DATABASE_MIGRATION_URL', 'SOC_SESSION_SECRET', 'FORCE_ROLE_SYNC', 'TR_STATE_DURABLE', 'LABS_INTERNAL_PORT'];
const LAB_TUNABLES = ['LABS_RATE_PER_MIN', 'LABS_MAX_RUNS_PER_LAB', 'LABS_IDENTITY_MAX_PER_CLIENT', 'AR_RATE_IP_PER_MIN', 'AR_IDENTITY_MAX_IN_FLIGHT', 'REDTEAM_MAX_RUNS_PER_LAB', 'REDTEAM_RATE_PER_MIN', 'SOC_MAX_STREAMS_PER_USER', 'DAILY_WIPE'];
/** Every value in an environment, comma lists split (the token accept lists). */
const values = (env) => Object.values(env).flatMap((v) => String(v).split(','));

test('onboard gets its own tunables and secrets, never InterviewPrep\'s or the launcher\'s', () => {
  const env = childEnv(onboardChildEnv(CTX, SERVICE), SERVICE);
  for (const k of ['TRIAL_ENABLED', 'SIGNIN_LOCKOUT_FAILURES', 'OTP_ISSUE_PER_IP_PER_HOUR', 'ACTIVITY_PING_PER_USER_PER_MINUTE', 'RETENTION_INTERVAL_HOURS', 'SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'AWS_REGION', 'GEO_COUNTRY_MMDB', 'RESEND_API_KEY', 'EMAIL_FROM', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET', 'ADMIN_EMAILS']) {
    assert.equal(env[k], SERVICE[k], k);
  }
  for (const k of [...LAUNCHER_SECRETS, ...LAB_TUNABLES, 'ANTHROPIC_API_KEY', 'S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'LLM_TIMEOUT_MS_LARGE', 'AI_USER_DAILY_CAP_USD', 'WORKER_DATABASE_URL', 'STORAGE_SIGNING_SECRET', 'CLIENT_IP_SOURCE', 'STATE_MIRROR']) {
    assert.equal(env[k], undefined, k);
  }
  // The launcher's values win: app role, not owner; production; the gateway's IP header.
  assert.equal(env.DATABASE_URL, CTX.onboardAppDb);
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.CLIENT_IP_HEADER, 'x-threatready-client-ip');
  assert.equal(env.EMAIL_DRIVER, 'resend');
  assert.equal(env.ALLOW_NO_CAPTCHA, 'false');
  assert.equal(env.RENDER_GIT_COMMIT, 'abc123');
});

test('onboard: one Turnstile key alone is not forwarded (CAPTCHA off instead of a boot failure)', () => {
  const env = childEnv(onboardChildEnv({ ...CTX, turnstile: null }, { ...SERVICE, TURNSTILE_SECRET_KEY: '' }), SERVICE);
  assert.equal(env.TURNSTILE_SITE_KEY, undefined);
  assert.equal(env.TURNSTILE_SECRET_KEY, undefined);
  assert.equal(env.ALLOW_NO_CAPTCHA, 'true');
});

test('InterviewPrep gets its tunables (RATE_LIMIT_SCALE, LLM_*, IDENTITY_*, REPORT_*, S3/AWS, REASONING_*), never onboard\'s secrets', () => {
  const env = childEnv(interviewChildEnv(CTX, SERVICE), SERVICE);
  for (const k of ['RATE_LIMIT_SCALE', 'LLM_TIMEOUT_MS_SMALL', 'LLM_TIMEOUT_MS_LARGE', 'LLM_MAX_RETRIES', 'IDENTITY_CACHE_SECONDS', 'IDENTITY_MAX_IN_FLIGHT', 'REPORT_PDF_ENABLED', 'WORKER_DATABASE_URL', 'S3_BUCKET', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_ENDPOINT_URL_S3', 'SES_FROM_ADDRESS', 'REASONING_POOL_ENABLED', 'REASONING_READY_TTL_HOURS', 'AI_USER_DAILY_CAP_USD', 'INTERVIEW_MONTHLY_QUOTA_FREE', 'INTERVIEW_DATA_STORAGE_LOCATION', 'DATA_RETENTION_DAYS', 'SENTRY_DSN', 'ANTHROPIC_API_KEY', 'LOG_LEVEL']) {
    assert.equal(env[k], SERVICE[k], k);
  }
  for (const k of [...LAUNCHER_SECRETS, ...LAB_TUNABLES, 'BETTER_AUTH_SECRET', 'RESEND_API_KEY', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY', 'ADMIN_EMAILS', 'TRIAL_ENABLED', 'SIGNIN_LOCKOUT_FAILURES', 'ONBOARD_INTERNAL_PORT']) {
    assert.equal(env[k], undefined, k);
  }
  // An operator may switch storage to S3/R2; the LLM driver, database and mode stay the launcher's.
  assert.equal(env.STORAGE_DRIVER, 's3');
  assert.equal(env.LLM_DRIVER, 'anthropic');
  assert.equal(env.DATABASE_URL, CTX.interviewDb);
  assert.equal(env.STORAGE_SIGNING_SECRET, 'derived-storage');
  assert.equal(env.ALLOW_NO_SENTRY, 'false');
  assert.equal(env.RELEASE, 'abc123');
});

test('InterviewPrep without SENTRY_DSN still boots (ALLOW_NO_SENTRY) and keeps the local-storage defaults', () => {
  const service = { ...SERVICE, SENTRY_DSN: '', STORAGE_DRIVER: '' };
  const env = childEnv(interviewChildEnv(CTX, service), service);
  assert.equal(env.ALLOW_NO_SENTRY, 'true');
  assert.equal(env.SENTRY_DSN, undefined);
  assert.equal(env.STORAGE_DRIVER, 'fs');
  assert.equal(env.ALLOW_EPHEMERAL_STORAGE, 'true');
});

test('onboard test hooks it refuses in production are never forwarded (onboard would not boot)', () => {
  const service = { ...SERVICE, RATE_LIMIT_MULTIPLIER: '50', TURNSTILE_VERIFY_URL: 'http://127.0.0.1:9/siteverify' };
  const env = childEnv(onboardChildEnv(CTX, service), service);
  assert.equal(env.RATE_LIMIT_MULTIPLIER, undefined);
  assert.equal(env.TURNSTILE_VERIFY_URL, undefined);
  assert.equal(env.TURNSTILE_SECRET_KEY, 'secret', 'the rest of TURNSTILE_* still reaches onboard');
  assert.deepEqual(testHooksSet('onboard', service), ['TURNSTILE_VERIFY_URL', 'RATE_LIMIT_MULTIPLIER']);
  assert.deepEqual(testHooksSet('onboard', { RATE_LIMIT_MULTIPLIER: '' }), []);
  // InterviewPrep's own RATE_LIMIT_* (e.g. RATE_LIMIT_SCALE) is unaffected.
  assert.equal(childEnv(interviewChildEnv(CTX, service), service).RATE_LIMIT_SCALE, '2');
});

test('tunables(): empty values and launcher-only names are never forwarded', () => {
  assert.deepEqual(tunables('interview', { INTERVIEW_DATABASE_URL: 'x', INTERVIEW_MAX_PAUSES: '', INTERVIEW_INTERNAL_PORT: '3100', AI_SESSION_CAP_USD: '0' }), { AI_SESSION_CAP_USD: '0' });
});

test('labs child: its tunables, the lab files and the SOC secret the launcher decided, nothing of either API', () => {
  const env = childEnv(labsChildEnv(CTX, SERVICE), SERVICE);
  for (const k of LAB_TUNABLES) assert.equal(env[k], SERVICE[k], k);
  assert.equal(env.IDENTITY_CACHE_SECONDS, '30');
  for (const k of [...LAUNCHER_SECRETS.filter((x) => !['SOC_SESSION_SECRET', 'LABS_INTERNAL_PORT'].includes(x)), 'BETTER_AUTH_SECRET', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY',
    'S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'WORKER_DATABASE_URL', 'STORAGE_SIGNING_SECRET', 'DATABASE_URL', 'LLM_TIMEOUT_MS_LARGE', 'RATE_LIMIT_SCALE', 'SIGNIN_LOCKOUT_FAILURES', 'SENTRY_DSN', 'CLIENT_IP_SOURCE', 'STATE_MIRROR']) {
    assert.equal(env[k], undefined, k);
  }
  // SOC test hooks and its standalone-only summary token never reach the hosted SOC.
  for (const k of ['SOC_SIM_TEST', 'SOC_SIM_FAST', 'SOC_INTERNAL_TOKEN']) assert.equal(env[k], undefined, k);
  assert.deepEqual(testHooksSet('labs', SERVICE), ['SOC_SIM_TEST', 'SOC_SIM_FAST', 'SOC_INTERNAL_TOKEN']);
  // The launcher's values win: production, the gateway's IP header, its ports, the files the state mirror restores.
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.CLIENT_IP_HEADER, 'x-threatready-client-ip');
  assert.equal(env.PUBLIC_URL, CTX.publicUrl);
  assert.deepEqual([env.ONBOARD_INTERNAL_PORT, env.INTERVIEW_INTERNAL_PORT, env.LABS_INTERNAL_PORT], ['3200', '3100', '4000']);
  assert.deepEqual([env.LABS_DATA_FILE, env.SOC_DATA_FILE, env.REDTEAM_DATA_FILE], [CTX.labsDataFile, CTX.socDataFile, CTX.redteamDataFile]);
  assert.equal(env.SOC_SESSION_SECRET, 'derived-soc');
  assert.equal(env.SIM_SESSION_SECRET, 'derived-soc');
  assert.equal(env.TR_STATE_DURABLE, undefined, 'the state mirror decides durability (start.mjs adds it per start), never the operator');
});

test('per-caller tokens: production children never get the raw INTERNAL_API_TOKEN, only what they accept and present', () => {
  const onboard = childEnv(onboardChildEnv(CTX, SERVICE), SERVICE);
  const interview = childEnv(interviewChildEnv(CTX, SERVICE), SERVICE);
  const labs = childEnv(labsChildEnv(CTX, SERVICE), SERVICE);
  for (const [name, env] of [['onboard', onboard], ['interview', interview], ['labs', labs]]) {
    assert.ok(!values(env).includes(RAW), `${name} holds the raw token`);
    assert.equal(env.INTERNAL_TOKEN_LEGACY_ACCEPT, 'false', `${name}: legacy acceptance off`);
    assert.notEqual(env.INTERNAL_TOKENS_ACCEPT, 'operator-set-token-list', `${name}: the operator cannot replace the accept list`);
    assert.notEqual(env.INTERNAL_TOKEN_FROM_ONBOARD, 'operator-set-onboard-token', `${name}: the operator cannot replace the onboard-only token`);
  }
  for (const [k, v] of Object.entries(TOKENS.onboard)) assert.equal(onboard[k], v, `onboard ${k}`);
  for (const [k, v] of Object.entries(TOKENS.interview)) assert.equal(interview[k], v, `interview ${k}`);
  for (const [k, v] of Object.entries(TOKENS.labs)) assert.equal(labs[k], v, `labs ${k}`);
  // Onboard's required INTERNAL_API_TOKEN is the filler nobody else holds; InterviewPrep's is what it presents to onboard; the labs child has none.
  assert.equal(onboard.INTERNAL_API_TOKEN, CTX.onboardFillerToken);
  assert.equal(interview.INTERNAL_API_TOKEN, TOKENS.interview.INTERNAL_TOKEN_TO_ONBOARD);
  assert.ok(onboard.INTERNAL_TOKENS_ACCEPT.split(',').includes(interview.INTERNAL_API_TOKEN));
  assert.equal(labs.INTERNAL_API_TOKEN, undefined);
  // What the labs child holds opens InterviewPrep only as Attack Reasoning (ar->interview), never as onboard.
  const interviewAccepts = interview.INTERNAL_TOKENS_ACCEPT.split(',');
  assert.deepEqual(values(labs).filter((v) => interviewAccepts.includes(v)).sort(), [TOKENS.labs.AR_INTERNAL_TOKEN_TO_INTERVIEW, TOKENS.labs.INTERNAL_TOKEN_TO_INTERVIEW].sort());
  assert.ok(!values(labs).includes(TOKENS.onboard.INTERNAL_TOKEN_TO_INTERVIEW));
  // ...and InterviewPrep's onboard-only routes (erasure, summary, AI usage) accept onboard's token alone, which
  // the labs child does not hold (M-SEC-1: the ar->interview token must not erase a learner).
  assert.equal(interview.INTERNAL_TOKEN_FROM_ONBOARD, TOKENS.onboard.INTERNAL_TOKEN_TO_INTERVIEW);
  assert.deepEqual(values(labs).filter((v) => v === interview.INTERNAL_TOKEN_FROM_ONBOARD), []);
  assert.deepEqual(values(onboard).filter((v) => v === interview.INTERNAL_TOKEN_FROM_ONBOARD), [TOKENS.onboard.INTERNAL_TOKEN_TO_INTERVIEW]);
  // Onboard reaches the labs child directly (not through the public port); InterviewPrep's home is the origin root (the web adds /interview-prep).
  assert.equal(onboard.LABS_INTERNAL_URL, 'http://127.0.0.1:4000/labs');
  assert.equal(onboard.REASONING_INTERNAL_URL, 'http://127.0.0.1:4000/ar');
  assert.equal(onboard.INTERVIEW_APP_URL, 'https://threatready.onrender.com/');
});

test('per-caller tokens with INTERNAL_TOKEN_LEGACY_ACCEPT on: every child gets the raw token next to its own', () => {
  const ctx = { ...CTX, legacyAccept: true };
  for (const [name, env] of [['onboard', onboardChildEnv(ctx, SERVICE)], ['interview', interviewChildEnv(ctx, SERVICE)], ['labs', labsChildEnv(ctx, SERVICE)]]) {
    assert.equal(env.INTERNAL_API_TOKEN, RAW, name);
    assert.equal(env.INTERNAL_TOKEN_LEGACY_ACCEPT, 'true', name);
  }
});

test('InterviewPrep gets LLM_MODEL_SMALL and REASONING_ITEM_MAX_SERVES (patch 2) by its LLM_/REASONING_ prefixes, and keeps our INTERVIEW_*/IDENTITY_*/RATE_LIMIT_SCALE tunables', () => {
  const service = { ...SERVICE, LLM_MODEL_SMALL: 'claude-haiku-4-5', REASONING_ITEM_MAX_SERVES: '25', INTERVIEW_RATE_TURNS_PER_MIN: '12', INTERVIEW_UPLOAD_MAX_MB: '6', IDENTITY_MAX_IN_FLIGHT_PER_CLIENT: '8' };
  const env = childEnv(interviewChildEnv(CTX, service), service);
  for (const k of ['LLM_MODEL_SMALL', 'REASONING_ITEM_MAX_SERVES', 'INTERVIEW_RATE_TURNS_PER_MIN', 'INTERVIEW_UPLOAD_MAX_MB', 'INTERVIEW_DATA_STORAGE_LOCATION', 'IDENTITY_MAX_IN_FLIGHT_PER_CLIENT', 'RATE_LIMIT_SCALE']) assert.equal(env[k], service[k], k);
  assert.equal(childEnv(labsChildEnv(CTX, service), service).LLM_MODEL_SMALL, undefined, 'the labs child gets no InterviewPrep setting');
});

test('InterviewPrep gets Attack Reasoning\'s own SMALL model and effort settings (REASONING_MODEL_SMALL, 27 Oct 2026) by the REASONING_ prefix, next to an unchanged LLM_MODEL_SMALL', () => {
  const service = { ...SERVICE, LLM_MODEL_SMALL: 'claude-haiku-4-5', REASONING_MODEL_SMALL: 'claude-haiku-5-5', REASONING_SMALL_EFFORT_GENERATION: 'medium', REASONING_SMALL_EFFORT_EVALUATION: 'low' };
  const env = childEnv(interviewChildEnv(CTX, service), service);
  for (const k of ['LLM_MODEL_SMALL', 'REASONING_MODEL_SMALL', 'REASONING_SMALL_EFFORT_GENERATION', 'REASONING_SMALL_EFFORT_EVALUATION']) assert.equal(env[k], service[k], k);
  assert.equal(childEnv(labsChildEnv(CTX, service), service).REASONING_MODEL_SMALL, undefined, 'the labs child gets no InterviewPrep setting');
});
