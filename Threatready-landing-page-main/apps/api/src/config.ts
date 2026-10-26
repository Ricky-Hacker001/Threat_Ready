import { APP_KEYS, type AppInfo, type AppKey } from "@threatready/contracts";
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    BETTER_AUTH_URL: z.string().url(),
    WEB_ORIGIN: z.string().url(),
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
    TURNSTILE_SITE_KEY: optional,
    TURNSTILE_SECRET_KEY: optional,
    /** Test hook: point siteverify at a stub. Never set in production. */
    TURNSTILE_VERIFY_URL: optional,
    EMAIL_DRIVER: z.enum(["log", "ses", "resend"]).default("log"),
    /** Resend API key (EMAIL_DRIVER=resend). */
    RESEND_API_KEY: optional,
    /**
     * Free/demo hosting without Cloudflare Turnstile. Sign-up then relies on rate
     * limits alone; set Turnstile keys before real launch.
     */
    ALLOW_NO_CAPTCHA: z.enum(["true", "false"]).default("false"),
    EMAIL_FROM: z.string().min(3).default("ThreatReady <no-reply@threatready.io>"),
    AWS_REGION: z.string().default("ap-south-1"),
    /**
     * Header a trusted proxy sets to the client's IP (x-threatready-client-ip behind the gateway,
     * cf-connecting-ip behind Cloudflare → ALB). Unset: the TCP peer is the client, and no
     * client-supplied header is believed.
     */
    CLIENT_IP_HEADER: optional,
    /** Test hook: raise auth rate limits so e2e suites can run many sign-ups. */
    RATE_LIMIT_MULTIPLIER: z.coerce.number().positive().default(1),
    /**
     * Guest sessions ("Continue as a guest", /sign-in/anonymous). Off by default: every app still
     * refuses trial identities, so a guest can only look around onboard (TR-30, product decision).
     */
    TRIAL_ENABLED: z.enum(["true", "false"]).default("false"),
    /**
     * Per-account lockout: this many failed sign-ins for one username lock it for
     * SIGNIN_LOCKOUT_MINUTES, doubling with each further run of failures (at most a day). 0 turns it off.
     */
    SIGNIN_LOCKOUT_FAILURES: z.coerce.number().int().min(0).default(5),
    SIGNIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
    /** Verification/reset codes per email address and hour: from one client IP, and from all clients. 0 turns a cap off. */
    OTP_ISSUE_PER_IP_PER_HOUR: z.coerce.number().int().min(0).default(5),
    OTP_ISSUE_PER_EMAIL_PER_HOUR: z.coerce.number().int().min(0).default(20),
    /**
     * Activity pings per signed-in user and minute, and a per-IP backstop for everyone behind one
     * address (a classroom NAT). 0 turns a limit off.
     */
    ACTIVITY_PING_PER_USER_PER_MINUTE: z.coerce.number().int().min(0).default(20),
    ACTIVITY_PING_PER_IP_PER_MINUTE: z.coerce.number().int().min(0).default(600),
    /**
     * Per-IP backstop on the session read (/api/auth/get-session) that every onboard page makes.
     * 0 (the default) exempts it from the per-IP limiter: everyone behind one classroom NAT shares a bucket.
     */
    AUTH_GET_SESSION_PER_IP_PER_MINUTE: z.coerce.number().int().min(0).default(0),
    /**
     * Clean-up of expired sessions, codes, stale guests and never-verified sign-ups. 0 hours turns the
     * job off. At most 24 days: a longer timer would overflow and fire continuously.
     */
    RETENTION_INTERVAL_HOURS: z.coerce.number().min(0).max(24 * 24, "RETENTION_INTERVAL_HOURS must be at most 576 (24 days)").default(24),
    RETENTION_UNVERIFIED_DAYS: z.coerce.number().int().min(1).default(30),
    RETENTION_GUEST_DAYS: z.coerce.number().int().min(1).default(7),
    /**
     * Error tracking (common/error-report.ts): server errors are sent to this Sentry project DSN.
     * Optional everywhere, and a malformed value only logs a warning: without it errors are only in the logs.
     */
    SENTRY_DSN: optional,
    SENTRY_ENVIRONMENT: optional,
    /** Build identifier attached to error reports (the launcher passes the git commit). */
    RELEASE: optional,

    /*
     * Platform. Onboard is the identity provider for every subdomain app.
     * COOKIE_DOMAIN ("threatready.io") shares the session cookie across
     * *.threatready.io. Leave empty locally: localhost cookies already ignore
     * the port, so :5173, :5174 and :5175 share them.
     */
    COOKIE_DOMAIN: optional,
    /** Shared secret the apps send on /api/internal/* and onboard sends on theirs (the fallback when the per-caller tokens below are unset). */
    INTERNAL_API_TOKEN: z.string().min(32, "INTERNAL_API_TOKEN must be at least 32 characters"),
    /**
     * Per-caller internal tokens (deploy/start.mjs derives them; see deploy/README.md). Accepted on
     * /api/internal/*: a comma-separated list, one token per calling app. Presented to each app's
     * /internal/v1/*: one token per target. All optional: without them INTERNAL_API_TOKEN is used both ways.
     */
    INTERNAL_TOKENS_ACCEPT: optional,
    INTERNAL_TOKEN_TO_INTERVIEW: optional,
    INTERNAL_TOKEN_TO_LABS: optional,
    INTERNAL_TOKEN_TO_AR: optional,
    /** Also accept the raw INTERNAL_API_TOKEN next to INTERNAL_TOKENS_ACCEPT. Default: false in production, true otherwise. */
    INTERNAL_TOKEN_LEGACY_ACCEPT: z.enum(["true", "false"]).optional(),
    /** Comma-separated verified emails that are platform admins (in addition to users.role = 'admin'). */
    ADMIN_EMAILS: optional,
    /** Public origins the browser is sent to. */
    INTERVIEW_APP_URL: z.string().url().default("http://localhost:5174"),
    LABS_APP_URL: z.string().url().default("http://localhost:5175"),
    REASONING_APP_URL: z.string().url().default("http://localhost:5176"),
    /** Server-to-server base URLs (in-VPC). Default to the public origins. */
    INTERVIEW_INTERNAL_URL: optional,
    LABS_INTERNAL_URL: optional,
    REASONING_INTERNAL_URL: optional,
    /** "live" once an app ships; "soon" shows it as coming soon and makes no calls to it. */
    INTERVIEW_STATUS: z.enum(["live", "soon"]).default("live"),
    LABS_STATUS: z.enum(["live", "soon"]).default("live"),
    REASONING_STATUS: z.enum(["live", "soon"]).default("soon"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (env.EMAIL_DRIVER === "log") fail("EMAIL_DRIVER must be 'ses' or 'resend' in production");
    if (env.EMAIL_DRIVER === "resend" && !env.RESEND_API_KEY) fail("RESEND_API_KEY is required for EMAIL_DRIVER=resend");
    if ((!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) && env.ALLOW_NO_CAPTCHA !== "true") {
      fail("Turnstile keys are required in production (or set ALLOW_NO_CAPTCHA=true for a demo deployment)");
    }
    if (env.TURNSTILE_VERIFY_URL) fail("TURNSTILE_VERIFY_URL must not be set in production");
    if (env.RATE_LIMIT_MULTIPLIER !== 1) fail("RATE_LIMIT_MULTIPLIER must be 1 in production");
    if (!env.BETTER_AUTH_URL.startsWith("https://")) fail("BETTER_AUTH_URL must be https in production");
    // Subdomain deployment (onboard., interviewprep., …) needs a shared cookie domain. A single-origin
    // deployment (every app on one host under its own path) shares the host-only cookie already.
    const origins = new Set(
      [env.WEB_ORIGIN, env.INTERVIEW_APP_URL, env.LABS_APP_URL, env.REASONING_APP_URL].map((u) => new URL(u).origin),
    );
    if (origins.size > 1 && !env.COOKIE_DOMAIN) fail("COOKIE_DOMAIN is required in production when apps are on different hosts (e.g. threatready.io)");
    for (const k of ["INTERVIEW_APP_URL", "LABS_APP_URL", "REASONING_APP_URL"] as const) {
      if (!env[k].startsWith("https://")) fail(`${k} must be https in production`);
    }
  });

