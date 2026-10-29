/**
 * Business accounts (organisations), end to end against a running API + PostgreSQL (no mocks):
 * creating an organisation, inviting by email, accepting with the right and the wrong account,
 * seats, roles, suspension and removal, the console's permissions, the identity payload for the
 * apps, and the platform admin's organisation routes.
 *
 *   API_URL=http://localhost:3000 node --env-file=.env --test test/org.e2e.test.mjs
 *
 * Needs EMAIL_DRIVER=log (invitation links are read from /api/dev/mailbox), RATE_LIMIT_MULTIPLIER
 * >= 10, DATABASE_URL (to grant one test user the platform admin role) and INTERNAL_API_TOKEN.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import pg from "pg";

const API = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const APP_DB = process.env.DATABASE_URL;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;
const PASSWORD = "correct-horse-battery-1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => randomBytes(4).toString("hex");

class Client {
  constructor(base = API) {
    this.base = base;
    this.ip = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    this.cookies = new Map();
  }
  async req(method, path, body, extraHeaders = {}) {
    const headers = { origin: ORIGIN, "x-forwarded-for": this.ip, ...extraHeaders };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || attrs.some((a) => /max-age=0/i.test(a.trim()))) this.cookies.delete(name);
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
  patch = (p, b = {}, h) => this.req("PATCH", p, b, h);
  del = (p, h) => this.req("DELETE", p, undefined, h);
}

async function mailbox(to, kind, { wait = 3000 } = {}) {
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    const msgs = await (await fetch(`${API}/api/dev/mailbox?to=${encodeURIComponent(to)}`)).json();
    const hit = msgs.find((m) => m.kind === kind);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}
const otpOf = (msg) => msg.text.match(/Code: (\d{6})/)[1];
const inviteTokenOf = (msg) => msg.text.match(/Join: \S+\/invite\/([A-Za-z0-9_-]+)/)[1];

async function registerVerified(c = new Client(), email) {
  const username = `u_${uid()}`;
  email ??= `${username}@example.test`;
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

/** An org admin with a fresh organisation, created the way the sign-up page does it (account first, then POST /api/org). */
async function orgWithAdmin(name = `Acme ${uid()}`) {
  const admin = await registerVerified();
  const created = await admin.c.post("/api/org", { name, segment: "business" });
  assert.equal(created.status, 201, created.text);
  return { ...admin, org: created.json };
}

/** Invite an address and return the token from the email. */
async function inviteAndToken(adminClient, email, role = "member") {
  const r = await adminClient.post("/api/org/invitations", { emails: [email], role });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.sent.length, 1, JSON.stringify(r.json));
  const mail = await mailbox(email, "org-invite");
  assert.ok(mail, "invitation email");
  return { token: inviteTokenOf(mail), id: r.json.sent[0].id };
}

/**
 * The apps' per-user summary endpoint, stubbed where the API under test looks for InterviewPrep
 * (INTERVIEW_INTERNAL_URL, when it is on this host; Labs and Attack Reasoning under /labs and /ar of
 * the same origin, as the suite's runner sets them). Each app reports, like the real ones, the user's
 * lifetime stats, AI usage and latest items: one from long before joining, one dated now.
 * Null when the port is not local or is taken.
 */
async function appsStub() {
  const base = process.env.INTERVIEW_INTERNAL_URL;
  if (!base) return null;
  const u = new URL(base);
  if (!["127.0.0.1", "localhost"].includes(u.hostname) || !u.port) return null;
  const server = createServer((req, res) => {
    const m = /^(\/labs|\/ar)?\/internal\/v1\/users\/[^/]+\/summary$/.exec(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (!m) {
      res.statusCode = 404;
      return res.end("{}");
    }
    const app = m[1] === "/labs" ? "labs" : m[1] === "/ar" ? "reasoning" : "interview";
    const item = (id, title, at) => ({ id: `${app}-${id}`, title, status: "Report ready", score: 70, at, url: `http://127.0.0.1/${app}/${id}` });
    res.end(
      JSON.stringify({
        app,
        stats: [{ label: "Interviews completed", value: 12 }],
        items: [item("now", "Mock interview: on the team", new Date().toISOString()), item("before", "Mock interview: a job elsewhere", "2020-01-02T03:04:05.000Z")],
        aiUsage: { calls: 40, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.5 },
      }),
    );
  });
  try {
    await new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(Number(u.port), "127.0.0.1", ok);
    });
  } catch {
    return null;
  }
  return server;
}

