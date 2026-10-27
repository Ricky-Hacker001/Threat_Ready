import { z } from 'zod';
import { estimateInterviewCost, MODEL_PRICING, type InterviewCostEstimate, type ModelPricing } from '../modules/ai/pricing.js';

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
    /**
     * Per-caller internal tokens (security patch 2, A9). The launcher derives one token per
     * caller->callee pair from INTERNAL_API_TOKEN with HKDF, so a token leaked from one app cannot be
     * replayed against another. INTERNAL_TOKENS_ACCEPT lists the tokens this API accepts (comma
     * separated); INTERNAL_TOKEN_TO_ONBOARD is the one it presents to onboard. Absent, everything
     * falls back to the raw INTERNAL_API_TOKEN (local development unchanged).
     */
    INTERNAL_TOKENS_ACCEPT: z.string().optional(),
    /**
     * The one per-caller token (onboard->interview) accepted on the routes only onboard calls: the
     * interview summary, AI usage and account erasure (/internal/v1/users/*, /internal/v1/ai-usage).
     * INTERNAL_TOKENS_ACCEPT also holds Attack Reasoning's token, which must open the reasoning routes
     * only (merge review M-SEC-1). Absent outside production, those routes accept INTERNAL_TOKENS_ACCEPT.
     */
    INTERNAL_TOKEN_FROM_ONBOARD: z.string().min(32).optional(),
    INTERNAL_TOKEN_TO_ONBOARD: z.string().min(32).optional(),
    /** Also accept the raw INTERNAL_API_TOKEN as a bearer. Default: false in production, true elsewhere. */
    INTERNAL_TOKEN_LEGACY_ACCEPT: bool.optional(),
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
    /**
     * The application asks for tiers; these map tiers to verified model ids (L15). SMALL has a
     * development default only: in production it must be set explicitly (the per-interview budget is
     * derived from its price, so a silent default would silently change what a learner can spend).
     */
    LLM_MODEL_SMALL: z.string().optional(),
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

    /**
     * AI budgets. Unset, each is derived from the configured models' prices and the interview cost
     * model (INTERVIEW_COST_MODEL in pricing.ts), so a model change moves the caps with the price
     * instead of leaving yesterday's dollar figures in place. An explicit value always wins.
     */
    AI_SESSION_CAP_USD: z.coerce.number().positive().optional(),
    AI_FINAL_SCORING_RESERVE_USD: z.coerce.number().nonnegative().optional(),
    AI_USER_DAILY_CAP_USD: z.coerce.number().positive().optional(),
    AI_GLOBAL_DAILY_CAP_USD: z.coerce.number().positive().optional(),
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
    /**
     * Pool questions one learner's starts and prefetches may have generated per UTC day (review AR-SEC-2:
     * counted in questions, not refill jobs, which each generated up to REASONING_POOL_BATCH); the schedule
     * refills the rest. 0 = no limit.
     */
    REASONING_USER_DAILY_REFILLS: z.coerce.number().int().min(0).default(12),
    /** Manual retries of a failed generation, and separately of a failed evaluation, per attempt. 0 = no ceiling. */
    REASONING_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(2),
    /** Hours an unanswered (ready) question stays open before the sweeper marks it skipped. 0 = never. */
    REASONING_READY_TTL_HOURS: z.coerce.number().int().min(0).max(720).default(24),
    /**
     * Model calls per generated question: try 1 on REASONING_GENERATION_FIRST_TIER, every later try on
     * LARGE (a question that fails the quality gate is rewritten once by the stronger model).
     */
    REASONING_MAX_GENERATION_TRIES: z.coerce.number().int().min(1).max(6).default(2),
    /** The tier that writes a question first: SMALL (Haiku, default) or LARGE (rollback: Sonnet writes every question). */
    REASONING_GENERATION_FIRST_TIER: z.enum(['SMALL', 'LARGE']).default('SMALL'),
    /**
     * Attack Reasoning's own SMALL model (the question writer's first try, the stage-1 evaluator).
     * claude-haiku-5-5 since the H55 measurement (27 Oct 2026): about US$0.060 per stored question
     * weighted by level, with a Sonnet rewrite on failure, against US$0.074 for the old Sonnet writer and
     * US$0.29 measured with Haiku 4.5. That figure rests on 1 passing rewrite in 4 (none of 2 at
     * intermediate): at that rate's 90% lower bound it is about US$0.125, still far below Sonnet writing
     * first. claude-haiku-4-5 puts it back on Haiku 4.5 (empty: LLM_MODEL_SMALL, but the Render launcher
     * drops empty values). Interviews always use LLM_MODEL_SMALL, so this never changes an interview's
     * model or the caps derived from its price.
     */
    REASONING_MODEL_SMALL: z.string().default('claude-haiku-5-5'),
    /**
     * Thinking depth (output_config.effort) of Attack Reasoning's SMALL calls: question writing and the
     * stage-1 evaluator. Sent only when the resolved SMALL model accepts it (Haiku 5.5; never Haiku 4.5).
     * Writing at low since H55: Haiku 5.5 passed the gate on 14 of 24 tries at US$0.0048 and 40 s each,
     * against 5 of 12 at US$0.0075 and 65 s at medium, where 4 tries ran out of output room. Grading
     * stays at medium, the effort the comparison with full mode was run at (low saves US$0.0004 an answer).
     */
    REASONING_SMALL_EFFORT_GENERATION: z.enum(['low', 'medium', 'high']).default('low'),
    REASONING_SMALL_EFFORT_EVALUATION: z.enum(['low', 'medium', 'high']).default('medium'),
    /** Questions per architecture compared with a new one (similarity bank on top of the live items). */
    REASONING_LIBRARY_BANK_SIZE: z.coerce.number().int().min(50).max(2000).default(300),
    /**
     * Days a retired question stays in that bank for text similarity (review AR-BIZ-2): by count alone, an
     * architecture whose recent questions all collide stops storing new ones and its window never moves.
     * Live questions and, on demand, the learner's own always stay in the bank.
     */
    REASONING_LIBRARY_BANK_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    /** Serve questions generated before the architecture library (architecture_id null) until they retire. */
    REASONING_SERVE_LEGACY_ITEMS: bool.default(true),
    /**
     * Questions a learner may open per UTC day (any state), so one learner cannot drain the shared pool.
     * 12 since the 27 Oct review (AR-SEC-2, AR-BIZ-8, COST-4; was 40, sized for US$0.02 a seat; at the
     * measured generation cost 40 opens could use up the whole pool cap). 0 = no limit.
     */
    REASONING_USER_DAILY_QUESTIONS: z.coerce.number().int().min(0).default(12),
    /** Jaccard similarity (3-gram shingles) above which a generated item is too close to one the user has seen. */
    REASONING_SIMILARITY_THRESHOLD: z.coerce.number().min(0.05).max(1).default(0.35),
    /**
     * Evaluation: `tiered` scores the option in code, grades the justification once on SMALL and runs the
     * LARGE challenger and reconciler only for borderline or disputed answers; `full` runs the three LARGE
     * stages on every answer. Full by default since H55 (27 Oct 2026): of 3 answers graded both ways, the
     * single Haiku 5.5 pass gave a reasoned wrong answer 24 where full mode gave 12, at high confidence, so
     * nothing escalated it, and it missed a must-not-credit claim Sonnet's first stage applied. Tiered
     * (about US$0.014 an answer against US$0.089) waits for a larger agreement check.
     */
    REASONING_EVALUATION_MODE: z.enum(['tiered', 'full']).default('full'),
    /** Centre and half-width of the provisional-score band that escalates a single-pass grade (band 0 = never on score alone). */
    REASONING_ESCALATION_CENTER: z.coerce.number().min(0).max(100).default(60),
    REASONING_ESCALATION_BAND: z.coerce.number().min(0).max(50).default(8),
    /**
     * Share (0-1) of tiered answers that no rule escalated which still get the second review, drawn at
     * random (review AR-SEC-1): text that talks the SMALL grader round without tripping a rule cannot
     * count on a single pass. 0 = off. About +US$0.008 per answer per 0.1 at the measured pair cost.
     */
    REASONING_ESCALATION_AUDIT_RATE: z.coerce.number().min(0).max(1).default(0.1),
    /**
     * Mark Attack Reasoning prompts for prompt caching. Off by default (review COST-2): each stage sends
     * its own structured-output format, which invalidates the cache, generation calls run in parallel on
     * different architectures and tiers, and a second learner's evaluation of an item rarely follows
     * within the 5-minute lifetime, so the real run wrote 71k tokens and read 4k (+US$0.024, 6% of spend).
     */
    REASONING_PROMPT_CACHE: bool.default(false),
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
    // Sized for the 2-serve rule (a live question offers at most 2 seats): see docs/ATTACK_REASONING_COST_DESIGN.md §5.3.
    REASONING_POOL_TARGET: z.coerce.number().int().min(0).max(500).default(8),
    REASONING_POOL_IDLE_TARGET: z.coerce.number().int().min(0).max(500).default(2),
    REASONING_POOL_DEMAND_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** Hard ceiling per bucket for schedule top-ups past the target on behalf of active learners. At or below the target: no top-ups. */
    REASONING_POOL_MAX_ITEMS: z.coerce.number().int().min(0).max(2000).default(24),
    REASONING_POOL_MIN_AVAILABLE: z.coerce.number().int().min(0).max(50).default(3),
    REASONING_POOL_BATCH: z.coerce.number().int().min(1).max(10).default(4),
    REASONING_POOL_DAILY_CAP_USD: z.coerce.number().positive().default(5),
    /**
     * A pool question is retired from serving after this many learners have seen it (answer-key exposure
     * bound). Enforced atomically where the serve is recorded (migration 0017), so concurrent starts never overshoot it.
     */
    REASONING_ITEM_MAX_SERVES: z.coerce.number().int().positive().default(2),

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
      if (!env.LLM_MODEL_SMALL) ctx.addIssue({ code: 'custom', path: ['LLM_MODEL_SMALL'], message: 'required in production (no default: the AI budget is derived from its price)' });
      if (!env.INTERNAL_TOKENS_ACCEPT && !env.INTERNAL_TOKEN_LEGACY_ACCEPT) {
        ctx.addIssue({ code: 'custom', path: ['INTERNAL_TOKENS_ACCEPT'], message: 'required in production unless INTERNAL_TOKEN_LEGACY_ACCEPT=true (the raw INTERNAL_API_TOKEN is not accepted by default)' });
      }
      if (!env.INTERNAL_TOKEN_FROM_ONBOARD && !env.INTERNAL_TOKEN_LEGACY_ACCEPT) {
        ctx.addIssue({ code: 'custom', path: ['INTERNAL_TOKEN_FROM_ONBOARD'], message: 'required in production unless INTERNAL_TOKEN_LEGACY_ACCEPT=true (account erasure and the summary must accept onboard\'s token only)' });
      }
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

