// Environment for the launcher's child processes (deploy/start.mjs). Children get an explicit
// allowlist, never this process's whole environment: the owner DB URL, the other app's database,
// its API keys and the role password stay in the launcher.

/** Process basics every child needs. */
export const BASE_KEYS = ['NODE_ENV', 'PATH', 'HOME', 'TZ', 'LANG', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];

/**
 * The launcher's own credentials. Never forwarded by name or prefix: where a child needs one of
 * these values, the launcher passes it explicitly (under the child's own name, e.g. DATABASE_URL).
 */
export const LAUNCHER_ONLY = new Set([
  'ONBOARD_DATABASE_URL', 'INTERVIEW_DATABASE_URL', 'ONBOARD_APP_DB_PASSWORD', 'DATABASE_MIGRATION_URL', 'DATABASE_URL',
  'BETTER_AUTH_SECRET', 'INTERNAL_API_TOKEN', 'STORAGE_SIGNING_SECRET', 'SOC_SESSION_SECRET', 'SIM_SESSION_SECRET', 'APP_SECRET',
  'ONBOARD_INTERNAL_PORT', 'INTERVIEW_INTERNAL_PORT',
]);

/**
 * Optional operator settings (Render dashboard) each child reads, by prefix or exact key: the names
 * in that app's own config schema. A key matching neither list is not forwarded. Secrets belonging to
 * the other app never match (onboard: no ANTHROPIC_/AI_/LLM_/S3_/AWS keys; InterviewPrep: no
 * RESEND_, GOOGLE_, GITHUB_, TURNSTILE_ or BETTER_AUTH_ keys).
 */
export const TUNABLES = {
  onboard: {
    // Threatready-landing-page-main/apps/api/src/config.ts
    prefixes: ['TRIAL_', 'AUTH_', 'SIGNIN_', 'OTP_', 'ACTIVITY_', 'RETENTION_', 'TURNSTILE_', 'SENTRY_', 'RATE_LIMIT_'],
    keys: ['RESEND_API_KEY', 'EMAIL_FROM', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
      'ADMIN_EMAILS', 'COOKIE_DOMAIN', 'GEO_COUNTRY_MMDB', 'AWS_REGION', 'INTERVIEW_STATUS', 'LABS_STATUS', 'LOG_LEVEL', 'RELEASE'],
  },
  interview: {
    // InterviewPrep/apps/api/src/config/config.ts
    prefixes: ['AI_', 'LLM_', 'REASONING_', 'INTERVIEW_', 'RATE_LIMIT_', 'REPORT_', 'STORAGE_', 'S3_', 'AWS_', 'SES_', 'SENTRY_', 'DATA_', 'IDENTITY_', 'WORKER_', 'DATABASE_POOL_'],
    keys: ['ANTHROPIC_API_KEY', 'FS_STORAGE_DIR', 'ALLOW_EPHEMERAL_STORAGE', 'ALLOWED_APP_ORIGINS', 'CONTENT_DIR', 'LOG_LEVEL', 'RELEASE'],
  },
};

/**
 * Test hooks a child refuses to boot with in production (onboard config.ts). They match a forwarded
 * prefix but are never forwarded: production behaves as if they were unset (the launcher logs it).
 */
export const TEST_HOOKS = { onboard: ['TURNSTILE_VERIFY_URL', 'RATE_LIMIT_MULTIPLIER'], interview: [] };

