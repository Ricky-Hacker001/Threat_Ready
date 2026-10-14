/**
 * End-to-end suite against a running API + PostgreSQL (no mocks).
 *
 *   pnpm --filter @threatready/api build
 *   API_URL=http://localhost:3000 pnpm --filter @threatready/api test:e2e
 *
 * Requires EMAIL_DRIVER=log (reads OTPs from /api/dev/mailbox) and
 * RATE_LIMIT_MULTIPLIER >= 10 on the API under test. Spawns a second API
 * instance with Turnstile enabled against a local siteverify stub.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const API = process.env.API_URL ?? "http://localhost:3000";
const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const APP_DB = process.env.DATABASE_URL;
const PASSWORD = "correct-horse-battery-1";

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
    return { status: res.status, json, text };
  }
  get = (p, h) => this.req("GET", p, undefined, h);
  post = (p, b = {}, h) => this.req("POST", p, b, h);
}

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

async function registerVerified(c = new Client()) {
  const username = `u_${uid()}`;
  const email = `${username}@example.test`;
  const signUp = await c.post("/api/auth/sign-up/email", { email, password: PASSWORD, name: username, username });
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

  test("sign-out ends the session", async () => {
    const { c } = await registerVerified();
    assert.equal((await c.post("/api/auth/sign-out")).status, 200);
    assert.equal((await c.get("/api/me")).status, 401);
  });

  test("login is rate limited per IP", async () => {
    const c = new Client();
    const statuses = [];
    for (let i = 0; i < 60; i++) {
      const r = await c.post("/api/auth/sign-in/username", { username: `nobody_${uid()}`, password: "wrong-password-123" });
      statuses.push(r.status);
      if (r.status === 429) break;
    }
    assert.ok(statuses.includes(429), `expected 429, got ${[...new Set(statuses)]}`);
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

describe("free trial (anonymous) and entitlements", () => {
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
      const none = await db.query("select user_id from feature_launches");
      assert.equal(none.rowCount, 0, "missing WHERE and missing setting → no rows");

      await db.query("begin");
      await db.query("select set_config('app.user_id', $1, true)", [aId]);
      const own = await db.query("select distinct user_id from feature_launches");
      assert.deepEqual(own.rows.map((r) => r.user_id), [aId]);
      await assert.rejects(
        db.query("insert into feature_launches (user_id, org_id, feature) select $1, org_id, 'interview' from memberships where user_id = $1", [bId]),
        /row-level security/,
      );
      await db.query("rollback");

      await assert.rejects(db.query("delete from feature_launches"), /permission denied/);
    } finally {
      await db.end();
    }
  });
});

describe("Turnstile (second API instance against a siteverify stub)", () => {
  let api;
  let stub;
  const PORT = 3101;
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
    }).listen(3102);
    const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    api = spawn(process.execPath, [main], {
      env: {
        ...process.env,
        PORT: String(PORT),
        TURNSTILE_SITE_KEY: "test-site-key",
        TURNSTILE_SECRET_KEY: "test-secret",
        TURNSTILE_VERIFY_URL: "http://127.0.0.1:3102/siteverify",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 50; i++) {
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

  test("public config exposes the site key only", async () => {
    const cfg = await (await fetch(`${base}/api/public/config`)).json();
    assert.equal(cfg.turnstileSiteKey, "test-site-key");
    assert.ok(!JSON.stringify(cfg).includes("test-secret"));
  });

  test("trial, sign-up and forgot-username require a valid token", async () => {
    const c = new Client(base);
    assert.equal((await c.post("/api/auth/sign-in/anonymous")).status, 400, "missing token");
    assert.equal((await c.post("/api/auth/sign-in/anonymous", {}, { "x-captcha-response": "bad" })).status, 403, "bad token");
    assert.equal((await c.post("/api/auth/sign-in/anonymous", {}, { "x-captcha-response": "good-token" })).status, 200);

    const missing = await new Client(base).post("/api/account/forgot-username", { email: "a@example.test" });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "MISSING_CAPTCHA");
    const good = await new Client(base).post("/api/account/forgot-username", { email: "a@example.test" }, { "x-captcha-response": "good-token" });
    assert.equal(good.status, 202);
  });
});
