/**
 * End-to-end suite against a running API + PostgreSQL (no mocks).
 *
 *   pnpm --filter @threatready/api build
 *   API_URL=http://localhost:3000 pnpm --filter @threatready/api test:e2e
 * (API_URL defaults to http://localhost:$PORT from the same env file.)
 *
 * Requires EMAIL_DRIVER=log (reads OTPs from /api/dev/mailbox) and
 * RATE_LIMIT_MULTIPLIER >= 10 on the API under test. The guest-session tests
 * run when that API has TRIAL_ENABLED=true. Spawns a second API instance (no
 * guest sessions) with Turnstile enabled against a local siteverify stub, on
 * CAPTCHA_API_PORT / CAPTCHA_STUB_PORT (default 3101 / 3102). Tests that read
 * or seed rows need DATABASE_URL (the API's app role); the identity tests need
 * INTERNAL_API_TOKEN.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

// The API from the same env file as DATABASE_URL (PORT), unless API_URL names another.
const API = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const APP_DB = process.env.DATABASE_URL;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;
const PASSWORD = "correct-horse-battery-1";
const PUBLIC_CONFIG = await fetch(`${API}/api/public/config`)
  .then((r) => r.json())
  .catch(() => ({}));
const TRIAL = PUBLIC_CONFIG.trialEnabled === true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => randomBytes(4).toString("hex");
const fakeIp = () => `10.${randomInt(1, 254)}.${randomInt(1, 254)}.${randomInt(1, 254)}`;

/** Minimal browser: cookie jar, Origin header, one client IP. */
class Client {
  constructor(base = API, ip = fakeIp()) {
    this.base = base;
    this.ip = ip;
    this.cookies = new Map();
  }
  async req(method, path, body, extraHeaders = {}) {
    const headers = { origin: ORIGIN, "x-forwarded-for": this.ip, ...extraHeaders };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get = (p, h) => this.req("GET", p, undefined, h);
  post = (p, b = {}, h) => this.req("POST", p, b, h);
}

/** The apps' identity call: the browser's Cookie header plus the internal token. */
async function identity(cookie) {
  const res = await fetch(`${API}/api/internal/identity/session`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, cookie } });
  return { status: res.status, setCookies: res.headers.getSetCookie(), json: await res.json().catch(() => null) };
}

