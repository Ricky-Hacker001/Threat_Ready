/** Rules for promoting/demoting platform admins (admin/role-change.ts). Runs against dist: node --test test/role-change.test.mjs */
import assert from "node:assert/strict";
import { test } from "node:test";
import { planRoleChange } from "../dist/admin/role-change.js";

const target = (over = {}) => ({ id: "u2", email: "bob@example.com", role: "user", emailVerified: true, isAnonymous: false, envListed: false, ...over });
const facts = (over = {}) => ({ actor: { userId: "u1" }, target: target(), requested: "admin", confirmEmail: "bob@example.com", adminCount: 2, ...over });

test("promotes a verified, non-trial user", () => {
  assert.deepEqual(planRoleChange(facts()), { ok: true, action: "role.promote", signOut: false });
});
test("refuses to change your own role", () => {
  const r = planRoleChange(facts({ target: target({ id: "u1" }) }));
  assert.equal(r.ok, false); assert.equal(r.code, "ADMIN_SELF_CHANGE");
});
test("refuses trial accounts", () => {
  const r = planRoleChange(facts({ target: target({ isAnonymous: true }) }));
  assert.equal(r.ok, false); assert.equal(r.code, "ADMIN_TARGET_TRIAL");
});
test("refuses when the retyped email does not match (case-insensitive match passes)", () => {
  assert.equal(planRoleChange(facts({ confirmEmail: "alice@example.com" })).code, "ADMIN_CONFIRM_MISMATCH");
  assert.equal(planRoleChange(facts({ target: target({ email: "Bob@Example.com" }) })).ok, true);
});
test("refuses to promote an unverified email", () => {
  assert.equal(planRoleChange(facts({ target: target({ emailVerified: false }) })).code, "ADMIN_TARGET_UNVERIFIED");
});
test("promote is a no-op conflict when already admin by role or by ADMIN_EMAILS", () => {
  assert.equal(planRoleChange(facts({ target: target({ role: "admin" }) })).status, 409);
  assert.equal(planRoleChange(facts({ target: target({ envListed: true }) })).status, 409);
});
test("demotes a role admin and signs them out", () => {
  assert.deepEqual(planRoleChange(facts({ requested: "user", target: target({ role: "admin" }) })), { ok: true, action: "role.demote", signOut: true });
});
test("cannot demote the last admin", () => {
  const r = planRoleChange(facts({ requested: "user", target: target({ role: "admin" }), adminCount: 1 }));
  assert.equal(r.ok, false); assert.equal(r.code, "ADMIN_LAST_ADMIN");
});
test("cannot demote an ADMIN_EMAILS admin from the console", () => {
  const r = planRoleChange(facts({ requested: "user", target: target({ role: "admin", envListed: true }) }));
  assert.equal(r.ok, false); assert.equal(r.code, "ADMIN_ENV_LISTED");
});
test("demoting a non-admin is a conflict", () => {
  assert.equal(planRoleChange(facts({ requested: "user" })).code, "ADMIN_NOT_ADMIN");
});
