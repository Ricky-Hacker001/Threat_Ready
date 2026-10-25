/**
 * What a learner reads when a request is refused (lib/errors.ts). Node strips the TypeScript types:
 *   node --test apps/web/test/errors.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { messageFor, retryPhrase } from "../src/lib/errors.ts";

test("the code decides before the status: an hour-long code cap is not 'wait a minute'", () => {
  const otp = messageFor({ status: 429, code: "OTP_EMAIL_LIMIT", retryAfter: 3600 });
  assert.match(otp, /^Several codes were already sent to this email\. Use the most recent one\. You can ask for a new code (at|tomorrow at) /);
  assert.doesNotMatch(otp, /minute/);
  const locked = messageFor({ status: 429, code: "ACCOUNT_LOCKED", retryAfter: 900 });
  assert.match(locked, /sign-in is paused\. You can try again (at|tomorrow at) .+\. To get in now, reset your password\.$/);
});

test("a plain 429 says when, from the server's retryAfter", () => {
  assert.equal(messageFor({ status: 429, retryAfter: 42 }), "Too many attempts. Try again in 42 seconds.");
  assert.equal(messageFor({ status: 429, code: "RATE_LIMITED", retryAfter: 300 }), "Too many attempts. Try again in 5 minutes.");
  assert.equal(messageFor({ status: 429 }), "Too many attempts. Try again later.");
  // Better Auth's own limiter body has no code: the status still maps to the limit message.
  assert.equal(messageFor({ status: 429, message: "Too many requests. Please try again later.", retryAfter: 1 }), "Too many attempts. Try again in 1 second.");
});

test("other errors keep their sentence; unknown ones stay generic", () => {
  assert.equal(messageFor({ status: 401, code: "INVALID_USERNAME_OR_PASSWORD" }), "That username and password don't match. Check both and try again.");
  assert.equal(messageFor({ status: 500, code: "SOMETHING_NEW" }), "Something went wrong. Try again.");
  assert.equal(messageFor(null), "Something went wrong. Try again.");
});

test("retryPhrase: seconds, minutes, then a clock time (same day or tomorrow)", () => {
  const now = new Date(2026, 9, 23, 10, 0, 0);
  assert.equal(retryPhrase(59, "Try again", now), "Try again in 59 seconds.");
  assert.equal(retryPhrase(61, "Try again", now), "Try again in 2 minutes.");
  assert.match(retryPhrase(3600, "Try again", now), /^Try again at 11:00/);
  assert.match(retryPhrase(20 * 3600, "Try again", now), /^Try again tomorrow at 6:00/);
  assert.equal(retryPhrase(undefined), "Try again later.");
});
