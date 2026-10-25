/**
 * Return targets and activity time zones (src/platform.ts), against dist:
 *   node --test packages/contracts/test/platform.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityPingSchema, safeNext } from "../dist/index.js";

const ORIGINS = ["https://threatready.example"];
// One host serves onboard and every app (the Render deployment): homes, not the origin, are the allow-list.
const PREFIXES = ["https://threatready.example/interview-prep", "https://threatready.example/labs/", "https://threatready.example/ar/", "https://threatready.example/app"];

test("safeNext with prefixes: only app homes and onboard's /app on a shared origin", () => {
  for (const ok of ["/interview-prep", "/interview-prep/sessions/1?x=1", "/labs/", "/labs", "/labs/redteam/", "/ar/domains/cloud", "/app", "/app/profile"]) {
    assert.ok(safeNext(`https://threatready.example${ok}`, ORIGINS, PREFIXES), ok);
  }
  for (const bad of ["/signout", "/signout?next=/app", "/api/auth/sign-out", "/api/dev/mailbox", "/", "/?mode=signup", "/archive", "/application", "/interview-prepx", "/labs/../signout"]) {
    assert.equal(safeNext(`https://threatready.example${bad}`, ORIGINS, PREFIXES), null, bad);
  }
  assert.equal(safeNext("https://evil.example/interview-prep", ORIGINS, PREFIXES), null);
  assert.equal(safeNext("javascript:alert(1)", ORIGINS, PREFIXES), null);
  assert.equal(safeNext("/interview-prep", ORIGINS, PREFIXES), null, "relative targets are refused");
});

test("safeNext without prefixes keeps the origin-only check", () => {
  assert.equal(safeNext("https://threatready.example/anything", ORIGINS), "https://threatready.example/anything");
  assert.equal(safeNext("https://other.example/", ORIGINS), null);
});

test("activity time zone: real IANA names only", () => {
  assert.equal(activityPingSchema.safeParse({ app: "home", timeZone: "Asia/Kolkata" }).success, true);
  assert.equal(activityPingSchema.safeParse({ app: "home", timeZone: "UTC" }).success, true);
  assert.equal(activityPingSchema.safeParse({ app: "home", timeZone: "" }).success, true);
  assert.equal(activityPingSchema.safeParse({ app: "home", timeZone: "Mars/Olympus_Mons" }).success, false);
});