type Env = z.infer<typeof EnvSchema>;
/** Values that are optional in the environment but always resolved in the loaded configuration. */
type Resolved =
  | 'LLM_MODEL_SMALL'
  | 'AI_SESSION_CAP_USD'
  | 'AI_FINAL_SCORING_RESERVE_USD'
  | 'AI_USER_DAILY_CAP_USD'
  | 'AI_GLOBAL_DAILY_CAP_USD'
  | 'REASONING_POOL_ENABLED';

export type AppConfig = Omit<Env, Resolved> & {
  LLM_MODEL_SMALL: string;
  AI_SESSION_CAP_USD: number;
  AI_FINAL_SCORING_RESERVE_USD: number;
  AI_USER_DAILY_CAP_USD: number;
  AI_GLOBAL_DAILY_CAP_USD: number;
  /** Resolved: the explicit setting, else on in production only. */
  REASONING_POOL_ENABLED: boolean;
  pricing: Record<string, ModelPricing>;
  isProd: boolean;
  /** APP_ORIGIN plus ALLOWED_APP_ORIGINS, normalised to origins. */
  allowedOrigins: string[];
  /** What one interview is expected to cost at the configured models (logged at boot; basis of the default caps). */
  interviewCostEstimate: InterviewCostEstimate;
  /** Bearer tokens accepted on /internal/v1/reasoning/* (per-caller tokens, plus the raw token when legacy acceptance is on). */
  internalTokensAccept: readonly string[];
  /**
   * Bearer tokens accepted on the routes only onboard calls (/internal/v1/users/*, /internal/v1/ai-usage):
   * INTERNAL_TOKEN_FROM_ONBOARD plus the raw token when legacy acceptance is on; internalTokensAccept when unset.
   */
  internalTokensFromOnboard: readonly string[];
  /** Bearer token this API presents to onboard. */
  internalTokenToOnboard: string;
};