/** The optional settings for `child` that are set (non-empty) in `env`. */
export function tunables(child, env = process.env) {
  const { prefixes, keys } = TUNABLES[child];
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === '' || LAUNCHER_ONLY.has(k) || TEST_HOOKS[child].includes(k)) continue;
    if (keys.includes(k) || prefixes.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

/** The test hooks for `child` set in `env` (names only), which tunables() leaves out. */
export const testHooksSet = (child, env = process.env) => TEST_HOOKS[child].filter((k) => env[k] !== undefined && env[k] !== '');

/**
 * A child's full environment: base keys, Render's own RENDER* metadata, then `extra` (already merged
 * by the caller as defaults < tunables < forced values). Unset or empty values are left out.
 */
export function childEnv(extra, env = process.env) {
  const out = {};
  for (const k of BASE_KEYS) if (env[k] !== undefined) out[k] = env[k];
  for (const k of Object.keys(env)) if (k.startsWith('RENDER')) out[k] = env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') out[k] = String(v);
  return out;
}

/**
 * What the launcher decided for this deployment (deploy/start.mjs): public URL, loopback ports,
 * connection strings, secrets, and Turnstile keys when both are set.
 * @typedef {{ publicUrl: string, gatewayPort: number, interviewPort: number, identityUrl: string, clientIpHeader: string,
 *   onboardAppDb: string, interviewDb: string, authSecret: string, internalToken: string, storageSigningSecret: string,
 *   turnstile: { siteKey: string, secretKey: string } | null }} LaunchContext
 */

/** Onboard: the app role's DATABASE_URL only (the owner URL is for migrations). Tunables cannot override the launcher's values. */
export function onboardChildEnv(ctx, env = process.env) {
  const u = ctx.publicUrl;
  return {
    ...tunables('onboard', env),
    NODE_ENV: 'production',
    CLIENT_IP_HEADER: ctx.clientIpHeader,
    DATABASE_URL: ctx.onboardAppDb,
    BETTER_AUTH_SECRET: ctx.authSecret,
    BETTER_AUTH_URL: u,
    WEB_ORIGIN: u,
    PUBLIC_URL: u,
    INTERNAL_API_TOKEN: ctx.internalToken,
    INTERVIEW_APP_URL: `${u}/`,
    LABS_APP_URL: `${u}/labs/`,
    REASONING_APP_URL: `${u}/ar/`,
    INTERVIEW_INTERNAL_URL: `http://127.0.0.1:${ctx.interviewPort}`,
    LABS_INTERNAL_URL: `http://127.0.0.1:${ctx.gatewayPort}/labs`,
    REASONING_INTERNAL_URL: `http://127.0.0.1:${ctx.gatewayPort}/ar`,
    REASONING_STATUS: 'live',
    EMAIL_DRIVER: env.RESEND_API_KEY ? 'resend' : 'log',
    // Both Turnstile keys or none (undefined drops a forwarded one): with one, onboard refuses to boot.
    TURNSTILE_SITE_KEY: ctx.turnstile?.siteKey,
    TURNSTILE_SECRET_KEY: ctx.turnstile?.secretKey,
    ALLOW_NO_CAPTCHA: ctx.turnstile ? 'false' : 'true',
  };
}

/**
 * InterviewPrep: its own database and the Anthropic key; never onboard's secrets. Storage links are
 * signed with a purpose-specific derived key, not the platform auth secret. The first block are
 * defaults an operator may change (durable uploads/PDFs: STORAGE_DRIVER=s3 with S3_BUCKET and AWS_*
 * for AWS S3; Cloudflare R2 first needs presigned PUT uploads and an endpoint setting in InterviewPrep,
 * see deploy/README.md).
 */
export function interviewChildEnv(ctx, env = process.env) {
  return {
    STORAGE_DRIVER: 'fs',
    FS_STORAGE_DIR: '/tmp/threatready-storage',
    ALLOW_EPHEMERAL_STORAGE: 'true',
    LLM_VERIFY_MODELS_ON_BOOT: 'false',
    DATABASE_POOL_MAX: '5',
    RELEASE: env.RENDER_GIT_COMMIT,
    ...tunables('interview', env),
    NODE_ENV: 'production',
    CLIENT_IP_HEADER: ctx.clientIpHeader,
    DATABASE_URL: ctx.interviewDb,
    APP_ORIGIN: new URL(ctx.publicUrl).origin,
    API_BASE_URL: ctx.publicUrl,
    ONBOARD_URL: ctx.publicUrl,
    IDENTITY_URL: ctx.identityUrl,
    INTERNAL_API_TOKEN: ctx.internalToken,
    STORAGE_SIGNING_SECRET: ctx.storageSigningSecret,
    // Error tracking when SENTRY_DSN is set; booting without it stays allowed.
    ALLOW_NO_SENTRY: env.SENTRY_DSN ? 'false' : 'true',
    LLM_DRIVER: 'anthropic',
    // No mail driver for InterviewPrep on this deployment, so no report emails.
    EMAIL_DRIVER: 'log',
    REPORT_EMAIL_ENABLED: 'false',
  };
}