async function appDb(fn) {
  const db = new pg.Client({ connectionString: APP_DB });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

describe("business accounts: creating an organisation", () => {
  test("a verified account creates an organisation, becomes its org admin and runs on the trial plan", async () => {
    const { c, org, email } = await orgWithAdmin("Northwind Logistics");
    assert.equal(org.name, "Northwind Logistics");
    assert.equal(org.kind, "business");
    assert.equal(org.entitlement.plan, "business_trial");
    assert.equal(org.entitlement.status, "trialing");
    assert.ok(org.entitlement.seats >= 1);
    assert.deepEqual(org.seats, { purchased: org.entitlement.seats, used: 1, pending: 0, available: org.entitlement.seats - 1 });

    const me = await c.get("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.json.org.role, "org_admin");
    assert.equal(me.json.org.name, "Northwind Logistics");
    assert.equal(me.json.personal.plan, "free");
    if (org.status === "active") {
      assert.equal(me.json.plan, "business_trial", "launches count on the organisation's plan");
      assert.equal(me.json.orgId, org.id);
      assert.equal(me.json.org.effective, true);
    } else {
      assert.equal(me.json.plan, "free", "pending approval: still on the personal plan");
      assert.equal(me.json.org.effective, false);
    }

    const overview = await c.get("/api/org");
    assert.equal(overview.status, 200, overview.text);
    assert.equal(overview.json.role, "org_admin");
    assert.equal(overview.json.org.id, org.id);

    const audit = await c.get("/api/org/audit");
    assert.equal(audit.status, 200);
    assert.equal(audit.json[0].action, "org.create");
    assert.equal(audit.json[0].actor.email, email);
  });

  test("one organisation per account; a guest and an unverified account cannot create one", async () => {
    const { c } = await orgWithAdmin();
    const again = await c.post("/api/org", { name: "Second Org", segment: "business" });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "ORG_ALREADY_MEMBER");

    const fresh = await registerVerified();
    const badName = await fresh.c.post("/api/org", { name: "<script>alert(1)</script>", segment: "business" });
    assert.equal(badName.status, 400);
    assert.equal(badName.json.code, "VALIDATION_FAILED");
    // Names go into invitation emails: nothing a mail client would turn into a link, on create or rename.
    const linkName = await fresh.c.post("/api/org", { name: "paypal.com/verify", segment: "business" });
    assert.equal(linkName.status, 400, linkName.text);
    assert.equal(linkName.json.code, "VALIDATION_FAILED");
    const rename = await c.patch("/api/org", { name: "secure-login.example.com" });
    assert.equal(rename.status, 400, rename.text);
    assert.equal((await c.patch("/api/org", { name: `Renamed ${uid()}` })).status, 200);

    const guest = new Client();
    const g = await guest.post("/api/auth/sign-in/anonymous");
    if (g.status === 200) {
      const r = await guest.post("/api/org", { name: "Guest Org", segment: "business" });
      assert.equal(r.status, 403, "guests hold no org:create permission");
    }

    // Unverified: signed up, never verified → cannot sign in at all (requireEmailVerification), so no route reaches org:create.
    const u = new Client();
    const username = `u_${uid()}`;
    await u.post("/api/auth/sign-up/email", { email: `${username}@example.test`, password: PASSWORD, name: username, username });
    const r = await u.post("/api/org", { name: "Unverified Org", segment: "business" });
    assert.equal(r.status, 401);
  });

  test("only onboard's own origin may create or change an organisation", async () => {
    const fresh = await registerVerified();
    const r = await fresh.c.post("/api/org", { name: "Cross Origin Org", segment: "business" }, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
  });
});

describe("business accounts: invitations and seats", () => {
  test("invite → email → the invited account accepts; the wrong account cannot", async () => {
    const admin = await orgWithAdmin();
    const invitee = `inv_${uid()}@example.test`;
    const { token } = await inviteAndToken(admin.c, invitee);

    // The invite page's preview: no sign-in needed, the address is only hinted.
    const preview = await fetch(`${API}/api/invitations/${token}`).then(async (r) => ({ status: r.status, json: await r.json() }));
    assert.equal(preview.status, 200);
    assert.equal(preview.json.state, "valid");
    assert.equal(preview.json.org.name, admin.org.name);
    assert.ok(!preview.json.emailHint.includes(invitee.split("@")[0]), "full local part is not shown");
    assert.ok(preview.json.emailHint.endsWith("@example.test"));
    const missing = await fetch(`${API}/api/invitations/${"x".repeat(43)}`);
    assert.equal(missing.status, 404);
    const malformed = await fetch(`${API}/api/invitations/short`);
    assert.equal(malformed.status, 404);

    // Seats: the pending invitation holds one.
    const before = await admin.c.get("/api/org");
    assert.equal(before.json.org.seats.pending, 1);

    // The wrong account (a different verified email) is refused.
    const stranger = await registerVerified();
    const wrong = await stranger.c.post(`/api/invitations/${token}/accept`);
    assert.equal(wrong.status, 403, wrong.text);
    assert.equal(wrong.json.code, "INVITE_EMAIL_MISMATCH");

    // The right account joins.
    const right = await registerVerified(new Client(), invitee);
    const ok = await right.c.post(`/api/invitations/${token}/accept`);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.org.id, admin.org.id);
    assert.equal(ok.json.role, "member");
    const me = await right.c.get("/api/me");
    assert.equal(me.json.org.role, "member");
    assert.equal(me.json.org.id, admin.org.id);

    // Once only.
    const twice = await right.c.post(`/api/invitations/${token}/accept`);
    assert.equal(twice.status, 410);
    assert.equal(twice.json.code, "INVITE_USED");

    // A member does not open the console; the admin sees them in People.
    const console_ = await right.c.get("/api/org");
    assert.equal(console_.status, 403);
    const people = await admin.c.get("/api/org/members");
    assert.equal(people.status, 200);
    assert.equal(people.json.members.length, 2);
    assert.equal(people.json.invitations.length, 0, "accepted invitation no longer pending");
    const after = await admin.c.get("/api/org");
    assert.deepEqual([after.json.org.seats.used, after.json.org.seats.pending], [2, 0]);

    // The apps' identity payload carries the organisation while its plan applies.
    if (INTERNAL_TOKEN) {
      const id = await fetch(`${API}/api/internal/identity/session`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, cookie: right.c.cookieHeader() } }).then((r) => r.json());
      if (after.json.org.status === "active") {
        assert.equal(id.org?.id, admin.org.id);
        assert.equal(id.org?.role, "member");
      } else {
        assert.equal(id.org, undefined);
      }
    }
  });

  test("the seat cap holds across a batch; duplicates, members and the inviter are skipped; revoke frees the seat", async () => {
    const admin = await orgWithAdmin();
    const seats = admin.org.entitlement.seats; // trial seats, one used by the admin
    const free = seats - 1;
    const emails = Array.from({ length: free + 2 }, () => `seat_${uid()}@example.test`);
    const r = await admin.c.post("/api/org/invitations", { emails: [...emails, emails[0], admin.email, "not-an-email"], role: "member" });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.sent.length, free, "only as many as there are free seats");
    const reasons = Object.fromEntries(r.json.skipped.map((s) => [s.email, s.reason]));
    assert.equal(reasons[emails[free]], "no_seats");
    assert.equal(reasons[emails[free + 1]], "no_seats");
    assert.equal(reasons[admin.email], "self");
    assert.equal(reasons["not-an-email"], "invalid");
    assert.equal(r.json.seats.available, 0);

    const again = await admin.c.post("/api/org/invitations", { emails: [emails[0]] });
    assert.equal(again.json.skipped[0].reason, "already_invited");

    const list = await admin.c.get("/api/org/members");
    const first = list.json.invitations.find((i) => i.email === emails[0]);
    const revoked = await admin.c.del(`/api/org/invitations/${first.id}`);
    assert.equal(revoked.status, 200);
    const after = await admin.c.get("/api/org");
    assert.equal(after.json.org.seats.available, 1, "revoking frees the seat");
    const gone = await fetch(`${API}/api/invitations/${"a".repeat(43)}`);
    assert.equal(gone.status, 404);

    // Resend mints a new link; the old one no longer matches anything.
    const second = list.json.invitations.find((i) => i.email === emails[1]);
    const oldMail = await mailbox(emails[1], "org-invite");
    const oldToken = inviteTokenOf(oldMail);
    const resent = await admin.c.post(`/api/org/invitations/${second.id}/resend`);
    assert.equal(resent.status, 200, resent.text);
    const stale = await fetch(`${API}/api/invitations/${oldToken}`);
    assert.equal(stale.status, 404, "the previous link is dead after a resend");
  });

  test("seats are never overbooked: reinstating, renewing an expired invitation and accepting all need a free seat", async () => {
    const admin = await orgWithAdmin();
    const seats = admin.org.entitlement.seats;
    assert.ok(seats >= 4, "needs at least 4 trial seats (default 5)");
    // A member joins, then is suspended: a suspended member holds no seat.
    const memberEmail = `sm_${uid()}@example.test`;
    const { token } = await inviteAndToken(admin.c, memberEmail);
    const member = await registerVerified(new Client(), memberEmail);
    assert.equal((await member.c.post(`/api/invitations/${token}/accept`)).status, 200);
    const memberId = (await member.c.get("/api/me")).json.user.id;
    const statusUrl = `/api/org/members/${encodeURIComponent(memberId)}/status`;
    assert.equal((await admin.c.post(statusUrl, { status: "suspended" })).status, 200);

    // Every free seat goes to an invitation.
    const fill = Array.from({ length: seats - 1 }, () => `fill_${uid()}@example.test`);
    const sent = await admin.c.post("/api/org/invitations", { emails: fill, role: "member" });
    assert.equal(sent.status, 201, sent.text);
    assert.equal(sent.json.sent.length, seats - 1);
    assert.equal(sent.json.seats.available, 0);

    // Reinstating now would make one person too many.
    const full = await admin.c.post(statusUrl, { status: "active" });
    assert.equal(full.status, 409, full.text);
    assert.equal(full.json.code, "ORG_NO_SEATS");

    // An expired invitation frees its seat; another invitation takes it; renewing the expired one is refused.
    const expired = sent.json.sent[0];
    await appDb((db) => db.query("update org_invitations set expires_at = now() - interval '1 minute' where id = $1", [expired.id]));
    const late = await admin.c.post("/api/org/invitations", { emails: [`late_${uid()}@example.test`], role: "member" });
    assert.equal(late.json.sent.length, 1, late.text);
    const renew = await admin.c.post(`/api/org/invitations/${expired.id}/resend`);
    assert.equal(renew.status, 409, renew.text);
    assert.equal(renew.json.code, "ORG_NO_SEATS");

    // Withdrawing an invitation frees a seat: now the member comes back.
    const withdrawn = sent.json.sent[1];
    assert.equal((await admin.c.del(`/api/org/invitations/${withdrawn.id}`)).status, 200);
    const back = await admin.c.post(statusUrl, { status: "active" });
    assert.equal(back.status, 200, back.text);
    const seatsNow = (await admin.c.get("/api/org")).json.org.seats;
    assert.equal(seatsNow.used + seatsNow.pending, seats, "exactly full");

    // Over its seats (the seat count fell under what is in use), the organisation accepts nobody.
    await appDb((db) => db.query("update entitlements set seats = $2 where org_id = $1", [admin.org.id, seats - 1]));
    const pendingEmail = sent.json.sent[2].email;
    const invitee = await registerVerified(new Client(), pendingEmail);
    const mail = await mailbox(pendingEmail, "org-invite");
    const over = await invitee.c.post(`/api/invitations/${inviteTokenOf(mail)}/accept`);
    assert.equal(over.status, 409, over.text);
    assert.equal(over.json.code, "ORG_NO_SEATS");
    const after = (await admin.c.get("/api/org")).json.org.seats;
    assert.equal(after.used, 2, "still the admin and the reinstated member");
  });

  test("an expired invitation cannot be accepted and is reported as expired", async () => {
    const admin = await orgWithAdmin();
    const invitee = `exp_${uid()}@example.test`;
    const { token, id } = await inviteAndToken(admin.c, invitee);
    await appDb((db) => db.query("update org_invitations set expires_at = now() - interval '1 minute' where id = $1", [id]));
    const preview = await fetch(`${API}/api/invitations/${token}`).then((r) => r.json());
    assert.equal(preview.state, "expired");
    const right = await registerVerified(new Client(), invitee);
    const r = await right.c.post(`/api/invitations/${token}/accept`);
    assert.equal(r.status, 410);
    assert.equal(r.json.code, "INVITE_EXPIRED");
    const seats = await admin.c.get("/api/org");
    assert.equal(seats.json.org.seats.pending, 0, "an expired invitation holds no seat");
  });
});