/** A query as the API's own least-privilege role (DATABASE_URL). */
async function appDb(fn) {
  const db = new pg.Client({ connectionString: APP_DB });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Every message the dev mailbox holds for one address. */
const inbox = async (to, base = API) => (await fetch(`${base}/api/dev/mailbox?to=${encodeURIComponent(to)}`)).json();

async function mailbox(to, kind, { base = API, wait = 3000 } = {}) {
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/dev/mailbox?to=${encodeURIComponent(to)}`);
    const msgs = await res.json();
    const hit = msgs.find((m) => m.kind === kind);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}
const otpOf = (msg) => msg.text.match(/Code: (\d{6})/)[1];

async function registerVerified(c = new Client(), { name, displayUsername } = {}) {
  const username = `u_${uid()}`;
  const email = `${username}@example.test`;
  const extra = displayUsername === undefined ? {} : { displayUsername: typeof displayUsername === "function" ? displayUsername(username) : displayUsername };
  const signUp = await c.post("/api/auth/sign-up/email", { email, password: PASSWORD, name: name ?? username, username, ...extra });
  assert.equal(signUp.status, 200, signUp.text);
  const mail = await mailbox(email, "otp:email-verification");
  assert.ok(mail, "verification OTP email");
  const v = await c.post("/api/auth/email-otp/verify-email", { email, otp: otpOf(mail) });
  assert.equal(v.status, 200, v.text);
  const s = await c.post("/api/auth/sign-in/username", { username, password: PASSWORD });
  assert.equal(s.status, 200, s.text);
  return { c, username, email };
}

describe("registration and email verification", () => {
  test("sign-up → OTP → verify → username login → /me", async () => {
    const c = new Client();
    const username = `u_${uid()}`;
    const email = `${username}@example.test`;

    const signUp = await c.post("/api/auth/sign-up/email", { email, password: PASSWORD, name: username, username });
    assert.equal(signUp.status, 200);
    assert.equal(signUp.json.token, null, "no session before verification");

    const early = await c.post("/api/auth/sign-in/username", { username, password: PASSWORD });
    assert.equal(early.status, 403);
    assert.equal(early.json.code, "EMAIL_NOT_VERIFIED");

    const mail = await mailbox(email, "otp:email-verification");
    const otp = otpOf(mail);
    const wrong = await c.post("/api/auth/email-otp/verify-email", { email, otp: otp === "000000" ? "111111" : "000000" });
    assert.equal(wrong.status, 400, "wrong OTP rejected");

    const ok = await c.post("/api/auth/email-otp/verify-email", { email, otp });
    assert.equal(ok.status, 200, ok.text);
    const reuse = await c.post("/api/auth/email-otp/verify-email", { email, otp });
    assert.equal(reuse.status, 400, "used OTP rejected");

    const login = await c.post("/api/auth/sign-in/username", { username, password: PASSWORD });
    assert.equal(login.status, 200, login.text);

    const me = await c.get("/api/me");
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.role, "learner");
    assert.equal(me.json.plan, "free");
    assert.equal(me.json.user.username, username);
    assert.deepEqual(me.json.features.map((f) => f.key), ["interview", "simulations", "reasoning"]);
  });

  test("duplicate email gets the same response and the owner is notified", async () => {
    const { email } = await registerVerified();
    const c = new Client();
    const dup = await c.post("/api/auth/sign-up/email", { email, password: PASSWORD, name: "x", username: `u_${uid()}` });
    assert.equal(dup.status, 200, dup.text);
    assert.equal(dup.json.token, null);
    assert.ok(await mailbox(email, "existing-account"), "owner told by email");
  });

  test("weak password and bad username rejected server-side", async () => {
    const c = new Client();
    const short = await c.post("/api/auth/sign-up/email", { email: `${uid()}@example.test`, password: "short", name: "x", username: `u_${uid()}` });
    assert.equal(short.status, 400);
    const bad = await c.post("/api/auth/sign-up/email", { email: `${uid()}@example.test`, password: PASSWORD, name: "x", username: "no spaces!" });
    assert.ok([400, 422].includes(bad.status), bad.text);
  });

  test("OTP locks after three wrong attempts", async () => {
    const c = new Client();
    const username = `u_${uid()}`;
    const email = `${username}@example.test`;
    await c.post("/api/auth/sign-up/email", { email, password: PASSWORD, name: username, username });
    const otp = otpOf(await mailbox(email, "otp:email-verification"));
    const wrongOtp = otp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) await c.post("/api/auth/email-otp/verify-email", { email, otp: wrongOtp });
    const real = await c.post("/api/auth/email-otp/verify-email", { email, otp });
    assert.notEqual(real.status, 200, "correct OTP refused after lockout");
  });
});

describe("login", () => {
  test("wrong password and unknown user give the same error", async () => {
    const { username } = await registerVerified();
    const c = new Client();
    const a = await c.post("/api/auth/sign-in/username", { username, password: "wrong-password-123" });
    const b = await c.post("/api/auth/sign-in/username", { username: `nobody_${uid()}`, password: "wrong-password-123" });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.json.code, b.json.code);
    assert.equal(a.json.message, b.json.message);
  });

  test("email+password and OTP sign-in paths are disabled", async () => {
    const c = new Client();
    const r1 = await c.post("/api/auth/sign-in/email", { email: "a@example.test", password: PASSWORD });
    const r2 = await c.post("/api/auth/sign-in/email-otp", { email: "a@example.test", otp: "123456" });
    assert.equal(r1.status, 404);
    assert.equal(r2.status, 404);
  });

  test("usernames cannot be listed through the availability check (the sign-in lock is keyed on them)", async () => {
    const { username } = await registerVerified();
    const r = await new Client().post("/api/auth/is-username-available", { username });
    assert.equal(r.status, 404, r.text);
  });

  test("sign-out ends the session", async () => {
    const { c } = await registerVerified();
    assert.equal((await c.post("/api/auth/sign-out")).status, 200);
    assert.equal((await c.get("/api/me")).status, 401);
  });

  test("login is rate limited per IP, with a code and when to retry", async () => {
    const c = new Client();
    const statuses = [];
    let limited = null;
    for (let i = 0; i < 60; i++) {
      const r = await c.post("/api/auth/sign-in/username", { username: `nobody_${uid()}`, password: "wrong-password-123" });
      statuses.push(r.status);
      if (r.status === 429) {
        limited = r;
        break;
      }
    }
    assert.ok(limited, `expected 429, got ${[...new Set(statuses)]}`);
    assert.equal(limited.json.code, "RATE_LIMITED");
    assert.ok(limited.json.retryAfter > 0, limited.text);
    assert.equal(limited.headers.get("retry-after"), String(limited.json.retryAfter));
  });
});

describe("forgot password", () => {
  test("unknown email: same success, no email sent", async () => {
    const email = `ghost_${uid()}@example.test`;
    const r = await new Client().post("/api/auth/email-otp/request-password-reset", { email });
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    assert.equal(await mailbox(email, "otp:forget-password", { wait: 600 }), null);
  });

  test("OTP check → reset → sessions revoked → new password works", async () => {
    const { c: oldSession, username, email } = await registerVerified();
    const c = new Client();
    assert.equal((await c.post("/api/auth/email-otp/request-password-reset", { email })).status, 200);
    const otp = otpOf(await mailbox(email, "otp:forget-password"));

    const check = await c.post("/api/auth/email-otp/check-verification-otp", { email, otp, type: "forget-password" });
    assert.equal(check.status, 200, check.text);

    const weak = await c.post("/api/auth/email-otp/reset-password", { email, otp, password: "short" });
    assert.equal(weak.status, 400, "weak new password rejected");

    const newPassword = "new-correct-horse-2";
    const reset = await c.post("/api/auth/email-otp/reset-password", { email, otp, password: newPassword });
    assert.equal(reset.status, 200, reset.text);

    const fresh = await oldSession.get("/api/auth/get-session?disableCookieCache=true");
    assert.equal(fresh.json, null, "old session revoked");

    const old = await new Client().post("/api/auth/sign-in/username", { username, password: PASSWORD });
    assert.equal(old.status, 401, "old password no longer works");
    const ok = await new Client().post("/api/auth/sign-in/username", { username, password: newPassword });
    assert.equal(ok.status, 200, ok.text);

    const replay = await c.post("/api/auth/email-otp/reset-password", { email, otp, password: "another-password-3" });
    assert.equal(replay.status, 400, "reset OTP is single-use");
  });
});

describe("forgot username", () => {
  test("registered and unknown emails get identical responses; only the inbox learns the username", async () => {
    const { username, email } = await registerVerified();
    const ghost = `ghost_${uid()}@example.test`;
    const a = await new Client().post("/api/account/forgot-username", { email });
    const b = await new Client().post("/api/account/forgot-username", { email: ghost });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal(a.text, b.text);
    assert.ok(!a.text.includes(username), "username never in the HTTP response");
    const mail = await mailbox(email, "username-reminder");
    assert.ok(mail?.text.includes(username));
    assert.equal(await mailbox(ghost, "username-reminder", { wait: 600 }), null);
  });

  test("invalid email is a validation error", async () => {
    const r = await new Client().post("/api/account/forgot-username", { email: "not-an-email" });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "VALIDATION_FAILED");
  });
});

describe("free trial (anonymous) and entitlements", { skip: !TRIAL && "the API under test has TRIAL_ENABLED=false" }, () => {
  test("trial session is capped per feature", async () => {
    const c = new Client();
    const s = await c.post("/api/auth/sign-in/anonymous");
    assert.equal(s.status, 200, s.text);
    const me = await c.get("/api/me");
    assert.equal(me.json.role, "trial");
    assert.equal(me.json.plan, "trial");
    assert.equal(me.json.user.email, null, "placeholder email never exposed");
    const interview = me.json.features.find((f) => f.key === "interview");
    assert.deepEqual(interview, { key: "interview", access: "trial", remaining: 1, limit: 1 });

    const first = await c.post("/api/features/interview/launch");
    assert.equal(first.status, 201, first.text);
    assert.equal(first.json.route, "/app/interview");
    assert.equal(first.json.state.access, "exhausted");
    const second = await c.post("/api/features/interview/launch");
    assert.equal(second.status, 403);
    assert.equal(second.json.code, "ENTITLEMENT_EXHAUSTED");
  });

  test("parallel launches cannot overspend a quota", async () => {
    const c = new Client();
    await c.post("/api/auth/sign-in/anonymous");
    const results = await Promise.all(Array.from({ length: 6 }, () => c.post("/api/features/simulations/launch")));
    assert.equal(results.filter((r) => r.status === 201).length, 2, "trial simulation limit is 2");
    assert.equal(results.filter((r) => r.status === 403).length, 4);
  });

  test("anonymous sign-in is rate limited per IP", async () => {
    const ip = fakeIp();
    const statuses = [];
    for (let i = 0; i < 40; i++) {
      const r = await new Client(API, ip).post("/api/auth/sign-in/anonymous");
      statuses.push(r.status);
      if (r.status === 429) break;
    }
    assert.ok(statuses.includes(429));
  });

  test("registering from a trial session replaces the trial user", async () => {
    const c = new Client();
    await c.post("/api/auth/sign-in/anonymous");
    const trialId = (await c.get("/api/me")).json.user.id;
    const { username } = await registerVerified(c);
    const me = await c.get("/api/me");
    assert.equal(me.json.role, "learner");
    assert.equal(me.json.user.username, username);
    if (APP_DB) {
      const db = new pg.Client({ connectionString: APP_DB });
      await db.connect();
      const { rowCount } = await db.query("select 1 from users where id = $1", [trialId]);
      await db.end();
      assert.equal(rowCount, 0, "trial user deleted after linking");
    }
  });

  test("unknown feature is 404; unauthenticated is 401", async () => {
    const { c } = await registerVerified();
    assert.equal((await c.post("/api/features/nope/launch")).status, 404);
    assert.equal((await new Client().post("/api/features/interview/launch")).status, 401);
  });
});

describe("ownership and RLS", () => {
  test("another user's launch is 404, never 403", async () => {
    const a = await registerVerified();
    const b = await registerVerified();
    const launch = await a.c.post("/api/features/reasoning/launch");
    assert.equal(launch.status, 201);
    assert.equal((await a.c.get(`/api/launches/${launch.json.launchId}`)).status, 200);
    assert.equal((await b.c.get(`/api/launches/${launch.json.launchId}`)).status, 404);
    assert.equal((await b.c.get("/api/launches/not-a-uuid")).status, 404);
  });

  test("RLS backstop: the app role sees nothing without app.user_id and only its own rows with it", { skip: !APP_DB }, async () => {
    const a = await registerVerified();
    const b = await registerVerified();
    await a.c.post("/api/features/simulations/launch");
    await b.c.post("/api/features/simulations/launch");
    const aId = (await a.c.get("/api/me")).json.user.id;
    const bId = (await b.c.get("/api/me")).json.user.id;

    const db = new pg.Client({ connectionString: APP_DB });
    await db.connect();
    try {
      // No request user set: role-wide, like the shared tables since 0011 (the organisation and admin
      // consoles count launches per organisation this way, migration 0012). Writes still need the owner.
      const all = await db.query("select user_id from feature_launches where user_id in ($1, $2)", [aId, bId]);
      assert.equal(all.rowCount, 2, "no request user → the console's role-wide read");
      await assert.rejects(db.query("insert into feature_launches (user_id, org_id, feature) values ($1, $2, 'interview')", [bId, (await db.query("select org_id from memberships where user_id = $1", [bId])).rows[0].org_id]), /row-level security/);
      // The shared tables answer role-wide too (Better Auth, admin console, tenancy).
      const bOrg = (await db.query("select org_id from memberships where user_id = $1", [bId])).rows[0]?.org_id;
      assert.ok(bOrg, "memberships readable without a user context");
      assert.equal((await db.query("select 1 from users where id = $1", [bId])).rowCount, 1);

      await db.query("begin");
      await db.query("select set_config('app.user_id', $1, true)", [aId]);
      const own = await db.query("select distinct user_id from feature_launches");
      assert.deepEqual(own.rows.map((r) => r.user_id), [aId]);
      await assert.rejects(
        db.query("insert into feature_launches (user_id, org_id, feature) values ($1, $2, 'interview')", [bId, bOrg]),
        /row-level security/,
      );
      await db.query("rollback");

      await assert.rejects(db.query("delete from feature_launches"), /permission denied/);
    } finally {
      await db.end();
    }
  });

  test("RLS backstop (migration 0011): with a request user set, users/memberships/organizations show only that user's rows", { skip: !APP_DB }, async () => {
    const a = await registerVerified();
    const b = await registerVerified();
    const aId = (await a.c.get("/api/me")).json.user.id;
    const bId = (await b.c.get("/api/me")).json.user.id;
    const db = new pg.Client({ connectionString: APP_DB });
    await db.connect();
    try {
      await db.query("begin");
      await db.query("select set_config('app.user_id', $1, true)", [aId]);
      assert.deepEqual((await db.query("select id from users where id in ($1, $2) order by id", [aId, bId])).rows.map((r) => r.id), [aId], "only own user row");
      assert.deepEqual([...new Set((await db.query("select user_id from memberships")).rows.map((r) => r.user_id))], [aId], "only own memberships");
      const orgs = await db.query("select o.id from organizations o join memberships m on m.org_id = o.id where m.user_id in ($1, $2)", [aId, bId]);
      assert.equal(orgs.rowCount, 1, "only organisations the user belongs to");
      assert.equal((await db.query("select 1 from organizations where id in (select org_id from memberships where user_id = $1)", [bId])).rowCount, 0);
      await assert.rejects(db.query("update users set name = 'x' where id = $1", [bId]).then((r) => { if (r.rowCount === 0) throw new Error("0 rows"); }), /0 rows|row-level security/);
      await assert.rejects(db.query("insert into memberships (org_id, user_id, role) select org_id, $1, 'learner' from memberships where user_id = $1", [bId]).then((r) => { if (r.rowCount === 0) throw new Error("0 rows"); }), /0 rows|row-level security/);
      await db.query("rollback");
      // After the transaction the setting reads '' on this connection: still no user context.
      assert.equal((await db.query("select 1 from users where id = $1", [bId])).rowCount, 1);
    } finally {
      await db.end();
    }
  });
});

describe("per-account sign-in lockout", () => {
  const wrong = (username) => new Client().post("/api/auth/sign-in/username", { username, password: "wrong-password-123" });
  // limits.ts signInKey: a hash of the normalised name.
  const keyOf = (username) => `signin:${createHash("sha256").update(username.trim().toLowerCase()).digest("hex")}`;
  const failureRows = (username) => appDb(async (db) => (await db.query("select 1 from signin_failures where key = $1", [keyOf(username)])).rowCount);

  test("five wrong passwords from five networks lock the username; a known and an unknown name answer alike", async () => {
    const { username } = await registerVerified();
    const ghost = `nobody_${uid()}`;
    for (let i = 0; i < 5; i++) {
      assert.equal((await wrong(username)).status, 401);
      assert.equal((await wrong(ghost)).status, 401);
    }
    const a = await wrong(username);
    const b = await wrong(ghost);
    assert.equal(a.status, 429, a.text);
    assert.equal(b.status, 429, b.text);
    assert.equal(a.json.code, "ACCOUNT_LOCKED");
    assert.deepEqual({ code: a.json.code, message: a.json.message }, { code: b.json.code, message: b.json.message }, "a lock does not reveal whether the account exists");
    assert.ok(a.json.retryAfter > 14 * 60 && a.json.retryAfter <= 15 * 60, `retryAfter ${a.json.retryAfter}`);
    assert.equal(a.headers.get("retry-after"), String(a.json.retryAfter));

    const right = await new Client().post("/api/auth/sign-in/username", { username, password: PASSWORD });
    assert.equal(right.status, 429, "the right password does not get through a lock either");
    assert.ok(await mailbox(`${username}@example.test`, "signin-locked"), "the owner is told once");

    if (APP_DB) {
      await appDb((db) => db.query("update signin_failures set locked_until = now() - interval '1 second' where key = $1", [keyOf(username)]));
      const after = await new Client().post("/api/auth/sign-in/username", { username, password: PASSWORD });
      assert.equal(after.status, 200, after.text);
      // Success forgets the failures: the row is gone, and the next run starts from the first lock again.
      assert.equal(await failureRows(username), 0, "a successful sign-in clears the count");
      for (let i = 0; i < 5; i++) assert.equal((await wrong(username)).status, 401);
      const again = await wrong(username);
      assert.equal(again.status, 429);
      assert.ok(again.json.retryAfter <= 15 * 60, `a first lock again, not a doubled one: ${again.json.retryAfter}`);
    }
  });

  test("parallel wrong passwords cannot get past the threshold; the owner is told once", async () => {
    const { username, email } = await registerVerified();
    const results = await Promise.all(Array.from({ length: 20 }, () => wrong(username)));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 5, `only five passwords are checked: ${statuses}`);
    assert.equal(statuses.filter((s) => s === 429).length, 15, String(statuses));
    assert.ok(results.filter((r) => r.status === 429).every((r) => r.json.code === "ACCOUNT_LOCKED"));
    assert.ok(await mailbox(email, "signin-locked"), "the owner is told");
    await sleep(300);
    assert.equal((await inbox(email)).filter((m) => m.kind === "signin-locked").length, 1, "once");
  });

  test("requests that were no password guess are not counted", async () => {
    const { username } = await registerVerified();
    // Over the length limit: refused before any password check, so it must not use up the budget.
    for (let i = 0; i < 7; i++) {
      const r = await new Client().post("/api/auth/sign-in/username", { username, password: "x".repeat(200) });
      assert.equal(r.status, 400, r.text);
    }
    const ok = await new Client().post("/api/auth/sign-in/username", { username, password: PASSWORD });
    assert.equal(ok.status, 200, ok.text);
  });

  test("resetting the password by email lifts the lock", async () => {
    const { username, email } = await registerVerified();
    for (let i = 0; i < 5; i++) await wrong(username);
    assert.equal((await wrong(username)).status, 429);

    const c = new Client();
    assert.equal((await c.post("/api/auth/email-otp/request-password-reset", { email })).status, 200);
    const otp = otpOf(await mailbox(email, "otp:forget-password"));
    const newPassword = "new-correct-horse-3";
    const reset = await c.post("/api/auth/email-otp/reset-password", { email, otp, password: newPassword });
    assert.equal(reset.status, 200, reset.text);
    const ok = await new Client().post("/api/auth/sign-in/username", { username, password: newPassword });
    assert.equal(ok.status, 200, ok.text);
  });

  test("a browser that signed in before is not locked out by strangers' guesses; it is locked only by its own", async () => {
    const { username, email } = await registerVerified();
    const owner = new Client();
    const first = await owner.post("/api/auth/sign-in/username", { username, password: PASSWORD });
    assert.equal(first.status, 200, first.text);
    const set = first.headers.getSetCookie().find((c) => c.startsWith("tr.signin_device="));
    assert.ok(set, "a successful sign-in marks the browser");
    for (const attr of ["HttpOnly", "Path=/api/auth", "SameSite=Strict"]) assert.ok(set.includes(attr), `${attr}: ${set}`);
    assert.ok(!/Domain=/i.test(set), `host-only: ${set}`);
    const token = owner.cookies.get("tr.signin_device");

    for (let i = 0; i < 5; i++) assert.equal((await wrong(username)).status, 401);
    assert.equal((await wrong(username)).status, 429, "strangers locked the name");
    assert.equal((await new Client().post("/api/auth/sign-in/username", { username, password: PASSWORD })).status, 429, "a new browser is held by the lock");
    const known = await owner.post("/api/auth/sign-in/username", { username, password: PASSWORD });
    assert.equal(known.status, 200, `the owner's browser gets through: ${known.text}`);
    assert.equal((await wrong(username)).status, 429, "the strangers' lock stays");

    // The token only counts for the name it was issued to, and only as issued.
    const other = await registerVerified();
    for (let i = 0; i < 5; i++) await wrong(other.username);
    const borrowed = new Client();
    borrowed.cookies.set("tr.signin_device", owner.cookies.get("tr.signin_device"));
    assert.equal((await borrowed.post("/api/auth/sign-in/username", { username: other.username, password: PASSWORD })).status, 429, "another name");
    const forged = new Client();
    forged.cookies.set("tr.signin_device", token.replace(/.(?=\.[^.]*$)/, (c) => (c === "0" ? "1" : "0")));
    assert.equal((await forged.post("/api/auth/sign-in/username", { username, password: PASSWORD })).status, 429, "a forged token");

    // Wrong passwords from the known browser lock that browser only, without a new email to the owner.
    for (let i = 0; i < 5; i++) assert.equal((await owner.post("/api/auth/sign-in/username", { username, password: "wrong-password-123" })).status, 401);
    const own = await owner.post("/api/auth/sign-in/username", { username, password: PASSWORD });
    assert.equal(own.status, 429, "locked on its own, it is a stranger again (and the name is locked)");
    assert.equal(own.json.code, "ACCOUNT_LOCKED");
    await sleep(300);
    assert.equal((await inbox(email)).filter((m) => m.kind === "signin-locked").length, 1, "only the name's lock was emailed");
  });
});

