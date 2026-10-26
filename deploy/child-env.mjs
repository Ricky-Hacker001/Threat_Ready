// Environment for the launcher's child processes (deploy/start.mjs). Children get an explicit
// allowlist, never this process's whole environment: the owner DB URL, the other app's database,
// its API keys, the role password and the raw internal token stay in the launcher.

/** Process basics every child needs. */
export const BASE_KEYS = ['NODE_ENV', 'PATH', 'HOME', 'TZ', 'LANG', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];

/**
 * The launcher's own credentials and decisions. Never forwarded by name or prefix: where a child needs
 * one of these values, the launcher passes it explicitly (under the child's own name, e.g. DATABASE_URL),
 * or a value derived from it (the per-caller internal tokens instead of INTERNAL_API_TOKEN).
 */
export const LAUNCHER_ONLY = new Set([
  'ONBOARD_DATABASE_URL', 'INTERVIEW_DATABASE_URL', 'ONBOARD_APP_DB_PASSWORD', 'DATABASE_MIGRATION_URL', 'DATABASE_URL',
  'BETTER_AUTH_SECRET', 'INTERNAL_API_TOKEN', 'STORAGE_SIGNING_SECRET', 'SOC_SESSION_SECRET', 'SIM_SESSION_SECRET', 'APP_SECRET',
  'ONBOARD_INTERNAL_PORT', 'INTERVIEW_INTERNAL_PORT', 'LABS_INTERNAL_PORT',
  // Per-caller internal tokens and their switches: derived and decided by the launcher only.
  'INTERNAL_TOKENS_ACCEPT', 'INTERNAL_TOKEN_FROM_ONBOARD', 'INTERNAL_TOKEN_LEGACY_ACCEPT', 'INTERNAL_TOKEN_TO_ONBOARD', 'INTERNAL_TOKEN_TO_INTERVIEW', 'INTERNAL_TOKEN_TO_LABS', 'INTERNAL_TOKEN_TO_AR',
  'LABS_INTERNAL_TOKENS_ACCEPT', 'LABS_INTERNAL_TOKEN_TO_ONBOARD', 'AR_INTERNAL_TOKENS_ACCEPT', 'AR_INTERNAL_TOKEN_TO_ONBOARD', 'AR_INTERNAL_TOKEN_TO_INTERVIEW', 'REDTEAM_INTERNAL_TOKEN_TO_ONBOARD',
  'FORCE_ROLE_SYNC',
  // Lab state: where the files are and whether they outlive a restart (the state mirror's call).
  'TR_STATE_DURABLE', 'LABS_DATA_FILE', 'SOC_DATA_FILE', 'REDTEAM_DATA_FILE',
]);

/**
 * Optional operator settings (Render dashboard) each child reads, by prefix or exact key: the names
 * in that app's own config schema. A key matching neither list is not forwarded. Secrets belonging to
 * another app never match (onboard: no ANTHROPIC_/AI_/LLM_/S3_/AWS keys; InterviewPrep: no
 * RESEND_, GOOGLE_, GITHUB_, TURNSTILE_ or BETTER_AUTH_ keys; labs child: neither app's keys).
 */
