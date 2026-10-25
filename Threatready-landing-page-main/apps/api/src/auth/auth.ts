import { Logger } from "@nestjs/common";
import { OTP_LENGTH, OTP_TTL_SECONDS, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from "@threatready/contracts";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getIP, isAPIError } from "better-auth/api";
import { anonymous, captcha, emailOTP, username } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { reportError } from "../common/error-report.js";
import { CLIENT_IP } from "../common/throttle.js";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { authSchema, users } from "../db/schema.js";
import { dispatch, type EmailPort } from "../email/email.port.js";
import { existingAccountEmail, otpEmail, signInLockedEmail } from "../email/templates.js";
import { ensurePersonalWorkspace } from "../tenancy/tenancy.js";
import {
  assertOtpIssueAllowed,
  clearSignInFailures,
  DEVICE_COOKIE,
  DEVICE_TOKEN_MAX_AGE_S,
  deviceIdFor,
  deviceSignInKey,
  issueDeviceToken,
  releaseSignInAttempt,
  reserveSignInAttempt,
  signInKey,
  tooManyRequests,
  type LockoutPolicy,
  type SignInAttempt,
} from "./limits.js";

export const AUTH = Symbol("AUTH");

/** A counted sign-in attempt on its way to the after hook: which counter it used, and whether that was a known browser's. */
interface PendingSignIn extends SignInAttempt {
  key: string;
  knownBrowser: boolean;
}

/**
 * The known-browser cookie (limits.ts): read by the auth API only, so scoped to its path, host-only
 * even when the session cookie spans subdomains, and never sent on a cross-site request.
 */
const DEVICE_COOKIE_ATTRIBUTES = { maxAge: DEVICE_TOKEN_MAX_AGE_S, path: "/api/auth", sameSite: "strict", domain: undefined } as const;

/** Paths this product does not offer. Disabled so they are not attack surface. */
const DISABLED_PATHS = [
  "/sign-in/email", // login is username + password (spec §2)
  "/sign-in/email-otp", // OTP is for verification and recovery, not passwordless login
  "/forget-password/email-otp", // deprecated alias of /email-otp/request-password-reset
  "/request-password-reset", // link-based reset; we use OTP reset
  "/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/change-email",
  "/update-user", // no profile editing in this release
  // Provider tokens are not stored (account hooks below), so nothing could be served from these.
  "/get-access-token",
  "/refresh-token",
  "/account-info",
  // Unused by the sign-up page (sign-up itself answers for a taken name, at 5 an hour per IP): it
  // only listed usernames for anyone, 20 a minute, and a username is what the sign-in lock is keyed on.
  "/is-username-available",
];

/** Endpoints protected by Turnstile when it is configured. */
export const CAPTCHA_ENDPOINTS = [
  "/sign-up/email",
  "/sign-in/username",
  "/sign-in/anonymous",
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
];

/** Endpoints that email a code to the address in the body; capped per address, not just per IP (limits.ts). */
const OTP_ISSUE_PATHS = ["/email-otp/send-verification-otp", "/email-otp/request-password-reset"];

/**
 * OAuth providers: only the verified email and profile are used, so their tokens are never kept.
 * Applied to creates and updates; an update carries no providerId, and only OAuth updates carry
 * token fields (a credential account has none), so any token field present is cleared.
 */
const TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;
export function withoutProviderTokens<T extends Record<string, unknown>>(account: T): T {
  if (account.providerId === "credential") return account;
  const out: Record<string, unknown> = { ...account };
  for (const f of TOKEN_FIELDS) if (f in out) out[f] = null;
  return out as T;
}

