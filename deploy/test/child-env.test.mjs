// What each child process receives (TR-19 allowlist, OPS-REG2 tunables pass-through, TR-14 Sentry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, interviewChildEnv, onboardChildEnv, testHooksSet, tunables } from '../child-env.mjs';

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
};
const CTX = {
  publicUrl: 'https://threatready.onrender.com', gatewayPort: 10000, interviewPort: 3100, identityUrl: 'http://127.0.0.1:3200', clientIpHeader: 'x-threatready-client-ip',
  onboardAppDb: 'postgres://threatready_app:role-pw@db/onboard', interviewDb: 'postgres://owner:pw@db/interview', authSecret: 'auth-secret', internalToken: 'internal-token',
  storageSigningSecret: 'derived-storage', turnstile: { siteKey: 'site', secretKey: 'secret' },
};
const LAUNCHER_SECRETS = ['ONBOARD_DATABASE_URL', 'INTERVIEW_DATABASE_URL', 'ONBOARD_APP_DB_PASSWORD', 'DATABASE_MIGRATION_URL', 'SOC_SESSION_SECRET'];

test('onboard gets its own tunables and secrets, never InterviewPrep\'s or the launcher\'s', () => {
  const env = childEnv(onboardChildEnv(CTX, SERVICE), SERVICE);
  for (const k of ['TRIAL_ENABLED', 'SIGNIN_LOCKOUT_FAILURES', 'OTP_ISSUE_PER_IP_PER_HOUR', 'ACTIVITY_PING_PER_USER_PER_MINUTE', 'RETENTION_INTERVAL_HOURS', 'SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'AWS_REGION', 'GEO_COUNTRY_MMDB', 'RESEND_API_KEY', 'EMAIL_FROM', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET', 'ADMIN_EMAILS']) {
    assert.equal(env[k], SERVICE[k], k);
  }
  for (const k of [...LAUNCHER_SECRETS, 'ANTHROPIC_API_KEY', 'S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'LLM_TIMEOUT_MS_LARGE', 'AI_USER_DAILY_CAP_USD', 'WORKER_DATABASE_URL', 'STORAGE_SIGNING_SECRET', 'CLIENT_IP_SOURCE', 'STATE_MIRROR']) {
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
  for (const k of [...LAUNCHER_SECRETS, 'BETTER_AUTH_SECRET', 'RESEND_API_KEY', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY', 'ADMIN_EMAILS', 'TRIAL_ENABLED', 'SIGNIN_LOCKOUT_FAILURES', 'ONBOARD_INTERNAL_PORT']) {
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