describe("verification and reset codes per address", () => {
  const send = (c, email, i) =>
    i % 2 ? c.post("/api/auth/email-otp/request-password-reset", { email }) : c.post("/api/auth/email-otp/send-verification-otp", { email, type: "email-verification" });

  test("five codes per address from one network; another network still gets one (no lock-out by strangers)", async () => {
    const email = `victim_${uid()}@example.test`;
    const attacker = new Client();
    for (let i = 0; i < 5; i++) assert.equal((await send(attacker, email, i)).status, 200, `send ${i + 1}`);
    const sixth = await send(attacker, email, 5);
    assert.equal(sixth.status, 429, sixth.text);
    assert.equal(sixth.json.code, "OTP_EMAIL_LIMIT");
    assert.ok(sixth.json.retryAfter > 3500 && sixth.json.retryAfter <= 3600, `retryAfter ${sixth.json.retryAfter}`);
    assert.equal(sixth.headers.get("retry-after"), String(sixth.json.retryAfter));
    const owner = await send(new Client(), email.toUpperCase(), 1);
    assert.equal(owner.status, 200, "the owner, elsewhere, can still reset");
  });

  test("twenty codes per address per hour across all networks", async () => {
    const email = `flood_${uid()}@example.test`;
    for (let n = 0; n < 4; n++) {
      const c = new Client();
      for (let i = 0; i < 5; i++) assert.equal((await send(c, email, i)).status, 200);
    }
    const over = await send(new Client(), email, 0);
    assert.equal(over.status, 429);
    assert.equal(over.json.code, "OTP_EMAIL_LIMIT");
  });

  test("strangers on other networks cannot use up the owner's codes for a browser that signed in to the account", async () => {
    const { c: owner, email } = await registerVerified();
    const { c: someoneElse } = await registerVerified();
    const reset = (c) => c.post("/api/auth/email-otp/request-password-reset", { email });
    for (let n = 0; n < 4; n++) {
      const c = new Client();
      for (let i = 0; i < 5; i++) assert.equal((await reset(c)).status, 200);
    }
    assert.equal((await reset(new Client())).json?.code, "OTP_EMAIL_LIMIT", "a new browser waits for the hour");
    assert.equal((await reset(someoneElse)).json?.code, "OTP_EMAIL_LIMIT", "another account's browser too");
    const mine = await reset(owner);
    assert.equal(mine.status, 200, `the owner's browser still gets a reset code: ${mine.text}`);
    for (let i = 0; i < 4; i++) assert.equal((await reset(owner)).status, 200);
    assert.equal((await reset(owner)).json?.code, "OTP_EMAIL_LIMIT", "still five per network");
  });
});