export function createAuth(config: Config, db: Db, email: EmailPort) {
  const logger = new Logger("Auth");
  const loginUrl = `${config.WEB_ORIGIN}/`;
  const m = config.RATE_LIMIT_MULTIPLIER;
  const rule = (window: number, max: number) => ({ window, max: Math.ceil(max * m) });
  // Per address, so not scaled by RATE_LIMIT_MULTIPLIER: test suites use a fresh address per test.
  const otpLimits = { perIp: config.OTP_ISSUE_PER_IP_PER_HOUR, perEmail: config.OTP_ISSUE_PER_EMAIL_PER_HOUR };
  const lockout: LockoutPolicy = { failures: config.SIGNIN_LOCKOUT_FAILURES, minutes: config.SIGNIN_LOCKOUT_MINUTES };

  /** The owner of a locked username hears about it once; nobody else learns whether it exists. */
  async function notifyLocked(name: string, lockedMs: number): Promise<void> {
    const [owner] = await db
      .select({ email: users.email, verified: users.emailVerified, anonymous: users.isAnonymous })
      .from(users)
      .where(eq(users.username, name.trim().toLowerCase()))
      .limit(1);
    if (owner?.verified && !owner.anonymous) dispatch(email, signInLockedEmail(owner.email, Math.round(lockedMs / 60_000), loginUrl), logger);
  }

  /** Whether the request's device token is one this address's account issued (looked up only when it matters). */
  async function knownBrowserFor(token: string | null, address: string): Promise<boolean> {
    if (!token) return false;
    const [owner] = await db.select({ username: users.username }).from(users).where(eq(users.email, address)).limit(1);
    return !!owner?.username && deviceIdFor(config.BETTER_AUTH_SECRET, token, owner.username) !== null;
  }

  const options = {
    appName: "ThreatReady",
    baseURL: config.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    // Every app subdomain may send users here with ?next= and start OAuth from here.
    trustedOrigins: config.appOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    // Guest sessions only when offered (TRIAL_ENABLED); existing guests can still leave (delete-anonymous-user).
    disabledPaths: config.trialEnabled ? DISABLED_PATHS : [...DISABLED_PATHS, "/sign-in/anonymous"],
    telemetry: { enabled: false },

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      revokeSessionsOnPasswordReset: true,
      // Duplicate email at sign-up gets the same response as a new one (no
      // enumeration); the real owner is told by email instead.
      onExistingUserSignUp: async ({ user }) => {
        dispatch(email, existingAccountEmail(user.email, loginUrl), logger);
      },
    },

    emailVerification: {
      // Signing in with the right password but an unverified email re-sends the OTP.
      sendOnSignIn: true,
      // Spec §2: verify, then sign in with username and password.
      autoSignInAfterVerification: false,
    },

    user: {
      additionalFields: {
        // Platform role. Never settable from a request; granted by scripts/grant-admin or ADMIN_EMAILS.
        role: { type: "string", required: false, defaultValue: "user", input: false },
      },
    },

    socialProviders: {
      ...(config.google ? { google: { ...config.google, prompt: "select_account" as const } } : {}),
      // GitHub: Better Auth requests user:email and uses the public (else the primary) address; it only
      // records whether GitHub verified it, so such a user can be email_verified = false (retention.ts).
      ...(config.github ? { github: { ...config.github } } : {}),
    },

    account: {
      // Provider tokens are dropped before they are stored (databaseHooks.account); encryption stays on
      // as defence in depth should a token ever be kept (XChaCha20-Poly1305 with the auth secret).
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // No trustedProviders: implicit linking happens only when the IdP
        // asserts a verified email AND (1.7.7 default) the local account's email
        // is already verified. That closes the pre-registration hijack (ADD L6)
        // without the custom "delete password" rule.
        allowDifferentEmails: false,
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // seven-day sliding expiry (ADD L6)
      updateAge: 60 * 60 * 24,
      // Signed cookie cache: avoids a DB lookup per request; revocation lags up
      // to one minute. Routes that must see revocation immediately pass
      // disableCookieCache (see AuthGuard and the admin console).
      cookieCache: { enabled: true, maxAge: 60 },
    },

    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: Math.ceil(100 * m),
      customRules: {
        "/sign-in/username": rule(60, 5),
        "/sign-up/email": rule(60 * 60, 5),
        "/sign-in/anonymous": rule(60 * 60, 3),
        "/sign-in/social": rule(60, 10),
        "/email-otp/send-verification-otp": rule(60, 3),
        "/email-otp/request-password-reset": rule(5 * 60, 3),
        "/email-otp/verify-email": rule(60, 10),
        "/email-otp/check-verification-otp": rule(60, 10),
        "/email-otp/reset-password": rule(60, 5),
        // The session read every onboard page makes: cookie-cached and cheap, while this database-backed
        // limiter costs two queries per hit, and its count only resets after a full window with no
        // request at all, so a busy classroom NAT would be blocked for everyone. Exempt by default;
        // AUTH_GET_SESSION_PER_IP_PER_MINUTE sets a per-IP backstop (0 = exempt).
        "/get-session": config.AUTH_GET_SESSION_PER_IP_PER_MINUTE > 0 ? rule(60, config.AUTH_GET_SESSION_PER_IP_PER_MINUTE) : false,
      },
    },

    advanced: {
      cookiePrefix: "tr",
      // Set by the API itself from the trusted proxy header or the TCP peer (main.ts, common/throttle.ts).
      ipAddress: { ipAddressHeaders: [CLIENT_IP] },
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
      // One sign-in for onboard.*, interviewprep.*, labs.* and ar.* (cookie Domain=threatready.io).
      ...(config.COOKIE_DOMAIN ? { crossSubDomainCookies: { enabled: true, domain: config.COOKIE_DOMAIN } } : {}),
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Per-address cap for verification and reset codes (the rateLimit rules above are per IP alone):
        // a 6-digit code with 3 tries must not be re-requestable without limit (limits.ts).
        if (OTP_ISSUE_PATHS.includes(ctx.path)) {
          const body = ctx.body as { email?: unknown } | undefined;
          const to = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
          if (!to) return;
          const ip = (ctx.headers && getIP(ctx.headers, ctx.context.options)) || "unknown";
          const token = ctx.getCookie(ctx.context.createAuthCookie(DEVICE_COOKIE).name);
          await assertOtpIssueAllowed(db, to, ip, otpLimits, { knownBrowser: () => knownBrowserFor(token, to) });
          return;
        }
        // Per-account lockout, for any submitted username, so a locked name answers exactly like an
        // unknown one. The attempt is counted here, before the password is checked (limits.ts), so
        // parallel guesses cannot all slip past the threshold; the after hook settles it.
        if (ctx.path === "/sign-in/username" && lockout.failures > 0) {
          const name = (ctx.body as { username?: unknown } | undefined)?.username;
          if (typeof name !== "string" || !name.trim()) return;
          // A browser that signed in to this name before is counted on its own (known browsers, limits.ts):
          // strangers' guesses do not lock it out. Once it is locked itself, it counts as a stranger.
          const device = deviceIdFor(config.BETTER_AUTH_SECRET, ctx.getCookie(ctx.context.createAuthCookie(DEVICE_COOKIE).name), name);
          if (device) {
            const own = await reserveSignInAttempt(db, deviceSignInKey(device), lockout);
            if ("attempt" in own) return { context: { signInAttempt: { ...own.attempt, key: deviceSignInKey(device), knownBrowser: true } satisfies PendingSignIn } };
          }
          const reserved = await reserveSignInAttempt(db, signInKey(name), lockout);
          if (!("attempt" in reserved)) {
            throw tooManyRequests("ACCOUNT_LOCKED", "Too many wrong passwords for this username. Try again later, or reset your password.", reserved.wait);
          }
          // Handed to the after hook through the request context (merged into the endpoint's ctx).
          return { context: { signInAttempt: { ...reserved.attempt, key: signInKey(name), knownBrowser: false } satisfies PendingSignIn } };
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (ctx.path === "/sign-in/username") {
          const name = (ctx.body as { username?: unknown } | undefined)?.username;
          if (typeof name !== "string") return;
          if (ctx.context.newSession) {
            // This browser now knows the password for the name: from here on it is a known browser.
            const cookie = ctx.context.createAuthCookie(DEVICE_COOKIE, DEVICE_COOKIE_ATTRIBUTES);
            ctx.setCookie(cookie.name, issueDeviceToken(config.BETTER_AUTH_SECRET, name), cookie.attributes);
          }
          const attempt = (ctx as { signInAttempt?: PendingSignIn }).signInAttempt;
          if (lockout.failures <= 0 || !attempt) return;
          if (ctx.context.newSession) {
            // Forgets the run of the counter this attempt used. A known browser's success leaves the
            // name's count alone: those are strangers' guesses, and they keep their lock.
            await clearSignInFailures(db, attempt.key);
          } else if (isAPIError(returned) && returned.statusCode === 401) {
            // A wrong password (or an unknown name): the attempt stays counted. The owner hears about
            // locks of the name, not of one of their own browsers.
            if (attempt.firstLock && !attempt.knownBrowser) await notifyLocked(name, attempt.lockedMs);
          } else {
            await releaseSignInAttempt(db, attempt.key, attempt);
          }
          return;
        }
        if (lockout.failures <= 0) return;
        // Resetting the password by email proves ownership: lift the lock the email told them about.
        if (ctx.path === "/email-otp/reset-password" && !isAPIError(returned)) {
          const to = (ctx.body as { email?: unknown } | undefined)?.email;
          if (typeof to !== "string") return;
          const [owner] = await db
            .select({ username: users.username })
            .from(users)
            .where(eq(users.email, to.trim().toLowerCase()))
            .limit(1);
          if (owner?.username) await clearSignInFailures(db, signInKey(owner.username));
        }
      }),
    },

    databaseHooks: {
      user: {
        create: {
          // A username/password account is shown by its username: neither the sign-up body's free-text
          // `name` nor its `displayUsername` is trusted (both reached the admin console, the CSV
          // export, the apps and the forgot-username email). The username as typed is kept when it
          // differs only in case. OAuth users keep the provider's name; guests keep "Trial user".
          before: async (user) => {
            const u = user as { username?: string | null; displayUsername?: string | null; isAnonymous?: boolean | null };
            if (u.isAnonymous || !u.username) return;
            const shown = typeof u.displayUsername === "string" && u.displayUsername.toLowerCase() === u.username.toLowerCase() ? u.displayUsername : u.username;
            return { data: { ...user, name: shown, displayUsername: shown } };
          },
          after: async (user) => {
            const isTrial = (user as { isAnonymous?: boolean | null }).isAnonymous === true;
            await ensurePersonalWorkspace(db, user.id, isTrial ? "trial" : "learner");
          },
        },
      },
      account: {
        create: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
        update: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
      },
    },

    plugins: [
      username({
        minUsernameLength: USERNAME_MIN,
        maxUsernameLength: USERNAME_MAX,
        // The display form is the username itself (user.create.before): the same characters, any case.
        displayUsernameValidator: (d) => /^[A-Za-z0-9_.]+$/.test(d),
      }),
      emailOTP({
        otpLength: OTP_LENGTH,
        expiresIn: OTP_TTL_SECONDS,
        allowedAttempts: 3,
        storeOTP: "hashed",
        sendVerificationOnSignUp: true,
        overrideDefaultEmailVerification: true,
        disableSignUp: true,
        rateLimit: rule(60, 3),
        async sendVerificationOTP({ email: to, otp, type }) {
          dispatch(email, otpEmail(to, otp, type), logger);
        },
      }),
      anonymous({
        emailDomainName: "trial.threatready.invalid",
        generateName: () => "Trial user",
        // The trial user is deleted after linking; its launches cascade with it.
        // Carrying trial history into the new account is a worker job (TODO in README).
      }),
      ...(config.turnstile
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: config.turnstile.secretKey,
              endpoints: CAPTCHA_ENDPOINTS,
              ...(config.turnstile.verifyUrl ? { siteVerifyURLOverride: config.turnstile.verifyUrl } : {}),
            }),
          ]
        : []),
    ],
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The HTTP handler for /api/auth/*. Better Auth's own per-IP limiter answers 429 with a bare message
 * and X-Retry-After; every auth 429 leaves here in the platform shape instead: a stable code
 * (RATE_LIMITED unless a hook set a more specific one), one sentence, `retryAfter` seconds in the
 * body and a standard Retry-After header, so the sign-in page can say when to try again.
 */
export function authHttpHandler(auth: Auth): (request: Request) => Promise<Response> {
  return async (request) => {
    const res = await auth.handler(request);
    if (res.status >= 500) {
      // Better Auth has logged the cause; the report names the endpoint (its paths carry no ids).
      void reportError(new Error(`auth endpoint answered ${res.status}`), `${request.method} ${new URL(request.url).pathname}`);
    }
    if (res.status !== 429) return res;
    const body = ((await res
      .clone()
      .json()
      .catch(() => null)) ?? {}) as Record<string, unknown>;
    const retryAfter = Math.max(1, Number(res.headers.get("retry-after") ?? res.headers.get("x-retry-after") ?? body.retryAfter) || 60);
    const headers = new Headers(res.headers);
    headers.set("Retry-After", String(retryAfter));
    headers.set("Content-Type", "application/json");
    headers.delete("Content-Length");
    const shaped = {
      ...body,
      code: typeof body.code === "string" ? body.code : "RATE_LIMITED",
      message: typeof body.message === "string" ? body.message : "Too many requests. Try again later.",
      retryAfter,
    };
    return new Response(JSON.stringify(shaped), { status: 429, statusText: "Too Many Requests", headers });
  };
}
