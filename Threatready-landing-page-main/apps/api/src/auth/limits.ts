import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import type { Db } from "../db/db.js";
import { rateLimits } from "../db/schema.js";

/*
 * Abuse limits that Better Auth's per-IP rate limiter cannot express: codes per email address and
 * failed sign-ins per username. Both are keyed by a hash, so neither table holds an address or a
 * username, and both answer the same way whether or not an account exists. Browsers that have signed
 * in to an account before (device tokens, at the end) are not held back by what strangers did.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** A submitted username normalised the way the username plugin stores it, then hashed. */
const nameHash = (username: string) => sha256(username.trim().toLowerCase());

/** 429 with the platform shape: a stable code, one sentence, and when to retry (body and Retry-After). */
export function tooManyRequests(code: string, message: string, retryAfterSeconds: number): APIError {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
  return new APIError("TOO_MANY_REQUESTS", { code, message, retryAfter }, { "Retry-After": String(retryAfter) });
}

/* ---------------- Verification and reset codes per address ---------------- */

export const OTP_ISSUE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Fixed one-hour window per key, stored in Better Auth's rate_limits table (shared across instances,
 * survives restarts; Better Auth prunes rows once its longest window, also an hour, has passed).
 * Returns the number of requests in the current window including this one, and when it ends.
 */
async function countInWindow(db: Db, key: string, now: number): Promise<{ count: number; resetAt: number }> {
  const windowStart = now - OTP_ISSUE_WINDOW_MS;
  const [row] = await db
    .insert(rateLimits)
    .values({ id: randomUUID(), key, count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.lastRequest} < ${windowStart} then 1 else ${rateLimits.count} + 1 end`,
        lastRequest: sql`case when ${rateLimits.lastRequest} < ${windowStart} then ${now} else ${rateLimits.lastRequest} end`,
      },
    })
    .returning({ count: rateLimits.count, lastRequest: rateLimits.lastRequest });
  return { count: row?.count ?? 1, resetAt: (row?.lastRequest ?? now) + OTP_ISSUE_WINDOW_MS };
}

/**
 * Cap on codes sent to one address. The hard cap is per (address, client IP): codes a stranger asks
 * for from their own network do not use up the owner's. The looser cap per address alone stops one
 * inbox being flooded from many networks, but strangers on several networks can use it up for the
 * hour, so a browser that has signed in to the account before (`knownBrowser`, see device tokens
 * below) is not held to it. A request refused by the first cap does not count towards the second.
 * Throws 429 OTP_EMAIL_LIMIT when over either.
 */
export async function assertOtpIssueAllowed(
  db: Db,
  email: string,
  ip: string,
  limits: { perIp: number; perEmail: number },
  { now = Date.now(), knownBrowser }: { now?: number; knownBrowser?: () => Promise<boolean> } = {},
): Promise<void> {
  const address = sha256(email);
  const refuse = (resetAt: number) =>
    tooManyRequests(
      "OTP_EMAIL_LIMIT",
      "Several codes were already sent to this email. Use the most recent one, or ask for a new code later.",
      (resetAt - now) / 1000,
    );
  if (limits.perIp > 0) {
    const fromHere = await countInWindow(db, `otp-issue:${address}:${sha256(ip)}`, now);
    if (fromHere.count > limits.perIp) throw refuse(fromHere.resetAt);
  }
  if (limits.perEmail > 0) {
    const all = await countInWindow(db, `otp-issue:${address}`, now);
    if (all.count > limits.perEmail && !(await knownBrowser?.())) throw refuse(all.resetAt);
  }
}

/* ---------------- Failed sign-ins per username ---------------- */

const LOCK_MAX_MS = 24 * 60 * 60 * 1000;

export interface LockoutPolicy {
  /** Failures that start a lock; 0 = lockout off. */
  failures: number;
  /** First lock length; each further run of `failures` doubles it, up to a day. */
  minutes: number;
}

/** Row key for a submitted username: normalised the way the username plugin stores it, then hashed. */
export const signInKey = (username: string) => `signin:${nameHash(username)}`;

/** Lock length after `failures` failures: the first run locks for `minutes`, each further run doubles it, at most a day. */
export function lockoutMs(failures: number, policy: LockoutPolicy): number {
  const run = Math.max(1, Math.floor(failures / Math.max(1, policy.failures)));
  return Math.min(LOCK_MAX_MS, policy.minutes * 60_000 * 2 ** (run - 1));
}

/** A sign-in attempt counted before its password is checked (reserveSignInAttempt). */
export interface SignInAttempt {
  /** The lock this attempt started (ms), 0 if none. */
  lockedMs: number;
  /** Whether that lock is the first of this run of failures (the owner is emailed once, not on every lock). */
  firstLock: boolean;
}

/**
 * Counts one sign-in attempt for the username BEFORE the password is checked, under a row lock, so
 * parallel attempts are counted one at a time and the threshold holds under concurrency: the attempt
 * that reaches a multiple of the threshold starts the lock, and every later one is refused until it
 * ends. Returns { wait } (seconds) when the name is locked; otherwise the attempt stands as a failure
 * until releaseSignInAttempt gives it back or clearSignInFailures forgets the run (one that ends in a
 * server error is never settled and stays counted: the lockout fails closed).
 * Failures are forgotten a day after the last failure or the end of the last lock, whichever is
 * later, so a day-long lock does not reset the escalation. Database time throughout, so instances agree.
 */
export async function reserveSignInAttempt(
  db: Db,
  key: string,
  policy: LockoutPolicy,
): Promise<{ wait: number } | { wait: 0; attempt: SignInAttempt }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into signin_failures (key, failures, last_failure_at) values (${key}, 0, now()) on conflict (key) do nothing`);
    const { rows } = await tx.execute<{ failures: number; wait: number | null; stale: boolean }>(sql`
      select failures,
        ceil(extract(epoch from locked_until - now()))::int as wait,
        greatest(last_failure_at, coalesce(locked_until, last_failure_at)) < now() - interval '1 day' as stale
      from signin_failures where key = ${key} for update`);
    const row = rows[0];
    if (row?.wait && row.wait > 0) return { wait: row.wait };
    const failures = (row && !row.stale ? row.failures : 0) + 1;
    const lockedMs = failures % policy.failures === 0 ? lockoutMs(failures, policy) : 0;
    await tx.execute(sql`
      update signin_failures set failures = ${failures}, last_failure_at = now()
        ${lockedMs > 0 ? sql`, locked_until = now() + make_interval(secs => ${lockedMs / 1000})` : sql``}
      where key = ${key}`);
    return { wait: 0, attempt: { lockedMs, firstLock: lockedMs > 0 && failures === policy.failures } };
  });
}