describe("sessions that end", () => {
  test("identity lookups relay no re-minted session_data cookie; a signed-out cookie gets 401 and the expiries", { skip: !INTERNAL_TOKEN && "needs INTERNAL_API_TOKEN" }, async () => {
    const { c } = await registerVerified();
    const cookie = c.cookieHeader();
    const sessionData = /^(?:__Secure-)?tr\.session_data(?:\.\d+)?=/;
    for (let i = 0; i < 2; i++) {
      const r = await identity(cookie);
      assert.equal(r.status, 200);
      assert.deepEqual(r.setCookies.filter((x) => sessionData.test(x) && !/max-age=0/i.test(x)), [], "the apps' identity cache key must not change");
    }
    assert.equal((await c.post("/api/auth/sign-out")).status, 200);
    const gone = await identity(cookie);
    assert.equal(gone.status, 401);
    assert.ok(gone.setCookies.some((x) => /^(?:__Secure-)?tr\.session_token=/.test(x) && /max-age=0/i.test(x)), "the expiry is relayed");
  });

  test("a deleted guest's cookie gets 401 at once, never 500", { skip: !TRIAL && "TRIAL_ENABLED=false" }, async () => {
    const c = new Client();
    assert.equal((await c.post("/api/auth/sign-in/anonymous")).status, 200);
    assert.equal((await c.get("/api/me")).status, 200);
    const old = new Client(API, c.ip);
    old.cookies = new Map(c.cookies);
    assert.equal((await c.post("/api/auth/delete-anonymous-user")).status, 200);
    assert.equal((await old.get("/api/me")).status, 401, "fresh route");
    assert.equal((await old.get("/api/features/interview")).status, 401, "cookie-cached route");
  });

  test("a demoted admin loses the console and the apps at once", { skip: !APP_DB || !INTERNAL_TOKEN }, async () => {
    const a = await registerVerified();
    const b = await registerVerified();
    await appDb((db) => db.query("update users set role = 'admin' where username = any($1)", [[a.username, b.username]]));
    assert.equal((await b.c.get("/api/admin/users")).status, 200);
    const bId = (await b.c.get("/api/me")).json.user.id;
    const demote = await a.c.post(`/api/admin/users/${bId}/role`, { role: "user", confirmEmail: b.email });
    assert.equal(demote.status, 200, demote.text);
    assert.equal(demote.json.sessionsEnded > 0, true);
    assert.equal((await b.c.get("/api/admin/users")).status, 401);
    assert.equal((await b.c.get("/api/me")).status, 401);
    assert.equal((await identity(b.c.cookieHeader())).status, 401);
  });
});