/** Development default for the SMALL tier; production must set LLM_MODEL_SMALL explicitly. */
export const DEV_DEFAULT_MODEL_SMALL = 'claude-haiku-4-5';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const raw = parsed.data;
  // Production fails closed above; everywhere else the development default applies.
  const cfg = { ...raw, LLM_MODEL_SMALL: raw.LLM_MODEL_SMALL ?? DEV_DEFAULT_MODEL_SMALL };
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
          supportsEffort: z.boolean().optional(),
          maxOutputTokens: z.number().int().positive().optional(),
          adaptiveThinking: z.boolean().optional(),
          longContext: z
            .object({ aboveTokens: z.number().int().positive(), inputPerMTok: z.number().positive(), outputPerMTok: z.number().positive(), cacheReadPerMTok: z.number().nonnegative(), cacheWritePerMTok: z.number().nonnegative() })
            .optional(),
          charsPerToken: z.number().positive().optional(),
        }),
      )
      .parse(JSON.parse(cfg.LLM_PRICING_OVERRIDES));
    // An override of a registered id changes only the fields it names (review H55-SEC-3): replacing the
    // whole entry dropped Haiku 5.5's thinking, effort, tokenizer and long-context fields, so its SMALL
    // calls went out with Haiku 4.5's output room and no effort. A new id starts from no effort and 32k.
    for (const [id, o] of Object.entries(overrides)) pricing[id] = { supportsEffort: false, maxOutputTokens: 32_000, ...pricing[id], ...o };
  }
  // An unverified model id is a configuration error, never a silent default (L15).
  for (const key of ['LLM_MODEL_SMALL', 'LLM_MODEL_LARGE', 'LLM_REFUSAL_FALLBACK_MODEL', 'REASONING_MODEL_SMALL'] as const) {
    const model = cfg[key];
    if (model && !Object.hasOwn(pricing, model)) {
      throw new Error(`Invalid configuration: ${key}=${model} is not in the verified model registry; add LLM_PRICING_OVERRIDES after verifying it`);
    }
  }
  const allowedOrigins = [...new Set([cfg.APP_ORIGIN, ...cfg.ALLOWED_APP_ORIGINS.split(',')].map((o) => o.trim()).filter(Boolean).map((o) => new URL(o).origin))];
  const isProd = cfg.NODE_ENV === 'production';
  // The question pool spends on a schedule regardless of traffic: opt-in outside production (audit TR-10).
  const REASONING_POOL_ENABLED = cfg.REASONING_POOL_ENABLED ?? isProd;

  // Budget defaults from the price list: an unset cap is what the cost model says, never a stale dollar figure.
  const interviewCostEstimate = estimateInterviewCost(pricing[cfg.LLM_MODEL_SMALL]!, pricing[cfg.LLM_MODEL_LARGE]!);
  const budgets = {
    AI_SESSION_CAP_USD: cfg.AI_SESSION_CAP_USD ?? interviewCostEstimate.sessionCapUsd,
    AI_FINAL_SCORING_RESERVE_USD: cfg.AI_FINAL_SCORING_RESERVE_USD ?? interviewCostEstimate.finalizeUsd,
    AI_USER_DAILY_CAP_USD: cfg.AI_USER_DAILY_CAP_USD ?? interviewCostEstimate.userDailyCapUsd,
    AI_GLOBAL_DAILY_CAP_USD: cfg.AI_GLOBAL_DAILY_CAP_USD ?? interviewCostEstimate.globalDailyCapUsd,
  };

  // Per-caller internal tokens (A9). The raw token is accepted only when legacy acceptance is on:
  // default on outside production (local dev, tests) and off in production.
  const legacy = cfg.INTERNAL_TOKEN_LEGACY_ACCEPT ?? !isProd;
  const internalTokensAccept = [...new Set([...(cfg.INTERNAL_TOKENS_ACCEPT ?? '').split(',').map((t) => t.trim()).filter(Boolean), ...(legacy ? [cfg.INTERNAL_API_TOKEN] : [])])];
  if (internalTokensAccept.some((t) => t.length < 32)) throw new Error('Invalid configuration: INTERNAL_TOKENS_ACCEPT: every token must be at least 32 characters');
  if (!internalTokensAccept.length) throw new Error('Invalid configuration: INTERNAL_TOKENS_ACCEPT: no internal token would be accepted');
  // Onboard-only routes (erasure above all): onboard's token alone, never Attack Reasoning's (M-SEC-1).
  const internalTokensFromOnboard = cfg.INTERNAL_TOKEN_FROM_ONBOARD ? [...new Set([cfg.INTERNAL_TOKEN_FROM_ONBOARD, ...(legacy ? [cfg.INTERNAL_API_TOKEN] : [])])] : internalTokensAccept;

  return {
    ...cfg,
    ...budgets,
    REASONING_POOL_ENABLED,
    pricing,
    isProd,
    allowedOrigins,
    interviewCostEstimate,
    internalTokensAccept,
    internalTokensFromOnboard,
    internalTokenToOnboard: cfg.INTERNAL_TOKEN_TO_ONBOARD ?? cfg.INTERNAL_API_TOKEN,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