/**
 * Gives back an attempt that was no password guess (a malformed request, or the right password for
 * an email not yet verified), with the lock it started, if any.
 */
export async function releaseSignInAttempt(db: Db, key: string, attempt: SignInAttempt): Promise<void> {
  await db.execute(sql`
    update signin_failures set failures = greatest(failures - 1, 0)
      ${attempt.lockedMs > 0 ? sql`, locked_until = null` : sql``}
    where key = ${key}`);
}

/** A successful sign-in or password reset ends the lock and forgets earlier failures. */
export async function clearSignInFailures(db: Db, key: string): Promise<void> {
  await db.execute(sql`delete from signin_failures where key = ${key}`);
}

/* ---------------- Known browsers (device tokens) ---------------- */

/*
 * The lock above is per username, so anyone who knows a username can lock its password sign-in. A
 * browser that has signed in to that username before is exempt (OWASP "device cookies"): a successful
 * sign-in leaves an HttpOnly cookie with a token naming the username (its hash), a random device id
 * and when it was issued, MACed with the auth secret. With it, an attempt is counted against the
 * device id instead of the username, so strangers' guesses never lock the owner's own browsers out,
 * and a device that guesses wrong is locked on its own (then it counts as a stranger again). The token
 * lets nobody in: it only chooses the counter, and the password is still checked.
 */

/** Cookie name (Better Auth adds its prefix) and lifetime; each successful sign-in issues a fresh token. */
export const DEVICE_COOKIE = "signin_device";
export const DEVICE_TOKEN_MAX_AGE_S = 180 * 24 * 60 * 60;

const deviceMac = (secret: string, body: string) => createHmac("sha256", secret).update(`signin-device:${body}`).digest("base64url");

/** A fresh token for a browser that just signed in to `username`. */
export function issueDeviceToken(secret: string, username: string, now = Date.now()): string {
  const body = `${nameHash(username)}.${randomUUID()}.${Math.floor(now / 1000).toString(36)}`;
  return `${body}.${deviceMac(secret, body)}`;
}

/** The device id of a genuine, unexpired token for `username`; null for anything else. */
export function deviceIdFor(secret: string, token: string | null | undefined, username: string, now = Date.now()): string | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [hash, id, issued, mac] = parts as [string, string, string, string];
  const expected = Buffer.from(deviceMac(secret, `${hash}.${id}.${issued}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const age = now / 1000 - parseInt(issued, 36);
  if (!(age >= -300 && age <= DEVICE_TOKEN_MAX_AGE_S)) return null;
  return hash === nameHash(username) ? id : null;
}

/** signin_failures row of one known browser: the same schedule as a username, its own count. */
export const deviceSignInKey = (deviceId: string) => `signin-device:${sha256(deviceId)}`;