describe("admin console", () => {
  test("reads of personal data are audited, and the CSV never hands a spreadsheet a formula", { skip: !APP_DB }, async () => {
    const admin = await registerVerified();
    await appDb((db) => db.query("update users set role = 'admin' where username = $1", [admin.username]));
    const t = uid();
    await appDb((db) =>
      db.query("insert into users (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, now(), now())", [
        `csv-${t}`,
        ' =HYPERLINK("http://x.example","open")',
        `csv-${t}@example.test`,
      ]),
    );
    const audits = (action) =>
      appDb(async (db) => (await db.query("select count(*)::int as n from admin_audit_log where action = $1 and actor_email = $2", [action, admin.email])).rows[0].n);

    const csv = await admin.c.get(`/api/admin/export/users.csv?q=csv-${t}`);
    assert.equal(csv.status, 200, csv.text);
    const row = csv.text.split("\r\n").find((l) => l.includes(`csv-${t}@example.test`));
    assert.ok(row?.startsWith(`"' =HYPERLINK(""http://x.example"",""open"")"`), row);
    assert.equal(await audits("users.export"), 1);

    assert.equal((await admin.c.get(`/api/admin/users/csv-${t}`)).status, 200);
    assert.equal(await audits("user.view"), 1);
  });

  test("figures cover the whole UTC days of the range, and the range says which", { skip: !APP_DB }, async () => {
    const admin = await registerVerified();
    await appDb((db) => db.query("update users set role = 'admin' where username = $1", [admin.username]));
    const id = (await admin.c.get("/api/me")).json.user.id;
    const day = (ago) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    await appDb((db) =>
      db.query("insert into activity_days (user_id, day, app, area, seconds) values ($1, $2, 'labs', '', 60), ($1, $3, 'labs', '', 600), ($1, $4, 'labs', '', 6)", [id, day(9), day(8), day(1)]),
    );
    const detail = (from, to) => admin.c.get(`/api/admin/users/${encodeURIComponent(id)}?${new URLSearchParams({ from, to })}`);
    const r = await detail(`${day(8)}T18:30:00.000Z`, `${day(1)}T12:00:00.000Z`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.range, { from: `${day(8)}T00:00:00.000Z`, to: `${day(0)}T00:00:00.000Z` });
    assert.equal(r.json.time.seconds, 606, "the first and the last day count in full; the day before does not");
    const midnight = await detail(`${day(8)}T00:00:00.000Z`, `${day(1)}T00:00:00.000Z`);
    assert.equal(midnight.json.range.to, `${day(1)}T00:00:00.000Z`);
    assert.equal(midnight.json.time.seconds, 600, "a range that ends at midnight leaves that day out");
  });
});