/** An app this platform links to, with where onboard reaches it server-side. */
export type RegisteredApp = AppInfo & { internalUrl: string };

export type Config = z.infer<typeof envSchema> & {
  apps: Record<AppKey, RegisteredApp>;
  /** Bearer tokens /api/internal/* accepts (per-caller tokens, plus the raw token when legacy acceptance is on). */
  internalTokensAccept: readonly string[];
  /** Bearer token onboard presents to each app's /internal/v1/*. */
  internalTokenTo: Record<AppKey, string>;
  /** Origins allowed as ?next= targets and as Better Auth trusted origins */
  appOrigins: string[];
  /** Guest sessions offered (TRIAL_ENABLED) */
  trialEnabled: boolean;
  adminEmails: Set<string>;
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
  turnstile?: { siteKey: string; secretKey: string; verifyUrl?: string };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  const origin = (u: string) => new URL(u).origin;
  // An app URL may include its base path (https://host/labs/). Normalise to a trailing slash so
  // relative paths resolve inside it; origins alone are used for trust and ?next= checks.
  const base = (u: string) => (u.endsWith("/") ? u : `${u}/`);
  // Product names as threatready.io uses them; every app's header and card shows these.
  const apps: Record<AppKey, RegisteredApp> = {
    interview: {
      key: "interview",
      title: "InterviewPrep",
      url: base(c.INTERVIEW_APP_URL),
      status: c.INTERVIEW_STATUS,
      internalUrl: (c.INTERVIEW_INTERNAL_URL ?? c.INTERVIEW_APP_URL).replace(/\/+$/, ""),
    },
    labs: {
      key: "labs",
      title: "Lab Simulations",
      url: base(c.LABS_APP_URL),
      status: c.LABS_STATUS,
      internalUrl: (c.LABS_INTERNAL_URL ?? c.LABS_APP_URL).replace(/\/+$/, ""),
    },
    reasoning: {
      key: "reasoning",
      title: "Attack Reasoning Lab",
      url: base(c.REASONING_APP_URL),
      status: c.REASONING_STATUS,
      internalUrl: (c.REASONING_INTERNAL_URL ?? c.REASONING_APP_URL).replace(/\/+$/, ""),
    },
  };
  const appOrigins = [...new Set([origin(c.WEB_ORIGIN), ...APP_KEYS.map((k) => origin(apps[k].url))])];
  const legacyAccept = c.INTERNAL_TOKEN_LEGACY_ACCEPT ? c.INTERNAL_TOKEN_LEGACY_ACCEPT === "true" : c.NODE_ENV !== "production";
  const perCaller = (c.INTERNAL_TOKENS_ACCEPT ?? "").split(",").map((t) => t.trim()).filter((t) => t.length >= 32);
  const internalTokensAccept = perCaller.length === 0 || legacyAccept ? [...new Set([...perCaller, c.INTERNAL_API_TOKEN])] : perCaller;
  return {
    ...c,
    apps,
    appOrigins,
    trialEnabled: c.TRIAL_ENABLED === "true",
    internalTokensAccept,
    internalTokenTo: {
      interview: c.INTERNAL_TOKEN_TO_INTERVIEW ?? c.INTERNAL_API_TOKEN,
      labs: c.INTERNAL_TOKEN_TO_LABS ?? c.INTERNAL_API_TOKEN,
      reasoning: c.INTERNAL_TOKEN_TO_AR ?? c.INTERNAL_API_TOKEN,
    },
    adminEmails: new Set(
      (c.ADMIN_EMAILS ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
    google:
      c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET
        ? { clientId: c.GOOGLE_CLIENT_ID, clientSecret: c.GOOGLE_CLIENT_SECRET }
        : undefined,
    github:
      c.GITHUB_CLIENT_ID && c.GITHUB_CLIENT_SECRET
        ? { clientId: c.GITHUB_CLIENT_ID, clientSecret: c.GITHUB_CLIENT_SECRET }
        : undefined,
    turnstile:
      c.TURNSTILE_SITE_KEY && c.TURNSTILE_SECRET_KEY
        ? { siteKey: c.TURNSTILE_SITE_KEY, secretKey: c.TURNSTILE_SECRET_KEY, verifyUrl: c.TURNSTILE_VERIFY_URL }
        : undefined,
  };
}

export const CONFIG = Symbol("CONFIG");
