import { Logger } from "@nestjs/common";
import { OTP_LENGTH, OTP_TTL_SECONDS, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from "@threatready/contracts";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous, captcha, emailOTP, username } from "better-auth/plugins";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { authSchema } from "../db/schema.js";
import { dispatch, type EmailPort } from "../email/email.port.js";
import { existingAccountEmail, otpEmail } from "../email/templates.js";
import { ensurePersonalWorkspace } from "../tenancy/tenancy.js";

export const AUTH = Symbol("AUTH");

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
];

/** Endpoints protected by Turnstile when it is configured. */
export const CAPTCHA_ENDPOINTS = [
  "/sign-up/email",
  "/sign-in/username",
  "/sign-in/anonymous",
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
];

export function createAuth(config: Config, db: Db, email: EmailPort) {
  const logger = new Logger("Auth");
  const loginUrl = `${config.WEB_ORIGIN}/`;
  const m = config.RATE_LIMIT_MULTIPLIER;
  const rule = (window: number, max: number) => ({ window, max: Math.ceil(max * m) });

  const options = {
    appName: "ThreatReady",
    baseURL: config.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    // Every app subdomain may send users here with ?next= and start OAuth from here.
    trustedOrigins: config.appOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    disabledPaths: DISABLED_PATHS,
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
      // GitHub: Better Auth requests user:email and uses the primary verified address.
      ...(config.github ? { github: { ...config.github } } : {}),
    },

    account: {
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
      // to 5 minutes. Routes that must see revocation immediately pass
      // disableCookieCache (see AuthGuard).
      cookieCache: { enabled: true, maxAge: 5 * 60 },
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
        "/is-username-available": rule(60, 20),
      },
    },

    advanced: {
      cookiePrefix: "tr",
      ipAddress: { ipAddressHeaders: [config.CLIENT_IP_HEADER] },
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
      // One sign-in for onboard.*, interviewprep.*, labs.* and ar.* (cookie Domain=threatready.io).
      ...(config.COOKIE_DOMAIN ? { crossSubDomainCookies: { enabled: true, domain: config.COOKIE_DOMAIN } } : {}),
    },

    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const isTrial = (user as { isAnonymous?: boolean | null }).isAnonymous === true;
            await ensurePersonalWorkspace(db, user.id, isTrial ? "trial" : "learner");
          },
        },
      },
    },

    plugins: [
      username({ minUsernameLength: USERNAME_MIN, maxUsernameLength: USERNAME_MAX }),
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
