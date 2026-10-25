import { z } from 'zod';
import { MODEL_PRICING, type ModelPricing } from '../modules/ai/pricing.js';

/**
 * Server configuration, validated at boot. In AWS, ECS injects these from SSM Parameter Store
 * (SecureString) and Secrets Manager (the RDS credential); nothing is read from files (L24).
 */
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    DATABASE_URL: z.string().min(1),
    /** Worker role connection; defaults to DATABASE_URL in development. */
    WORKER_DATABASE_URL: z.string().optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().default(10),

    /** This app's public origin, e.g. https://interviewprep.threatready.io */
    APP_ORIGIN: z.url(),
    /**
     * Other ThreatReady origins allowed to call this API with the shared session (CORS and the
     * Origin check on state-changing requests): the Attack Reasoning app, ar.threatready.io.
     * Comma-separated. Empty when every app shares one origin.
     */
    ALLOWED_APP_ORIGINS: z.string().default(''),
    API_BASE_URL: z.url(),
    /**
     * Signs local-storage upload and download links (STORAGE_DRIVER=fs). Preferred over
     * BETTER_AUTH_SECRET so the storage HMAC key is never the platform's auth secret.
     */
    STORAGE_SIGNING_SECRET: z.string().min(32).optional(),
    /**
     * Legacy fallback for STORAGE_SIGNING_SECRET. Sign-in no longer happens here: the name is kept
     * so existing .env files keep working. Optional once STORAGE_SIGNING_SECRET is set.
     */
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    /**
     * Header carrying the visitor's IP when a trusted gateway sets it (e.g. x-threatready-client-ip).
     * Unset: Express's req.ip (trust proxy 1). Used for IP-keyed limits on public routes.
     */
    CLIENT_IP_HEADER: z.string().min(1).max(64).optional(),

    /**
     * Identity provider (onboard.threatready.io). The browser's session cookie is forwarded to
     * IDENTITY_URL/api/internal/identity/session with INTERNAL_API_TOKEN; there is no local login.
     */
    IDENTITY_URL: z.url().default('http://localhost:3000'),
    /** Public onboard origin the browser is sent to for sign-in and sign-out. */
    ONBOARD_URL: z.url().default('http://localhost:5173'),
    /** Shared secret for /internal/* in both directions (same value in onboard and Labs). */
    INTERNAL_API_TOKEN: z.string().min(32),
    /** Seconds a resolved session is reused before asking onboard again. Revocation lags by this much. */
    IDENTITY_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
    /**
     * Concurrent session lookups against onboard: in total, and per client IP (so one source cannot
     * fill the total and lock out everyone else). 0 = no cap.
     */
    IDENTITY_MAX_IN_FLIGHT: z.coerce.number().int().min(0).default(50),
    /** Past this a client's further cold lookups wait up to 2 s for a slot, then get a retryable 429. */
    IDENTITY_MAX_IN_FLIGHT_PER_CLIENT: z.coerce.number().int().min(0).default(8),

    STORAGE_DRIVER: z.enum(['s3', 'fs']).default('s3'),
    AWS_REGION: z.string().default('ap-south-1'),
    S3_BUCKET: z.string().optional(),
    FS_STORAGE_DIR: z.string().default('./var/storage'),

    ANTHROPIC_API_KEY: z.string().optional(),
    /** The application asks for tiers; these map tiers to verified model ids (L15). */
    LLM_MODEL_SMALL: z.string().default('claude-haiku-4-5'),
    LLM_MODEL_LARGE: z.string().default('claude-sonnet-5-5'),
    /** Optional model to retry on a refusal stop for LARGE-tier calls. */
    LLM_REFUSAL_FALLBACK_MODEL: z.string().optional(),
    LLM_TIMEOUT_MS_SMALL: z.coerce.number().int().default(20_000),
    LLM_TIMEOUT_MS_LARGE: z.coerce.number().int().default(120_000),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(4).default(2),
    LLM_VERIFY_MODELS_ON_BOOT: bool.default(false),
    /** JSON map of model id -> pricing for models not in the verified registry. */
    LLM_PRICING_OVERRIDES: z.string().optional(),
    /** 'anthropic' in every deployed environment; 'fake' only for local demos and tests. */
    LLM_DRIVER: z.enum(['anthropic', 'fake']).default('anthropic'),

    AI_SESSION_CAP_USD: z.coerce.number().positive().default(0.6),
    AI_FINAL_SCORING_RESERVE_USD: z.coerce.number().nonnegative().default(0.2),
    AI_USER_DAILY_CAP_USD: z.coerce.number().positive().default(2),
    AI_GLOBAL_DAILY_CAP_USD: z.coerce.number().positive().default(60),
    /**
     * Finalize-class work (final scoring, later reasoning stages) skips the user's daily cap so admitted
     * work completes; this bounds what one feature may spend on one session or attempt across every
     * retry (about five full final scorings at the default). 0 = no ceiling.
     */
    AI_FINALIZE_SOURCE_CAP_USD: z.coerce.number().nonnegative().default(1),
    INTERVIEW_MONTHLY_QUOTA_FREE: z.coerce.number().int().positive().default(5),
    INTERVIEW_MAX_OPEN_SESSIONS: z.coerce.number().int().positive().default(2),
    /** Pauses a candidate may take in one interview (idle auto-pauses are not counted). 0 = unlimited. */
    INTERVIEW_MAX_PAUSES: z.coerce.number().int().min(0).default(0),
    /** Multiplies the tier-2 rate limits (load tests, staging); 1 in production. 0 turns them off. */
    RATE_LIMIT_SCALE: z.coerce.number().nonnegative().default(1),
    /**
     * Tier-2 limits per signed-in user and route class (ADD L12 starting values). 0 turns that class off.
     * Uploads, pasted job descriptions and text corrections have separate buckets, so retries of one
     * never lock the learner out of the others.
     */
    INTERVIEW_RATE_GENERAL_PER_MIN: z.coerce.number().int().min(0).default(600),
    INTERVIEW_RATE_UPLOADS_PER_HOUR: z.coerce.number().int().min(0).default(10),
    INTERVIEW_RATE_JD_TEXTS_PER_HOUR: z.coerce.number().int().min(0).default(20),
    INTERVIEW_RATE_TEXT_EDITS_PER_HOUR: z.coerce.number().int().min(0).default(30),
    INTERVIEW_RATE_TURNS_PER_MIN: z.coerce.number().int().min(0).default(40),
    INTERVIEW_RATE_CREATES_PER_HOUR: z.coerce.number().int().min(0).default(10),
    /** Attack Reasoning questions started per signed-in user per hour (route class reasoning_create). 0 = off. */
    REASONING_RATE_CREATES_PER_HOUR: z.coerce.number().int().min(0).default(10),
    /**
     * Local-storage uploads (STORAGE_DRIVER=fs): failed signature checks per client IP per 10 minutes
     * (valid uploads are bounded by their single-use signed link, never by IP), and uploads the process
     * receives at once (they stream to disk, so this bounds open files and slow clients, not memory). 0 = no limit.
     */
    INTERVIEW_UPLOAD_FAILURES_PER_IP: z.coerce.number().int().min(0).default(30),
    INTERVIEW_UPLOAD_CONCURRENCY: z.coerce.number().int().min(0).default(16),
    /** Downloads of the licensed 3D interviewer model per user per UTC day (licence §4.3b). 0 = no limit. */
    INTERVIEW_MODEL_DOWNLOADS_PER_DAY: z.coerce.number().int().min(0).default(30),
    /**
     * Where uploaded files and extracted text are stored, as shown in the consent notice (for example
     * "Singapore"). Unset: the notice uses neutral wording without a location.
     */
    INTERVIEW_DATA_STORAGE_LOCATION: z.string().trim().min(1).max(80).optional(),

    /** Attack Reasoning: open (unfinished) attempts a user may hold, generation retries, similarity threshold. */
    REASONING_MAX_OPEN_ATTEMPTS: z.coerce.number().int().positive().default(3),
    /** Answers a learner may submit for evaluation per UTC day (each evaluation is up to three LARGE calls). 0 = no daily limit. */
    REASONING_USER_DAILY_EVALUATIONS: z.coerce.number().int().min(0).default(20),
    /** Pool refills one learner may trigger per UTC day (via create or prefetch); the schedule refills the rest. 0 = no limit. */
    REASONING_USER_DAILY_REFILLS: z.coerce.number().int().min(0).default(60),
    /** Manual retries of a failed generation, and separately of a failed evaluation, per attempt. 0 = no ceiling. */
    REASONING_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(2),
    /** Hours an unanswered (ready) question stays open before the sweeper marks it skipped. 0 = never. */
    REASONING_READY_TTL_HOURS: z.coerce.number().int().min(0).max(720).default(24),
    REASONING_MAX_GENERATION_TRIES: z.coerce.number().int().min(1).max(6).default(3),
    /** Jaccard similarity (3-gram shingles) above which a generated item is too close to one the user has seen. */
    REASONING_SIMILARITY_THRESHOLD: z.coerce.number().min(0.05).max(1).default(0.35),
    /**
     * Shared question pool: questions are generated ahead of time per domain and difficulty and served
     * to learners in random order, never twice to the same learner. Demand-driven: a bucket served in
     * the last REASONING_POOL_DEMAND_DAYS is kept at REASONING_POOL_TARGET questions, any other bucket
     * at REASONING_POOL_IDLE_TARGET. When an active learner has fewer than REASONING_POOL_MIN_AVAILABLE
     * unseen, the schedule grows that bucket up to REASONING_POOL_MAX_ITEMS. REASONING_POOL_BATCH are
     * generated at a time in parallel, within REASONING_POOL_DAILY_CAP_USD. Off by default outside
     * production (unset = NODE_ENV === 'production'); when off, the schedule is removed and refills are no-ops.
     */
    REASONING_POOL_ENABLED: bool.optional(),
    REASONING_POOL_TARGET: z.coerce.number().int().min(0).max(500).default(12),
    REASONING_POOL_IDLE_TARGET: z.coerce.number().int().min(0).max(500).default(2),
    REASONING_POOL_DEMAND_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** Hard ceiling per bucket for schedule top-ups past the target on behalf of active learners. At or below the target: no top-ups. */
    REASONING_POOL_MAX_ITEMS: z.coerce.number().int().min(0).max(2000).default(40),
    REASONING_POOL_MIN_AVAILABLE: z.coerce.number().int().min(0).max(50).default(4),
    REASONING_POOL_BATCH: z.coerce.number().int().min(1).max(10).default(4),
    REASONING_POOL_DAILY_CAP_USD: z.coerce.number().positive().default(5),

    REPORT_PDF_ENABLED: bool.default(true),
    REPORT_EMAIL_ENABLED: bool.default(false),
    EMAIL_DRIVER: z.enum(['ses', 'log']).default('log'),
    SES_FROM_ADDRESS: z.string().optional(),

    SENTRY_DSN: z.string().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),
    RELEASE: z.string().optional(),
    CONTENT_DIR: z.string().optional(),
    /**
     * Demo hosting without S3 or Sentry (e.g. Render free). Uploaded files and PDFs then live on
     * the instance's disk and are lost on restart. Never for real users.
     */
    ALLOW_EPHEMERAL_STORAGE: bool.default(false),
    ALLOW_NO_SENTRY: bool.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.STORAGE_DRIVER !== 's3' && !env.ALLOW_EPHEMERAL_STORAGE) ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 'must be s3 in production (or set ALLOW_EPHEMERAL_STORAGE=true for a demo)' });
      if (env.LLM_DRIVER !== 'anthropic') ctx.addIssue({ code: 'custom', path: ['LLM_DRIVER'], message: 'must be anthropic in production' });
      if (!env.SENTRY_DSN && !env.ALLOW_NO_SENTRY) ctx.addIssue({ code: 'custom', path: ['SENTRY_DSN'], message: 'required in production (or set ALLOW_NO_SENTRY=true for a demo)' });
      if (!env.ONBOARD_URL.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['ONBOARD_URL'], message: 'must be https in production' });
      // The log driver records that a message would be sent and drops it: never for real report emails.
      if (env.REPORT_EMAIL_ENABLED && env.EMAIL_DRIVER === 'log') ctx.addIssue({ code: 'custom', path: ['EMAIL_DRIVER'], message: 'the log driver cannot send report emails in production (set EMAIL_DRIVER=ses or REPORT_EMAIL_ENABLED=false)' });
    }
    if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) ctx.addIssue({ code: 'custom', path: ['S3_BUCKET'], message: 'required for s3 storage' });
    if (env.STORAGE_DRIVER === 'fs' && !env.STORAGE_SIGNING_SECRET && !env.BETTER_AUTH_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['STORAGE_SIGNING_SECRET'], message: 'required for fs storage (or the legacy BETTER_AUTH_SECRET)' });
    }
    if (env.LLM_DRIVER === 'anthropic' && !env.ANTHROPIC_API_KEY) ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'required for the anthropic driver' });
    if (env.EMAIL_DRIVER === 'ses' && !env.SES_FROM_ADDRESS) ctx.addIssue({ code: 'custom', path: ['SES_FROM_ADDRESS'], message: 'required for SES' });
  });