describe("display names", () => {
  test("a username/password account is named by its username, whatever the sign-up body says", async () => {
    const { c, username } = await registerVerified(new Client(), { name: " =1+2 ThreatReady Support" });
    const s = await c.get("/api/auth/get-session");
    assert.equal(s.json.user.name, username);
  });

  test("displayUsername cannot carry another name either; only the username's own case is kept", async () => {
    const formula = new Client();
    const u1 = `u_${uid()}`;
    const bad = await formula.post("/api/auth/sign-up/email", {
      email: `${u1}@example.test`,
      password: PASSWORD,
      name: u1,
      username: u1,
      displayUsername: '=HYPERLINK("http://x.example","open") ThreatReady Support',
    });
    assert.equal(bad.status, 400, bad.text);

    const other = await registerVerified(new Client(), { displayUsername: "ThreatReady_Support" });
    const s1 = (await other.c.get("/api/auth/get-session")).json.user;
    assert.deepEqual({ name: s1.name, displayUsername: s1.displayUsername }, { name: other.username, displayUsername: other.username });

    const cased = await registerVerified(new Client(), { displayUsername: (u) => u.toUpperCase() });
    const s2 = (await cased.c.get("/api/auth/get-session")).json.user;
    assert.equal(s2.name, cased.username.toUpperCase());
    assert.equal(s2.username, cased.username);
  });
});