describe("business accounts: roles, suspension, removal, leaving", () => {
  async function orgWithMember(role = "member") {
    const admin = await orgWithAdmin();
    const email = `m_${uid()}@example.test`;
    const { token } = await inviteAndToken(admin.c, email, role);
    const member = await registerVerified(new Client(), email);
    const ok = await member.c.post(`/api/invitations/${token}/accept`);
    assert.equal(ok.status, 200, ok.text);
    return { admin, member };
  }

  test("a manager runs people but not roles; an org admin does both; nobody acts on themselves", async () => {
    const { admin, member } = await orgWithMember("manager");
    const manager = member;
    const asManager = await manager.c.get("/api/org/members");
    assert.equal(asManager.status, 200, "managers open the console");
    const self = await admin.c.get("/api/me");
    const roleByManager = await manager.c.post(`/api/org/members/${encodeURIComponent(self.json.user.id)}/role`, { role: "member" });
    assert.equal(roleByManager.status, 403, "managers hold no org:admin");
    const selfChange = await admin.c.post(`/api/org/members/${encodeURIComponent(self.json.user.id)}/role`, { role: "member" });
    assert.equal(selfChange.status, 400);
    assert.equal(selfChange.json.code, "ORG_SELF_CHANGE");

    const mgrMe = await manager.c.get("/api/me");
    const promote = await admin.c.post(`/api/org/members/${encodeURIComponent(mgrMe.json.user.id)}/role`, { role: "org_admin" });
    assert.equal(promote.status, 200, promote.text);
    const nowAdmin = await manager.c.get("/api/me");
    assert.equal(nowAdmin.json.org.role, "org_admin");

    // Two admins: the first can step down; then the last cannot.
    const demote = await manager.c.post(`/api/org/members/${encodeURIComponent(self.json.user.id)}/role`, { role: "member" });
    assert.equal(demote.status, 200, demote.text);
    const last = await admin.c.get("/api/org");
    assert.equal(last.status, 403, "a member no longer opens the console");
    const leave = await manager.c.post("/api/org/leave");
    assert.equal(leave.status, 400);
    assert.equal(leave.json.code, "ORG_LAST_ADMIN");
  });

  test("suspend → falls back to the personal plan and loses the console; reinstate; remove frees the seat", async () => {
    const { admin, member } = await orgWithMember("manager");
    const mgr = await member.c.get("/api/me");
    const suspend = await admin.c.post(`/api/org/members/${encodeURIComponent(mgr.json.user.id)}/status`, { status: "suspended" });
    assert.equal(suspend.status, 200, suspend.text);
    const suspended = await member.c.get("/api/me");
    assert.equal(suspended.json.org.memberStatus, "suspended");
    assert.equal(suspended.json.plan, "free");
    assert.equal(suspended.json.org.effective, false);
    assert.equal((await member.c.get("/api/org")).status, 403);
    const seats = await admin.c.get("/api/org");
    assert.equal(seats.json.org.seats.used, 1, "a suspended member holds no seat");

    const reinstate = await admin.c.post(`/api/org/members/${encodeURIComponent(mgr.json.user.id)}/status`, { status: "active" });
    assert.equal(reinstate.status, 200);
    assert.equal((await member.c.get("/api/org")).status, 200);

    const remove = await admin.c.del(`/api/org/members/${encodeURIComponent(mgr.json.user.id)}`);
    assert.equal(remove.status, 200, remove.text);
    const gone = await member.c.get("/api/me");
    assert.equal(gone.json.org, null);
    assert.equal(gone.json.plan, "free");
    assert.equal(gone.status, 200, "the account itself is untouched");
    const audit = await admin.c.get("/api/org/audit");
    assert.deepEqual(audit.json.slice(0, 3).map((a) => a.action), ["member.remove", "member.reinstate", "member.suspend"]);

    // Removed: may be invited again, and may now create their own organisation.
    const own = await member.c.post("/api/org", { name: `Own ${uid()}`, segment: "institute" });
    assert.equal(own.status, 201, own.text);
    assert.equal(own.json.kind, "institute");
  });

  test("a member sees their team's exports only through the console: members cannot read the list, CSV or another member", async () => {
    const { admin, member } = await orgWithMember("member");
    assert.equal((await member.c.get("/api/org/members")).status, 403);
    assert.equal((await member.c.get("/api/org/export/members.csv")).status, 403);
    const csv = await admin.c.get("/api/org/export/members.csv");
    assert.equal(csv.status, 200);
    assert.ok(csv.text.includes("Role,Status"));
    const list = await admin.c.get("/api/org/members");
    const other = list.json.members.find((m) => m.role === "member");
    const detail = await admin.c.get(`/api/org/members/${encodeURIComponent(other.userId)}/summary`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.member.userId, other.userId);
    assert.ok(Array.isArray(detail.json.apps));
    const audit = await admin.c.get("/api/org/audit");
    assert.ok(audit.json.some((a) => a.action === "member.view" && a.target.id === other.userId), "reading a member's detail is audited");
    assert.ok(audit.json.some((a) => a.action === "members.export"), "the export is audited");
  });

  test("the console shows a member's activity only while the organisation's plan applied to them", async (t) => {
    const stub = await appsStub();
    if (!stub) return t.skip("no local app stub port");
    try {
      const { admin, member } = await orgWithMember("member");
      const overview0 = await admin.c.get("/api/org");
      if (overview0.json.org.status !== "active") return t.skip("approval queue on");
      const id = (await member.c.get("/api/me")).json.user.id;
      const joinedAt = new Date((await admin.c.get("/api/org/members")).json.members.find((m) => m.userId === id).joinedAt);
      // Time: one area used only before joining today, one after (activity rows are per UTC day and area).
      await appDb((db) =>
        db.query(
          `insert into activity_days (user_id, day, app, area, seconds, first_at, last_at) values
             ($1, (now() at time zone 'utc')::date, 'labs', 'before-joining', 600, $2, $3),
             ($1, (now() at time zone 'utc')::date, 'labs', 'on-the-plan', 300, now(), now())`,
          [id, new Date(joinedAt.getTime() - 2 * 3_600_000), new Date(joinedAt.getTime() - 3_600_000)],
        ),
      );
      const detailUrl = `/api/org/members/${encodeURIComponent(id)}/summary`;
      const detail = await admin.c.get(detailUrl);
      assert.equal(detail.status, 200, detail.text);
      const interview = detail.json.apps.find((a) => a.key === "interview");
      if (!interview?.summary) return t.skip(`InterviewPrep not live in this API's config (${interview?.error ?? interview?.status})`);
      assert.deepEqual(interview.summary.items.map((i) => i.title), ["Mock interview: on the team"], "nothing from before joining");
      assert.deepEqual(interview.summary.stats, [], "no lifetime figures");
      assert.equal(interview.summary.aiUsage, null, "no lifetime AI usage");
      assert.ok(!detail.text.includes("a job elsewhere"));
      assert.deepEqual(detail.json.time.map((r) => [r.area, r.seconds]), [["on-the-plan", 300]]);
      assert.equal(detail.json.member.seconds, 300);
      assert.equal(detail.json.member.lastApp?.area, "on-the-plan");
      const people = await admin.c.get("/api/org/members");
      assert.equal(people.json.members.find((m) => m.userId === id).seconds, 300);
      assert.equal((await admin.c.get("/api/org")).json.usage.seconds, 300, "the organisation's total counts plan time only");

      // While suspended the member is on their personal plan: nothing new shows.
      const statusUrl = `/api/org/members/${encodeURIComponent(id)}/status`;
      assert.equal((await admin.c.post(statusUrl, { status: "suspended" })).status, 200);
      const suspended = await admin.c.get(detailUrl);
      assert.deepEqual(suspended.json.apps.find((a) => a.key === "interview").summary.items, [], "an item dated while suspended is hidden");
      assert.equal((await admin.c.post(statusUrl, { status: "active" })).status, 200);
      const back = await admin.c.get(detailUrl);
      assert.deepEqual(back.json.apps.find((a) => a.key === "interview").summary.items.map((i) => i.title), ["Mock interview: on the team"]);
    } finally {
      stub.close();
    }
  });

  test("a launch while on the organisation's plan is recorded against the organisation", async () => {
    const { admin, member } = await orgWithMember("member");
    const overviewBefore = await admin.c.get("/api/org");
    if (overviewBefore.json.org.status !== "active") return; // approval queue on: launches stay personal until approved
    const launch = await member.c.post("/api/features/simulations/launch");
    assert.equal(launch.status, 201, launch.text);
    const overview = await admin.c.get("/api/org");
    assert.equal(overview.json.usage.launches.find((l) => l.feature === "simulations").count, 1);
    const people = await admin.c.get("/api/org/members");
    const row = people.json.members.find((m) => m.role === "member");
    assert.equal(row.launches.simulations, 1);
  });
});