export const TUNABLES = {
  onboard: {
    // Threatready-landing-page-main/apps/api/src/config.ts
    prefixes: ['TRIAL_', 'AUTH_', 'SIGNIN_', 'OTP_', 'ACTIVITY_', 'RETENTION_', 'TURNSTILE_', 'SENTRY_', 'RATE_LIMIT_'],
    keys: ['RESEND_API_KEY', 'EMAIL_FROM', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
      'ADMIN_EMAILS', 'COOKIE_DOMAIN', 'GEO_COUNTRY_MMDB', 'AWS_REGION', 'INTERVIEW_STATUS', 'LABS_STATUS', 'LOG_LEVEL', 'RELEASE'],
  },
  interview: {
    // InterviewPrep/apps/api/src/config/config.ts (LLM_MODEL_SMALL, required in production, is an LLM_ key;
    // REASONING_ITEM_MAX_SERVES a REASONING_ one).
    prefixes: ['AI_', 'LLM_', 'REASONING_', 'INTERVIEW_', 'RATE_LIMIT_', 'REPORT_', 'STORAGE_', 'S3_', 'AWS_', 'SES_', 'SENTRY_', 'DATA_', 'IDENTITY_', 'WORKER_', 'DATABASE_POOL_'],
    keys: ['ANTHROPIC_API_KEY', 'FS_STORAGE_DIR', 'ALLOW_EPHEMERAL_STORAGE', 'ALLOWED_APP_ORIGINS', 'CONTENT_DIR', 'LOG_LEVEL', 'RELEASE'],
  },
  labs: {
    // deploy/labs-child.mjs: Lab Simulations (LABS_RATE_*, LABS_MAX_RUNS_PER_LAB, LABS_IDENTITY_MAX_*),
    // Attack Reasoning (AR_RATE_*, AR_IDENTITY_MAX_*), Red Team (REDTEAM_RATE_*, REDTEAM_MAX_RUNS_PER_LAB,
    // REDTEAM_IDENTITY_MAX_*), SOC (SOC_MAX_STREAMS_PER_USER, ...), the identity cache and SOC's daily wipe.
    prefixes: ['LABS_', 'AR_', 'REDTEAM_', 'SOC_'],
    keys: ['IDENTITY_CACHE_SECONDS', 'DAILY_WIPE'],
  },
};

/**
 * Settings a child must never get in production, although they match a forwarded prefix: test hooks
 * (onboard refuses to boot with its own; SOC's speed/test switches) and standalone-only credentials
 * (SOC_INTERNAL_TOKEN: the hosted SOC's summary is read in process). Production behaves as if they were
 * unset; the launcher logs their names.
 */
export const TEST_HOOKS = { onboard: ['TURNSTILE_VERIFY_URL', 'RATE_LIMIT_MULTIPLIER'], interview: [], labs: ['SOC_SIM_TEST', 'SOC_SIM_FAST', 'SOC_INTERNAL_TOKEN'] };

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
 * connection strings, secrets, per-caller internal tokens (deploy/launcher-lib.mjs internalTokenEnv),
 * whether the raw token is still accepted (legacyAccept; off in production by default), lab state files,
 * and Turnstile keys when both are set.
 * @typedef {{ publicUrl: string, gatewayPort: number, onboardPort: number, interviewPort: number, labsPort: number, identityUrl: string, clientIpHeader: string,
 *   onboardAppDb: string, interviewDb: string, authSecret: string, internalToken: string, onboardFillerToken: string, storageSigningSecret: string,
 *   tokens: { onboard: Record<string, string>, interview: Record<string, string>, labs: Record<string, string> }, legacyAccept: boolean,
 *   socSessionSecret: string, labsDataFile: string, socDataFile: string, redteamDataFile: string,
 *   turnstile: { siteKey: string, secretKey: string } | null }} LaunchContext
 */

/** Values every child gets from the launcher: production mode, the gateway's IP header, the token rule. */
const common = (ctx) => ({
  NODE_ENV: 'production',
  CLIENT_IP_HEADER: ctx.clientIpHeader,
  INTERNAL_TOKEN_LEGACY_ACCEPT: ctx.legacyAccept ? 'true' : 'false',
});