describe("activity", () => {
  const ping = (c, area = "") => c.post("/api/activity/ping", { app: "labs", area, timeZone: "Asia/Kolkata" });

  test("parallel pings from several areas credit the elapsed time once", { skip: !APP_DB }, async () => {
    const { c } = await registerVerified();
    const id = (await c.get("/api/me")).json.user.id;
    const total = () => appDb(async (db) => Number((await db.query("select coalesce(sum(seconds), 0) as s from activity_days where user_id = $1", [id])).rows[0].s));
    const burst = () => Promise.all(["a", "b", "c", "d", "e"].map((area) => ping(c, area)));
    assert.deepEqual((await burst()).map((r) => r.status), [204, 204, 204, 204, 204]);
    const first = await total();
    assert.ok(first <= 30, `first burst credited ${first}s`);
    await appDb((db) => db.query("update activity_last_ping set last_at = now() - interval '70 seconds' where user_id = $1", [id]));
    await burst();
    const second = await total();
    assert.ok(second - first >= 60 && second - first <= 75, `70 s apart credited ${second - first}s`);
  });

  test("an unknown time zone is refused", async () => {
    const { c } = await registerVerified();
    const r = await c.post("/api/activity/ping", { app: "home", area: "", timeZone: "Mars/Olympus_Mons" });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "VALIDATION_FAILED");
  });

  test("the ping limit is per user: one user over it does not block another on the same network", async () => {
    const ip = fakeIp();
    const a = await registerVerified(new Client(API, ip));
    const b = await registerVerified(new Client(API, ip));
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await ping(a.c)).status);
    assert.equal(statuses.filter((s) => s === 204).length, 20, String(statuses));
    const over = await ping(a.c);
    assert.equal(over.status, 429);
    assert.equal(over.json.code, "RATE_LIMITED");
    assert.ok(Number(over.headers.get("retry-after")) > 0);
    for (let i = 0; i < 13; i++) assert.equal((await ping(b.c)).status, 204, "a classmate on the same IP");
  });
});

describe("personal workspace", () => {
  test("parallel first requests create exactly one membership", { skip: !APP_DB }, async () => {
    const { c } = await registerVerified();
    const id = (await c.get("/api/me")).json.user.id;
    await appDb((db) => db.query("delete from memberships where user_id = $1", [id]));
    const results = await Promise.all(Array.from({ length: 10 }, () => c.get("/api/features/interview")));
    assert.deepEqual([...new Set(results.map((r) => r.status))], [200]);
    const n = await appDb(async (db) => (await db.query("select count(*)::int as n from memberships where user_id = $1", [id])).rows[0].n);
    assert.equal(n, 1);
  });
});