describe("business accounts: platform admin", () => {
  test("approving a pending organisation starts its trial then: the days it waited are not lost", async () => {
    const admin = await orgWithAdmin();
    const trialMs = new Date(admin.org.entitlement.periodEnd).getTime() - new Date(admin.org.createdAt).getTime();
    const platform = await registerVerified();
    await appDb((db) => db.query("update users set role = 'admin' where email = $1", [platform.email]));
    // As with ORG_APPROVAL_REQUIRED=true, approved only after its trial days have run out.
    await appDb(async (db) => {
      await db.query("update organizations set status = 'pending', approved_at = null where id = $1", [admin.org.id]);
      await db.query("update entitlements set period_end = now() - interval '1 hour' where org_id = $1", [admin.org.id]);
    });
    assert.equal((await admin.c.get("/api/me")).json.org.effective, false);

    const approve = await platform.c.post(`/api/admin/orgs/${admin.org.id}/status`, { status: "active", confirmName: admin.org.name });
    assert.equal(approve.status, 200, approve.text);
    const left = new Date(approve.json.entitlement.periodEnd).getTime() - Date.now();
    assert.ok(Math.abs(left - trialMs) < 5 * 60_000, `a whole trial from approval (${left} ms left, trial ${trialMs} ms)`);
    const me = await admin.c.get("/api/me");
    assert.equal(me.json.org.effective, true, "the approval email's promise holds: the team is on the plan");
    assert.equal(me.json.plan, "business_trial");
    const approved = (await admin.c.get("/api/org/audit")).json.find((r) => r.action === "org.approve");
    assert.ok(approved.detail.trial?.from && approved.detail.trial?.to, "the restart is in the organisation's log");

    // A later period set by hand is never shortened by an approval.
    const far = new Date(Date.now() + 90 * 86_400_000).toISOString();
    await appDb(async (db) => {
      await db.query("update organizations set status = 'pending' where id = $1", [admin.org.id]);
      await db.query("update entitlements set period_end = $2 where org_id = $1", [admin.org.id, far]);
    });
    const again = await platform.c.post(`/api/admin/orgs/${admin.org.id}/status`, { status: "active", confirmName: admin.org.name });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.entitlement.periodEnd, far);
  });

  test("organisations list and detail, manual plan, approval and suspension; the users list shows the account type", async () => {
    const admin = await orgWithAdmin();
    const platform = await registerVerified();
    await appDb((db) => db.query("update users set role = 'admin' where email = $1", [platform.email]));

    const list = await platform.c.get("/api/admin/orgs");
    assert.equal(list.status, 200, list.text);
    const row = list.json.rows.find((r) => r.id === admin.org.id);
    assert.ok(row, "the new organisation is listed");
    assert.equal(row.members, 1);
    assert.equal(row.contact.email, admin.email);

    const detail = await platform.c.get(`/api/admin/orgs/${admin.org.id}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.members[0].role, "org_admin");
    assert.equal(detail.json.audit[0].action, "org.create");

    const wrongName = await platform.c.post(`/api/admin/orgs/${admin.org.id}/plan`, { plan: "business", status: "active", seats: 25, periodEnd: null, aiCapUsd: 50, confirmName: "nope" });
    assert.equal(wrongName.status, 400);
    assert.equal(wrongName.json.code, "ADMIN_CONFIRM_MISMATCH");
    const plan = await platform.c.post(`/api/admin/orgs/${admin.org.id}/plan`, { plan: "business", status: "active", seats: 25, periodEnd: null, aiCapUsd: 50, confirmName: admin.org.name });
    assert.equal(plan.status, 200, plan.text);
    assert.equal(plan.json.entitlement.plan, "business");
    assert.equal(plan.json.entitlement.seats, 25);
    const tooFew = await platform.c.post(`/api/admin/orgs/${admin.org.id}/plan`, { plan: "business", status: "active", seats: 0, periodEnd: null, aiCapUsd: null, confirmName: admin.org.name });
    assert.equal(tooFew.status, 400);

    const seen = await admin.c.get("/api/me");
    if (seen.json.org.status === "active") assert.equal(seen.json.plan, "business");

    const suspend = await platform.c.post(`/api/admin/orgs/${admin.org.id}/status`, { status: "suspended", confirmName: admin.org.name });
    assert.equal(suspend.status, 200, suspend.text);
    const susp = await admin.c.get("/api/me");
    assert.equal(susp.json.org.status, "suspended");
    assert.equal(susp.json.plan, "free", "members of a suspended organisation fall back");
    assert.equal((await admin.c.get("/api/org")).status, 403, "the console is closed while suspended");
    assert.ok(await mailbox(admin.email, "org-status-suspended"), "the org admin is told");

    const reinstate = await platform.c.post(`/api/admin/orgs/${admin.org.id}/status`, { status: "active", confirmName: admin.org.name });
    assert.equal(reinstate.status, 200);
    assert.equal((await admin.c.get("/api/org")).status, 200);

    // The organisation's log shows the platform admin's changes as ThreatReady's, without the staff member's identity.
    const platformId = (await platform.c.get("/api/me")).json.user.id;
    const orgLog = await admin.c.get("/api/org/audit");
    assert.equal(orgLog.status, 200);
    const byStaff = orgLog.json.filter((r) => r.detail?.by === "platform_admin");
    assert.deepEqual(byStaff.map((r) => r.action).sort(), ["org.reinstate", "org.suspend", "plan.set"]);
    for (const r of byStaff) assert.deepEqual(r.actor, { id: null, email: null }, r.action);
    assert.ok(!orgLog.text.includes(platform.email) && !orgLog.text.includes(platformId), "no staff email or id anywhere in the organisation's log");
    const staffView = await platform.c.get(`/api/admin/orgs/${admin.org.id}`);
    assert.equal(staffView.json.audit.find((r) => r.action === "plan.set").actor.email, platform.email, "the platform admin's own view keeps who did it");

    // The platform's append-only trail has every change too (and the reads), with who did it.
    const trail = await appDb(async (db) => (await db.query("select action, actor_email, detail from admin_audit_log where detail->>'orgId' = $1 and action <> 'org.view' order by id", [admin.org.id])).rows);
    assert.deepEqual(trail.map((r) => [r.action, r.detail.to?.status ?? r.detail.to]), [["org.plan", "active"], ["org.status", "suspended"], ["org.status", "active"]]);
    assert.ok(trail.every((r) => r.actor_email === platform.email && r.detail.name === admin.org.name));
    assert.deepEqual(trail[0].detail.to, { plan: "business", status: "active", seats: 25, periodEnd: null, aiCapUsd: 50 });

    const users = await platform.c.get(`/api/admin/users?q=${encodeURIComponent(admin.email)}`);
    assert.equal(users.status, 200);
    const u = users.json.rows.find((r) => r.email === admin.email);
    assert.equal(u.account.type, "organisation");
    assert.equal(u.account.org.name, admin.org.name);
    assert.equal(u.account.org.role, "org_admin");
    const onlyOrgs = await platform.c.get(`/api/admin/users?account=organisation`);
    assert.ok(onlyOrgs.json.rows.every((r) => r.account.type === "organisation"));

    const overview = await platform.c.get("/api/admin/overview");
    assert.equal(overview.status, 200);
    assert.ok(overview.json.organisations.total >= 1);
    assert.ok(overview.json.users.organisationMembers >= 1);
    assert.equal(overview.json.users.individuals, overview.json.users.total - overview.json.users.organisationMembers);

    // Org admins cannot reach the platform routes; cross-origin writes are refused.
    assert.equal((await admin.c.get("/api/admin/orgs")).status, 403);
    const cross = await platform.c.post(`/api/admin/orgs/${admin.org.id}/status`, { status: "suspended", confirmName: admin.org.name }, { origin: "https://evil.example" });
    assert.equal(cross.status, 403);
  });
});
