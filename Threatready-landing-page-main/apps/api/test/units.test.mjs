/**
 * Unit checks for pure helpers, against dist (no database, no server):
 *   node --test test/units.test.mjs
 * CSV formula guard (TR-40), identity cookie relay (ONB-REG0), lockout schedule (TR-03), known-browser
 * tokens (SEC-2), the admin console's whole-UTC-day ranges (BIZ-09), provider-token stripping (TR-39),
 * the in-process window limiter (UI-8), the client IP rule, error reports (TR-14) and config bounds.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { dayBounds } from "../dist/admin/activity.queries.js";
import { parseRange } from "../dist/admin/admin.service.js";
import { cell } from "../dist/admin/csv.js";
import { withoutProviderTokens } from "../dist/auth/auth.js";
import { DEVICE_TOKEN_MAX_AGE_S, deviceIdFor, deviceSignInKey, issueDeviceToken, lockoutMs, signInKey } from "../dist/auth/limits.js";
import { ErrorReporter, initErrorReports, parseDsn, reportError } from "../dist/common/error-report.js";
import { CLIENT_IP, WindowLimiter, clientIp, stampClientIp } from "../dist/common/throttle.js";
import { loadConfig } from "../dist/config.js";
import { orgInviteEmail } from "../dist/email/templates.js";
import { orgNameSchema } from "@threatready/contracts";
import { relayedCookies } from "../dist/platform/platform.controller.js";

test("CSV: formula starts are neutralised, including after whitespace and in full-width forms", () => {
  const risky = ["=1+2", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", " =1+2", " =1+2", "　=1", "​=1", "＝1+2", "＋1", "－1", "＠SUM(A1)", ";=1+2", "−1"];
  for (const v of risky) assert.ok(cell(v).replace(/^"/, "").startsWith("'"), `not guarded: ${JSON.stringify(v)} -> ${cell(v)}`);
  for (const v of ["alice", "bob@example.com", "Asia/Kolkata", "12.50", "2026-10-23T10:00:00.000Z", "true", ""]) assert.equal(cell(v), v);
  assert.equal(cell('a "quoted", name'), '"a ""quoted"", name"');
  assert.equal(cell(null), "");
});

test("identity relay: drops re-minted session_data (and its chunks), keeps token refreshes and every expiry", () => {
  const name = "tr.session_data";
  const out = relayedCookies(
    [
      "tr.session_data=abc; Max-Age=60; Path=/; HttpOnly; SameSite=Lax",
      "tr.session_data.0=part; Max-Age=60; Path=/",
      "tr.session_token=new; Max-Age=604800; Path=/; HttpOnly",
      "tr.session_data=; Max-Age=0; Path=/",
      "tr.session_data.1=; Max-Age=0; Path=/",
      "tr.dont_remember=; Max-Age=0; Path=/",
      "tr.session_database=x; Max-Age=60; Path=/",
    ],
    name,
  );
  assert.deepEqual(out, [
    "tr.session_token=new; Max-Age=604800; Path=/; HttpOnly",
    "tr.session_data=; Max-Age=0; Path=/",
    "tr.session_data.1=; Max-Age=0; Path=/",
    "tr.dont_remember=; Max-Age=0; Path=/",
    "tr.session_database=x; Max-Age=60; Path=/",
  ]);
  assert.deepEqual(relayedCookies(["__Secure-tr.session_data=abc; Max-Age=60; Secure"], "__Secure-tr.session_data"), []);
});

test("lockout: 15 minutes, doubling per further run of five, at most a day; key is a hash of the normalised name", () => {
  const policy = { failures: 5, minutes: 15 };
  assert.equal(lockoutMs(5, policy), 15 * 60_000);
  assert.equal(lockoutMs(10, policy), 30 * 60_000);
  assert.equal(lockoutMs(15, policy), 60 * 60_000);
  assert.equal(lockoutMs(100, policy), 24 * 60 * 60_000);
  assert.equal(signInKey("  Alice "), signInKey("alice"));
  assert.ok(!signInKey("alice").includes("alice"));
});

test("known-browser tokens: only a genuine, unexpired token for the same name yields its device id", () => {
  const secret = "s".repeat(32);
  const now = Date.UTC(2026, 9, 25, 12);
  const token = issueDeviceToken(secret, "Alice", now);
  const id = deviceIdFor(secret, token, "  alice ", now);
  assert.match(id ?? "", /^[0-9a-f-]{36}$/, "the same name, however it is typed");
  assert.ok(!token.toLowerCase().includes("alice"), "the token never holds the name");
  assert.notEqual(issueDeviceToken(secret, "alice", now), token, "every sign-in issues a new device id");
  assert.equal(deviceIdFor(secret, token, "bob", now), null, "another name");
  assert.equal(deviceIdFor("t".repeat(32), token, "alice", now), null, "another secret");
  const [hash, dev, issued, mac] = token.split(".");
  const otherId = dev.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  assert.equal(deviceIdFor(secret, [hash, otherId, issued, mac].join("."), "alice", now), null, "a changed device id");
  assert.equal(deviceIdFor(secret, [hash, dev, (parseInt(issued, 36) + 86400).toString(36), mac].join("."), "alice", now), null, "a changed issue time");
  assert.equal(deviceIdFor(secret, `${token}x`, "alice", now), null, "a changed MAC");
  for (const bad of [null, undefined, "", "a.b.c", "a.b.c.d.e", "x".repeat(300)]) assert.equal(deviceIdFor(secret, bad, "alice", now), null, String(bad));
  assert.equal(deviceIdFor(secret, token, "alice", now + (DEVICE_TOKEN_MAX_AGE_S + 60) * 1000), null, "expired");
  assert.equal(deviceIdFor(secret, token, "alice", now + (DEVICE_TOKEN_MAX_AGE_S - 60) * 1000), id, "still valid just before it expires");
  assert.ok(deviceSignInKey(id).startsWith("signin-device:") && !deviceSignInKey(id).includes(id), "its own counter, keyed by a hash");
  assert.notEqual(deviceSignInKey(id), signInKey("alice"));
});

test("admin ranges cover whole UTC days, the same for time and for AI usage", () => {
  const r = parseRange({ from: "2026-10-18T10:30:00.000Z", to: "2026-10-25T10:30:00.000Z" });
  assert.deepEqual([r.from.toISOString(), r.to.toISOString()], ["2026-10-18T00:00:00.000Z", "2026-10-26T00:00:00.000Z"]);
  assert.deepEqual(dayBounds(r), { from: "2026-10-18", to: "2026-10-25" }, "the activity days are the days of [from, to)");
  const midnight = parseRange({ from: "2026-10-18T00:00:00.000Z", to: "2026-10-25T00:00:00.000Z" });
  assert.equal(midnight.to.toISOString(), "2026-10-25T00:00:00.000Z", "a range ending at midnight stays");
  assert.deepEqual(dayBounds(midnight), { from: "2026-10-18", to: "2026-10-24" });
  const offset = parseRange({ from: "2026-10-18T03:00:00+05:30", to: "2026-10-18T04:00:00+05:30" });
  assert.deepEqual([offset.from.toISOString(), offset.to.toISOString()], ["2026-10-17T00:00:00.000Z", "2026-10-18T00:00:00.000Z"], "UTC days, whatever the offset");
  assert.deepEqual(dayBounds({ from: new Date("2026-10-18T10:00:00Z"), to: new Date("2026-10-19T15:00:00Z") }), { from: "2026-10-18", to: "2026-10-19" });
  assert.throws(() => parseRange({ from: "2026-10-25T10:00:00.000Z", to: "2026-10-25T09:00:00.000Z" }), /before/);
});

test("OAuth accounts never keep provider tokens; credential accounts are untouched", () => {
  const google = withoutProviderTokens({ providerId: "google", accountId: "1", accessToken: "a", refreshToken: "r", idToken: "i", scope: "email" });
  assert.deepEqual(google, { providerId: "google", accountId: "1", accessToken: null, refreshToken: null, idToken: null, scope: "email" });
  // An update carries no providerId: any token field present is cleared, nothing is added.
  assert.deepEqual(withoutProviderTokens({ accessToken: "a", accessTokenExpiresAt: 1 }), { accessToken: null, accessTokenExpiresAt: 1 });
  assert.deepEqual(withoutProviderTokens({ password: "hash" }), { password: "hash" });
  const credential = { providerId: "credential", password: "hash" };
  assert.equal(withoutProviderTokens(credential), credential);
});

test("window limiter: per key, resets after the window, 0 turns it off", () => {
  const l = new WindowLimiter(2, 60_000);
  assert.equal(l.hit("u1", 0), 0);
  assert.equal(l.hit("u1", 1), 0);
  assert.equal(l.hit("u1", 2), 60);
  assert.equal(l.hit("u2", 2), 0, "another key has its own budget");
  assert.equal(l.hit("u1", 60_000), 0, "new window");
  const off = new WindowLimiter(0, 60_000);
  for (let i = 0; i < 100; i++) assert.equal(off.hit("x", i), 0);
});

test("client IP: a proxy header only when configured; otherwise the TCP peer, whatever the client sends", () => {
  const req = (headers, remoteAddress = "::ffff:192.0.2.10") => ({ headers: { ...headers }, socket: { remoteAddress } });
  const spoofed = { "x-forwarded-for": "198.51.100.1", [CLIENT_IP]: "198.51.100.2" };

  const direct = req(spoofed);
  stampClientIp(direct, undefined);
  assert.equal(clientIp(direct), "192.0.2.10", "no trusted proxy: the socket, never a header");

  const viaGateway = req({ ...spoofed, "x-threatready-client-ip": "203.0.113.7" }, "127.0.0.1");
  stampClientIp(viaGateway, "x-threatready-client-ip");
  assert.equal(clientIp(viaGateway), "203.0.113.7");

  const viaDevProxy = req({ "x-forwarded-for": "198.51.100.9, 127.0.0.1" }, "127.0.0.1");
  stampClientIp(viaDevProxy, "x-forwarded-for");
  assert.equal(clientIp(viaDevProxy), "198.51.100.9");

  const proxyHeaderMissing = req({ [CLIENT_IP]: "198.51.100.2" }, "192.0.2.20");
  stampClientIp(proxyHeaderMissing, "x-threatready-client-ip");
  assert.equal(clientIp(proxyHeaderMissing), "192.0.2.20", "a client-sent value under our own name is overwritten");
});

test("error reports: a Sentry envelope with the error and route only, deduplicated and budgeted", async () => {
  assert.equal(parseDsn("not a dsn"), null);
  assert.equal(parseDsn("https://o1.ingest.sentry.io/123"), null, "no public key");
  const target = parseDsn("https://pubkey@o1.ingest.sentry.io/prefix/4507");
  assert.equal(target.url, "https://o1.ingest.sentry.io/prefix/api/4507/envelope/");
  assert.match(target.auth, /sentry_key=pubkey/);

  const sent = [];
  const quiet = { warn() {} };
  const r = new ErrorReporter(target, { environment: "test", release: "abc123" }, async (url, init) => sent.push({ url, init }), quiet);
  await r.report(new TypeError("boom"), "GET /api/me", 1_000);
  assert.equal(sent.length, 1);
  const [header, item, event] = sent[0].init.body.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(header.event_id, event.event_id);
  assert.deepEqual(item, { type: "event" });
  assert.equal(sent[0].init.headers["x-sentry-auth"], target.auth);
  assert.deepEqual(
    { env: event.environment, release: event.release, route: event.tags.route, type: event.exception.values[0].type, value: event.exception.values[0].value },
    { env: "test", release: "abc123", route: "GET /api/me", type: "TypeError", value: "boom" },
  );
  assert.ok(event.exception.values[0].stacktrace.frames.length > 0);
  assert.ok(!("request" in event) && !("user" in event), "no request data or user");

  await r.report(new TypeError("boom"), "GET /api/me", 2_000);
  assert.equal(sent.length, 1, "the same error and route once a minute");
  for (let i = 0; i < 40; i++) await r.report(new Error(`e${i}`), "", 3_000 + i);
  assert.equal(sent.length, 30, "at most 30 events every ten minutes");
  await r.report(new Error("later"), "", 1_000 + 10 * 60_000);
  assert.equal(sent.length, 31, "a new budget after ten minutes");

  // A failing sender never throws; reports are off without a DSN or with a malformed one.
  await new ErrorReporter(target, { environment: "test" }, async () => { throw new Error("offline"); }, quiet).report(new Error("x"));
  assert.equal(initErrorReports({ environment: "test" }).enabled, false);
  assert.equal(initErrorReports({ dsn: "https://nokey.example/1", environment: "test" }).enabled, false);
  await reportError(new Error("nothing is sent"));
});

test("config: 0 turns limits off; the retention timer cannot overflow", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "http://localhost:5173",
    WEB_ORIGIN: "http://localhost:5173",
    INTERNAL_API_TOKEN: "y".repeat(32),
  };
  const c = loadConfig({ ...base, SIGNIN_LOCKOUT_FAILURES: "0", OTP_ISSUE_PER_IP_PER_HOUR: "0", ACTIVITY_PING_PER_IP_PER_MINUTE: "0", RETENTION_INTERVAL_HOURS: "0" });
  assert.deepEqual([c.SIGNIN_LOCKOUT_FAILURES, c.OTP_ISSUE_PER_IP_PER_HOUR, c.ACTIVITY_PING_PER_IP_PER_MINUTE, c.RETENTION_INTERVAL_HOURS], [0, 0, 0, 0]);
  assert.equal(c.AUTH_GET_SESSION_PER_IP_PER_MINUTE, 0, "the session read is exempt from the per-IP limiter by default");
  assert.equal(loadConfig({ ...base, RETENTION_INTERVAL_HOURS: "576" }).RETENTION_INTERVAL_HOURS, 576);
  assert.throws(() => loadConfig({ ...base, RETENTION_INTERVAL_HOURS: "720" }), /RETENTION_INTERVAL_HOURS/);
});

test("invitation emails: no organisation name or inviter a mail client would turn into a link", () => {
  for (const bad of ["paypal.com/verify", "Acme secure-login.example.com", "login.example.co", "Visit 10.0.0.1 now", "Node.js Guild"]) {
    assert.equal(orgNameSchema.safeParse(bad).success, false, bad);
  }
  for (const ok of ["Northwind Logistics", "St. Mary's College", "Acme Inc.", "R&D / Security", "A.B. Consulting (Pune)", "Café Olé", "Team 4.0"]) {
    assert.equal(orgNameSchema.safeParse(ok).success, true, ok);
  }
  // Defence in depth: a name stored before the rule, and a username with dots, stay out of the email.
  const mail = orgInviteEmail("a@x.io", "paypal.com/verify", "login.example.com", "member", "https://threatready.example/invite/t", 7);
  for (const part of [mail.subject, mail.text, mail.html]) assert.ok(!part.includes("paypal.com") && !part.includes("example.com"), part);
  assert.match(mail.text, /^You've been invited to join an organisation on ThreatReady as a member\./);
  const fine = orgInviteEmail("a@x.io", "Northwind", "priya_k", "manager", "https://threatready.example/invite/t", 7);
  assert.match(fine.text, /^priya_k has invited you to join Northwind on ThreatReady as a manager/);
  assert.equal(fine.subject, "You're invited to join Northwind on ThreatReady");
});