describe("retention", () => {
  test("expired sessions, stale sign-ups and gone guests are removed; live data stays", { skip: !APP_DB }, async () => {
    const { runRetention } = await import("../dist/retention/retention.js");
    const { createDb, createPool } = await import("../dist/db/db.js");
    const { c } = await registerVerified();
    const live = (await c.get("/api/me")).json.user.id;
    const t = uid();
    await appDb(async (db) => {
      await db.query(
        `insert into users (id, name, email, email_verified, is_anonymous, created_at, updated_at) values
         ($1, 'old', $2, false, false, now() - interval '31 days', now()),
         ($3, 'new', $4, false, false, now() - interval '2 days', now()),
         ($5, 'Trial user', $6, false, true, now() - interval '8 days', now()),
         ($7, 'oauth', $8, false, false, now() - interval '31 days', now()),
         ($9, 'github, away a week', $10, false, false, now() - interval '31 days', now()),
         ($11, 'password and github', $12, false, false, now() - interval '31 days', now())`,
        [
          `ret-old-${t}`, `ret-old-${t}@example.test`, `ret-new-${t}`, `ret-new-${t}@example.test`, `ret-guest-${t}`, `ret-guest-${t}@trial.threatready.invalid`,
          `ret-live-${t}`, `ret-live-${t}@example.test`, `ret-gh-${t}`, `ret-gh-${t}@example.test`, `ret-both-${t}`, `ret-both-${t}@example.test`,
        ],
      );
      // How each one signs in. GitHub stores its own email_verified flag (false when it has not verified the address).
      await db.query(
        `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at) values
         ($1, $2, 'credential', $2, now(), now()), ($3, $4, 'credential', $4, now(), now()),
         ($5, $6, 'github', $7, now(), now()),
         ($8, $9, 'credential', $9, now(), now()), ($10, $11, 'github', $9, now(), now())`,
        [`ret-a1-${t}`, `ret-old-${t}`, `ret-a2-${t}`, `ret-new-${t}`, `ret-a3-${t}`, `gh-${t}`, `ret-gh-${t}`, `ret-a4-${t}`, `ret-both-${t}`, `ret-a5-${t}`, `gh2-${t}`],
      );
      await db.query(
        `insert into sessions (id, expires_at, token, user_id, created_at, updated_at) values
         ($1, now() - interval '2 days', $2, $3, now() - interval '9 days', now()),
         ($4, now() + interval '1 day', $5, $6, now(), now()),
         ($7, now() - interval '2 days', $8, $9, now() - interval '9 days', now())`,
        [`ret-s-${t}`, `ret-token-${t}`, live, `ret-l-${t}`, `ret-ltoken-${t}`, `ret-live-${t}`, `ret-g-${t}`, `ret-gtoken-${t}`, `ret-gh-${t}`],
      );
      await db.query("insert into activity_days (user_id, day, app, area, seconds) values ($1, current_date - 9, 'labs', '', 3600)", [`ret-gh-${t}`]);
    });
    const pool = createPool(APP_DB);
    try {
      // null = the API under test is running its own pass right now; wait for it and run ours.
      let result = null;
      for (let i = 0; i < 20 && !result; i++) {
        result = await runRetention(createDb(pool), { unverifiedDays: 30, guestDays: 7 });
        if (!result) await sleep(250);
      }
      assert.ok(result, "the pass ran");
    } finally {
      await pool.end();
    }
    const left = await appDb(async (db) => ({
      users: (await db.query("select id from users where id like $1 order by id", [`ret-%-${t}`])).rows.map((r) => r.id),
      session: (await db.query("select 1 from sessions where id = $1", [`ret-s-${t}`])).rowCount,
      activity: (await db.query("select 1 from activity_days where user_id = $1", [`ret-gh-${t}`])).rowCount,
    }));
    assert.deepEqual(
      left.users,
      [`ret-both-${t}`, `ret-gh-${t}`, `ret-live-${t}`, `ret-new-${t}`],
      "only the stale never-verified password sign-up and the guest go; recent sign-ups, live sessions and Google/GitHub users stay",
    );
    assert.equal(left.session, 0);
    assert.equal(left.activity, 1, "a GitHub user whose session lapsed keeps their activity");
    assert.equal((await c.get("/api/me")).status, 200, "a live session is untouched");
  });
});

describe("Turnstile, guest sessions off (second API instance against a siteverify stub)", () => {
  let api;
  let stub;
  const PORT = Number(process.env.CAPTCHA_API_PORT ?? 3101);
  const STUB_PORT = Number(process.env.CAPTCHA_STUB_PORT ?? 3102);
  const base = `http://localhost:${PORT}`;

  before(async () => {
    stub = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        // Better Auth posts JSON; CaptchaService posts a form. Turnstile accepts both.
        let token;
        try {
          token = JSON.parse(body).response;
        } catch {
          token = new URLSearchParams(body).get("response");
        }
        const ok = token === "good-token";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ success: ok, hostname: "localhost", "error-codes": ok ? [] : ["invalid-input-response"] }));
      });
    }).listen(STUB_PORT);
    const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    api = spawn(process.execPath, [main], {
      env: {
        ...process.env,
        PORT: String(PORT),
        TURNSTILE_SITE_KEY: "test-site-key",
        TURNSTILE_SECRET_KEY: "test-secret",
        TURNSTILE_VERIFY_URL: `http://127.0.0.1:${STUB_PORT}/siteverify`,
        TRIAL_ENABLED: "false",
        RETENTION_INTERVAL_HOURS: "0",
      },
      stdio: "ignore",
    });
    // A cold start on a slow disk or a busy machine can take a minute or more.
    for (let i = 0; i < 900; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return;
      } catch {}
      await sleep(200);
    }
    throw new Error("captcha API instance did not start");
  });

  after(() => {
    api?.kill();
    stub?.close();
  });

  test("public config exposes the site key only, and no guest sessions", async () => {
    const cfg = await (await fetch(`${base}/api/public/config`)).json();
    assert.equal(cfg.turnstileSiteKey, "test-site-key");
    assert.equal(cfg.trialEnabled, false);
    assert.ok(!JSON.stringify(cfg).includes("test-secret"));
  });

  test("sign-up and forgot-username require a valid token; guest sign-in does not exist", async () => {
    const username = `u_${uid()}`;
    const body = { email: `${username}@example.test`, password: PASSWORD, name: username, username };
    assert.equal((await new Client(base).post("/api/auth/sign-up/email", body)).status, 400, "missing token");
    assert.equal((await new Client(base).post("/api/auth/sign-up/email", body, { "x-captcha-response": "bad" })).status, 403, "bad token");
    assert.equal((await new Client(base).post("/api/auth/sign-up/email", body, { "x-captcha-response": "good-token" })).status, 200);

    const guest = await new Client(base).post("/api/auth/sign-in/anonymous", {}, { "x-captcha-response": "good-token" });
    assert.equal(guest.status, 404, "TRIAL_ENABLED=false removes anonymous sign-in");

    const missing = await new Client(base).post("/api/account/forgot-username", { email: "a@example.test" });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "MISSING_CAPTCHA");
    const good = await new Client(base).post("/api/account/forgot-username", { email: "a@example.test" }, { "x-captcha-response": "good-token" });
    assert.equal(good.status, 202);
  });

  test("sign-ins refused for a missing token never reach the lockout count", async () => {
    const { username } = await registerVerified();
    for (let i = 0; i < 6; i++) {
      const r = await new Client(base).post("/api/auth/sign-in/username", { username, password: "wrong-password-123" });
      assert.equal(r.status, 400, r.text);
    }
    const ok = await new Client(base).post("/api/auth/sign-in/username", { username, password: PASSWORD }, { "x-captcha-response": "good-token" });
    assert.equal(ok.status, 200, ok.text);
  });
});