export type AppConfig = Omit<z.infer<typeof EnvSchema>, 'REASONING_POOL_ENABLED'> & {
  /** Resolved: the explicit setting, else on in production only. */
  REASONING_POOL_ENABLED: boolean;
  pricing: Record<string, ModelPricing>;
  isProd: boolean;
  /** APP_ORIGIN plus ALLOWED_APP_ORIGINS, normalised to origins. */
  allowedOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  const pricing: Record<string, ModelPricing> = { ...MODEL_PRICING };
  if (cfg.LLM_PRICING_OVERRIDES) {
    const overrides = z
      .record(
        z.string(),
        z.object({
          inputPerMTok: z.number().positive(),
          outputPerMTok: z.number().positive(),
          cacheReadPerMTok: z.number().nonnegative(),
          cacheWritePerMTok: z.number().nonnegative(),
          supportsEffort: z.boolean().default(false),
          maxOutputTokens: z.number().int().positive().default(32_000),
        }),
      )
      .parse(JSON.parse(cfg.LLM_PRICING_OVERRIDES));
    Object.assign(pricing, overrides);
  }
  // An unverified model id is a configuration error, never a silent default (L15).
  for (const key of ['LLM_MODEL_SMALL', 'LLM_MODEL_LARGE', 'LLM_REFUSAL_FALLBACK_MODEL'] as const) {
    const model = cfg[key];
    if (model && !pricing[model]) {
      throw new Error(`Invalid configuration: ${key}=${model} is not in the verified model registry; add LLM_PRICING_OVERRIDES after verifying it`);
    }
  }
  const allowedOrigins = [...new Set([cfg.APP_ORIGIN, ...cfg.ALLOWED_APP_ORIGINS.split(',')].map((o) => o.trim()).filter(Boolean).map((o) => new URL(o).origin))];
  // The question pool spends on a schedule regardless of traffic: opt-in outside production (audit TR-10).
  const REASONING_POOL_ENABLED = cfg.REASONING_POOL_ENABLED ?? cfg.NODE_ENV === 'production';
  return { ...cfg, REASONING_POOL_ENABLED, pricing, isProd: cfg.NODE_ENV === 'production', allowedOrigins };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
