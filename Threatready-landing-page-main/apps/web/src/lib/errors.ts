/** Better Auth / API error → one clear sentence saying what to do next. */
const MESSAGES: Record<string, string> = {
  INVALID_USERNAME_OR_PASSWORD: "That username and password don't match. Check both and try again.",
  EMAIL_NOT_VERIFIED: "Verify your email to finish setting up your account.",
  INVALID_OTP: "That code isn't right. Check the latest email and try again.",
  OTP_EXPIRED: "That code has expired. Send a new one.",
  TOO_MANY_ATTEMPTS: "Too many wrong codes. Send a new one.",
  USERNAME_IS_ALREADY_TAKEN: "That username is taken. Try another.",
  USERNAME_TOO_SHORT: "Username must be at least 3 characters.",
  USERNAME_TOO_LONG: "Username must be at most 30 characters.",
  INVALID_USERNAME: "Use letters, numbers, dots and underscores only.",
  PASSWORD_TOO_SHORT: "Password must be at least 12 characters.",
  PASSWORD_TOO_LONG: "Password must be at most 128 characters.",
  MISSING_RESPONSE: "Complete the verification check, then try again.",
  MISSING_CAPTCHA: "Complete the verification check, then try again.",
  VERIFICATION_FAILED: "The verification check failed. Try it again.",
  CAPTCHA_FAILED: "The verification check failed. Try it again.",
  NETWORK: "Can't reach ThreatReady. Check your connection and try again.",
  ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY: "You're already browsing as a guest.",
};

/** Limits that answer 429, each with when to try again (the server's retryAfter). */
const LIMIT_MESSAGES: Record<string, (retryAfter: number | undefined) => string> = {
  RATE_LIMITED: (s) => `Too many attempts. ${retryPhrase(s)}`,
  ACCOUNT_LOCKED: (s) =>
    `Too many wrong passwords for this username, so sign-in is paused. ${retryPhrase(s, "You can try again")} To get in now, reset your password.`,
  OTP_EMAIL_LIMIT: (s) => `Several codes were already sent to this email. Use the most recent one. ${retryPhrase(s, "You can ask for a new code")}`,
};

/** OAuth errors come back on the URL as ?error=... */
export const OAUTH_MESSAGES: Record<string, string> = {
  account_not_linked:
    "An account with this email already exists. Sign in with your username and password first.",
  access_denied: "Sign-in was cancelled.",
  email_not_found: "Your provider didn't share a verified email. Add one there, or create an account here.",
};

export type ErrorLike = { code?: string; status?: number; message?: string; retryAfter?: number } | null | undefined;

/**
 * "Try again in 40 seconds" / "in 5 minutes" / "at 3:45 PM": the server's own wait (retryAfter
 * seconds, from the body or Retry-After), never a guess. A wait we don't know says "later".
 */
export function retryPhrase(retryAfterSeconds: number | undefined, lead = "Try again", now = new Date()): string {
  const s = Math.ceil(Number(retryAfterSeconds));
  if (!Number.isFinite(s) || s <= 0) return `${lead} later.`;
  if (s < 60) return `${lead} in ${s} second${s === 1 ? "" : "s"}.`;
  if (s < 15 * 60) {
    const m = Math.ceil(s / 60);
    return `${lead} in ${m} minute${m === 1 ? "" : "s"}.`;
  }
  const at = new Date(now.getTime() + s * 1000);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? `${lead} at ${time}.` : `${lead} tomorrow at ${time}.`;
}

export function messageFor(err: ErrorLike): string {
  if (!err) return "Something went wrong. Try again.";
  // The code before the status: a 429 can be a one-minute IP limit, an hour-long code cap or an account lock.
  const limit = (err.code && LIMIT_MESSAGES[err.code]) || (err.status === 429 ? LIMIT_MESSAGES.RATE_LIMITED : undefined);
  if (limit) return limit(err.retryAfter);
  if (err.code && MESSAGES[err.code]) return MESSAGES[err.code]!;
  return "Something went wrong. Try again.";
}
