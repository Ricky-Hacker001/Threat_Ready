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
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
  NETWORK: "Can't reach ThreatReady. Check your connection and try again.",
  ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY: "You're already in a trial session.",
};

/** OAuth errors come back on the URL as ?error=... */
export const OAUTH_MESSAGES: Record<string, string> = {
  account_not_linked:
    "An account with this email already exists. Sign in with your username and password first.",
  access_denied: "Sign-in was cancelled.",
  email_not_found: "Your provider didn't share a verified email. Add one there, or create an account here.",
};

export function messageFor(err: { code?: string; status?: number; message?: string } | null | undefined): string {
  if (!err) return "Something went wrong. Try again.";
  if (err.status === 429) return MESSAGES.RATE_LIMITED!;
  if (err.code && MESSAGES[err.code]) return MESSAGES[err.code]!;
  return "Something went wrong. Try again.";
}