/** Onboard: the app role's DATABASE_URL only (the owner URL is for migrations). Tunables cannot override the launcher's values. */
export function onboardChildEnv(ctx, env = process.env) {
  const u = ctx.publicUrl;
  return {
    ...tunables('onboard', env),
    ...common(ctx),
    DATABASE_URL: ctx.onboardAppDb,
    BETTER_AUTH_SECRET: ctx.authSecret,
    BETTER_AUTH_URL: u,
    WEB_ORIGIN: u,
    PUBLIC_URL: u,
    // Onboard's config requires INTERNAL_API_TOKEN (>= 32 chars). With legacy acceptance off it is a filler
    // value nobody else holds, so it is accepted from no one and presented to no one (the per-caller tokens
    // are); the raw token reaches a child only while legacy acceptance is on.
    INTERNAL_API_TOKEN: ctx.legacyAccept ? ctx.internalToken : ctx.onboardFillerToken,
    ...ctx.tokens?.onboard,
    // InterviewPrep's base URL is the origin root: the onboard web adds its home path (interview-prep, see
    // apps/web/src/components/Platform.tsx APP_PATH), so a base of /interview-prep/ would link to
    // /interview-prep/interview-prep.
    INTERVIEW_APP_URL: `${u}/`,
    LABS_APP_URL: `${u}/labs/`,
    REASONING_APP_URL: `${u}/ar/`,
    INTERVIEW_INTERNAL_URL: `http://127.0.0.1:${ctx.interviewPort}`,
    // Straight to the labs child, not through the gateway: fewer hops, no dependency on the public port.
    LABS_INTERNAL_URL: `http://127.0.0.1:${ctx.labsPort}/labs`,
    REASONING_INTERNAL_URL: `http://127.0.0.1:${ctx.labsPort}/ar`,
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
 * see deploy/README.md). In production it refuses to boot without INTERNAL_TOKENS_ACCEPT and
 * INTERNAL_TOKEN_FROM_ONBOARD (unless legacy acceptance is on; the latter is the only token its
 * onboard-only routes accept: summary, AI usage, account erasure) and without LLM_MODEL_SMALL (an
 * operator setting, declared in render.yaml).
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
    ...common(ctx),
    DATABASE_URL: ctx.interviewDb,
    APP_ORIGIN: new URL(ctx.publicUrl).origin,
    API_BASE_URL: ctx.publicUrl,
    ONBOARD_URL: ctx.publicUrl,
    IDENTITY_URL: ctx.identityUrl,
    // What it presents to onboard (its config requires INTERNAL_API_TOKEN); the raw token only with legacy acceptance.
    INTERNAL_API_TOKEN: ctx.legacyAccept ? ctx.internalToken : ctx.tokens?.interview?.INTERNAL_TOKEN_TO_ONBOARD,
    ...ctx.tokens?.interview,
    STORAGE_SIGNING_SECRET: ctx.storageSigningSecret,
    // Error tracking when SENTRY_DSN is set; booting without it stays allowed.
    ALLOW_NO_SENTRY: env.SENTRY_DSN ? 'false' : 'true',
    LLM_DRIVER: 'anthropic',
    // No mail driver for InterviewPrep on this deployment, so no report emails.
    EMAIL_DRIVER: 'log',
    REPORT_EMAIL_ENABLED: 'false',
  };
}

/**
 * Labs child (deploy/labs-child.mjs): Lab Simulations, the hosted labs (SOC, Red Team, ...) and Attack
 * Reasoning. No database, no API keys: its per-caller tokens (what it accepts from onboard, what it
 * presents to onboard and InterviewPrep), the lab state files the launcher mirrors, the SOC session
 * secret (derived per purpose) and the labs' own tunables.
 */
export function labsChildEnv(ctx, env = process.env) {
  return {
    ...tunables('labs', env),
    ...common(ctx),
    PUBLIC_URL: ctx.publicUrl,
    ONBOARD_INTERNAL_PORT: String(ctx.onboardPort),
    INTERVIEW_INTERNAL_PORT: String(ctx.interviewPort),
    LABS_INTERNAL_PORT: String(ctx.labsPort),
    INTERNAL_API_TOKEN: ctx.legacyAccept ? ctx.internalToken : undefined,
    ...ctx.tokens?.labs,
    SOC_SESSION_SECRET: ctx.socSessionSecret,
    SIM_SESSION_SECRET: ctx.socSessionSecret,
    LABS_DATA_FILE: ctx.labsDataFile,
    SOC_DATA_FILE: ctx.socDataFile,
    REDTEAM_DATA_FILE: ctx.redteamDataFile,
  };
}
