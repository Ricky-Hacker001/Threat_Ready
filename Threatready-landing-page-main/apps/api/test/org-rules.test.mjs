/**
 * The business-account rules as pure decisions (org-rules.ts), without a database.
 * Runs against the compiled output: node --test test/org-rules.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INVITE_TOKEN_SHAPE,
  hashInviteToken,
  invitationState,
  maskEmail,
  newInviteToken,
  planAccept,
  planInvites,
  planLeave,
  planRemoval,
  planRoleChange,
  planStatusChange,
  seatSummary,
} from "../dist/org/org-rules.js";
import { effectiveTenant, orgPlanApplies } from "../dist/tenancy/tenancy.js";

const DAY = 86_400_000;

test("seats: active members and pending invitations both hold seats; never negative", () => {
  assert.deepEqual(seatSummary(5, 1, 0), { purchased: 5, used: 1, pending: 0, available: 4 });
  assert.deepEqual(seatSummary(5, 3, 2), { purchased: 5, used: 3, pending: 2, available: 0 });
  assert.deepEqual(seatSummary(2, 3, 1), { purchased: 2, used: 3, pending: 1, available: 0 });
});

test("invite tokens: 43-character base64url, stored as a SHA-256, email masked", () => {
  const { token, hash } = newInviteToken();
  assert.match(token, INVITE_TOKEN_SHAPE);
  assert.equal(hash, hashInviteToken(token));
  assert.equal(hash.length, 64);
  assert.notEqual(newInviteToken().token, token);
  assert.equal(maskEmail("priya.k@example.com"), "pr***@example.com".replace("***", "*****"));
  assert.ok(!maskEmail("priya.k@example.com").includes("priya"));
  assert.equal(maskEmail("a@x.io"), "a***@x.io");
});

test("invitation state: accepted beats revoked beats expired beats valid", () => {
  const now = new Date();
  const soon = new Date(now.getTime() + DAY);
  const past = new Date(now.getTime() - DAY);
  assert.equal(invitationState({ expiresAt: soon, acceptedAt: null, revokedAt: null }, now), "valid");
  assert.equal(invitationState({ expiresAt: past, acceptedAt: null, revokedAt: null }, now), "expired");
  assert.equal(invitationState({ expiresAt: past, acceptedAt: null, revokedAt: now }, now), "revoked");
  assert.equal(invitationState({ expiresAt: past, acceptedAt: now, revokedAt: now }, now), "accepted");
});

test("accepting: the invited address, verified, not a guest, not already in an organisation, a seat free", () => {
  const base = { state: "valid", invitedEmail: "a@x.io", accountEmail: "a@x.io", accountVerified: true, accountIsTrial: false, existingOrgId: null, invitationOrgId: "org1", orgStatus: "active", seatsAvailable: 1 };
  assert.deepEqual(planAccept(base), { ok: true });
  assert.equal(planAccept({ ...base, accountEmail: "b@x.io" }).code, "INVITE_EMAIL_MISMATCH");
  assert.equal(planAccept({ ...base, accountEmail: "A@X.IO" }).code, "INVITE_EMAIL_MISMATCH", "the service lower-cases; the rule compares exactly");
  assert.equal(planAccept({ ...base, accountVerified: false }).code, "INVITE_EMAIL_UNVERIFIED");
  assert.equal(planAccept({ ...base, accountIsTrial: true }).code, "INVITE_ACCOUNT_REQUIRED");
  assert.equal(planAccept({ ...base, state: "expired" }).status, 410);
  assert.equal(planAccept({ ...base, state: "accepted" }).code, "INVITE_USED");
  assert.equal(planAccept({ ...base, state: "revoked" }).code, "INVITE_REVOKED");
  assert.equal(planAccept({ ...base, existingOrgId: "org1" }).code, "INVITE_ALREADY_MEMBER");
  assert.equal(planAccept({ ...base, existingOrgId: "org2" }).code, "INVITE_OTHER_ORG");
  assert.equal(planAccept({ ...base, orgStatus: "suspended" }).code, "ORG_SUSPENDED");
  assert.equal(planAccept({ ...base, orgStatus: "pending" }).ok, true, "a pending organisation can still gather its people");
  assert.equal(planAccept({ ...base, seatsAvailable: 0 }).code, "ORG_NO_SEATS");
});

test("roles: only org admins change roles, never their own; the last admin stays", () => {
  const admin = { userId: "a", role: "org_admin" };
  const facts = (target, activeAdmins = 1, actor = admin) => ({ actor, target, activeAdmins });
  assert.deepEqual(planRoleChange(facts({ userId: "m", role: "member", status: "active" }), "manager"), { ok: true });
  assert.equal(planRoleChange(facts({ userId: "a", role: "org_admin", status: "active" }), "member").code, "ORG_SELF_CHANGE");
  assert.equal(planRoleChange(facts({ userId: "m", role: "member", status: "active" }, 1, { userId: "x", role: "manager" }), "manager").code, "FORBIDDEN");
  assert.equal(planRoleChange(facts({ userId: "m", role: "member", status: "active" }), "member").code, "ORG_ROLE_SAME");
  assert.equal(planRoleChange(facts({ userId: "b", role: "org_admin", status: "active" }, 1), "member").code, "ORG_LAST_ADMIN");
  assert.deepEqual(planRoleChange(facts({ userId: "b", role: "org_admin", status: "active" }, 2), "member"), { ok: true });
});

test("status and removal: managers act on members only; the last active admin cannot be suspended or removed", () => {
  const mgr = { userId: "g", role: "manager" };
  const admin = { userId: "a", role: "org_admin" };
  const member = { userId: "m", role: "member", status: "active" };
  const otherAdmin = { userId: "b", role: "org_admin", status: "active" };
  assert.deepEqual(planStatusChange({ actor: mgr, target: member, activeAdmins: 1 }, "suspended"), { ok: true });
  assert.equal(planStatusChange({ actor: mgr, target: otherAdmin, activeAdmins: 2 }, "suspended").code, "ORG_MANAGER_SCOPE");
  assert.equal(planStatusChange({ actor: admin, target: member, activeAdmins: 1 }, "active").code, "ORG_STATUS_SAME");
  assert.equal(planStatusChange({ actor: admin, target: otherAdmin, activeAdmins: 1 }, "suspended").code, "ORG_LAST_ADMIN");
  assert.deepEqual(planStatusChange({ actor: admin, target: otherAdmin, activeAdmins: 2 }, "suspended"), { ok: true });
  assert.deepEqual(planRemoval({ actor: mgr, target: member, activeAdmins: 1 }), { ok: true });
  assert.equal(planRemoval({ actor: mgr, target: { ...member, role: "manager" }, activeAdmins: 1 }).code, "ORG_MANAGER_SCOPE");
  assert.equal(planRemoval({ actor: admin, target: otherAdmin, activeAdmins: 1 }).code, "ORG_LAST_ADMIN");
  assert.equal(planRemoval({ actor: admin, target: admin.userId === "a" ? { userId: "a", role: "org_admin", status: "active" } : member, activeAdmins: 3 }).code, "ORG_SELF_CHANGE");
  assert.equal(planLeave({ role: "org_admin", status: "active" }, 1).code, "ORG_LAST_ADMIN");
  assert.deepEqual(planLeave({ role: "org_admin", status: "active" }, 2), { ok: true });
  assert.deepEqual(planLeave({ role: "member", status: "active" }, 1), { ok: true });
});

test("inviting: duplicates once, the inviter and existing people skipped, seats taken in order", () => {
  const r = planInvites(["A@x.io", "a@x.io", "me@x.io", "member@x.io", "open@x.io", "bad", "b@x.io", "c@x.io"], {
    selfEmail: "me@x.io",
    memberEmails: new Set(["member@x.io"]),
    openInviteEmails: new Set(["open@x.io"]),
    seatsAvailable: 2,
    valid: (e) => /^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(e),
  });
  assert.deepEqual(r.send, ["a@x.io", "b@x.io"]);
  assert.deepEqual(r.skipped, [
    { email: "me@x.io", reason: "self" },
    { email: "member@x.io", reason: "already_member" },
    { email: "open@x.io", reason: "already_invited" },
    { email: "bad", reason: "invalid" },
    { email: "c@x.io", reason: "no_seats" },
  ]);
});

test("the organisation's plan applies only while the organisation, the member and the plan are live", () => {
  const now = new Date();
  const live = { orgStatus: "active", memberStatus: "active", planStatus: "trialing", periodEnd: new Date(now.getTime() + DAY) };
  assert.equal(orgPlanApplies(live, now), true);
  assert.equal(orgPlanApplies({ ...live, planStatus: "active", periodEnd: null }, now), true);
  assert.equal(orgPlanApplies({ ...live, orgStatus: "pending" }, now), false);
  assert.equal(orgPlanApplies({ ...live, orgStatus: "suspended" }, now), false);
  assert.equal(orgPlanApplies({ ...live, memberStatus: "suspended" }, now), false);
  assert.equal(orgPlanApplies({ ...live, planStatus: "past_due" }, now), false);
  assert.equal(orgPlanApplies({ ...live, planStatus: "cancelled" }, now), false);
  assert.equal(orgPlanApplies({ ...live, periodEnd: new Date(now.getTime() - 1) }, now), false);
  const personal = { orgId: "p", role: "learner", plan: "free" };
  assert.deepEqual(effectiveTenant(personal, { ...live, orgId: "o", plan: "business" }, now), { orgId: "o", plan: "business" });
  assert.deepEqual(effectiveTenant(personal, { ...live, orgId: "o", plan: "business", orgStatus: "pending" }, now), { orgId: "p", plan: "free" });
  assert.deepEqual(effectiveTenant(personal, null, now), { orgId: "p", plan: "free" });
});
