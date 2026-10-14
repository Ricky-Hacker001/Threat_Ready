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
    EMAIL_DRIVER: z.enum(["log", "ses"]).default("log"),
    EMAIL_FROM: z.string().min(3).default("ThreatReady <no-reply@threatready.io>"),
    AWS_REGION: z.string().default("ap-south-1"),
    CLIENT_IP_HEADER: z.string().default("x-forwarded-for"),
    /** Test hook: raise auth rate limits so e2e suites can run many sign-ups. */
    RATE_LIMIT_MULTIPLIER: z.coerce.number().positive().default(1),

    /*
     * Platform. Onboard is the identity provider for every subdomain app.
     * COOKIE_DOMAIN ("threatready.io") shares the session cookie across
     * *.threatready.io. Leave empty locally: localhost cookies already ignore
     * the port, so :5173, :5174 and :5175 share them.
     */
    COOKIE_DOMAIN: optional,
    /** Shared secret the apps send on /api/internal/* and onboard sends on theirs. */
    INTERNAL_API_TOKEN: z.string().min(32, "INTERNAL_API_TOKEN must be at least 32 characters"),
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
    if (env.EMAIL_DRIVER !== "ses") fail("EMAIL_DRIVER must be 'ses' in production");
    if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) fail("Turnstile keys are required in production");
    if (env.TURNSTILE_VERIFY_URL) fail("TURNSTILE_VERIFY_URL must not be set in production");
    if (env.RATE_LIMIT_MULTIPLIER !== 1) fail("RATE_LIMIT_MULTIPLIER must be 1 in production");
    if (!env.BETTER_AUTH_URL.startsWith("https://")) fail("BETTER_AUTH_URL must be https in production");
    if (!env.COOKIE_DOMAIN) fail("COOKIE_DOMAIN is required in production (e.g. threatready.io)");
    for (const k of ["INTERVIEW_APP_URL", "LABS_APP_URL", "REASONING_APP_URL"] as const) {
      if (!env[k].startsWith("https://")) fail(`${k} must be https in production`);
    }
  });

/** An app this platform links to, with where onboard reaches it server-side. */
export type RegisteredApp = AppInfo & { internalUrl: string };

export type Config = z.infer<typeof envSchema> & {
  apps: Record<AppKey, RegisteredApp>;
  /** Origins allowed as ?next= targets and as Better Auth trusted origins */
  appOrigins: string[];
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
  // Product names as threatready.io uses them; every app's header and card shows these.
  const apps: Record<AppKey, RegisteredApp> = {
    interview: {
      key: "interview",
      title: "InterviewPrep",
      url: origin(c.INTERVIEW_APP_URL),
      status: c.INTERVIEW_STATUS,
      internalUrl: (c.INTERVIEW_INTERNAL_URL ?? c.INTERVIEW_APP_URL).replace(/\/+$/, ""),
    },
    labs: {
      key: "labs",
      title: "Lab Simulations",
      url: origin(c.LABS_APP_URL),
      status: c.LABS_STATUS,
      internalUrl: (c.LABS_INTERNAL_URL ?? c.LABS_APP_URL).replace(/\/+$/, ""),
    },
    reasoning: {
      key: "reasoning",
      title: "Attack Reasoning Lab",
      url: origin(c.REASONING_APP_URL),
      status: c.REASONING_STATUS,
      internalUrl: (c.REASONING_INTERNAL_URL ?? c.REASONING_APP_URL).replace(/\/+$/, ""),
    },
  };
  const appOrigins = [...new Set([origin(c.WEB_ORIGIN), ...APP_KEYS.map((k) => apps[k].url)])];
  return {
    ...c,
    apps,
    appOrigins,
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
