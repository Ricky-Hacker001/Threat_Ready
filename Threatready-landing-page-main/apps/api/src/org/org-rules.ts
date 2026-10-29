import type { MemberStatus, OrgRole, OrgSummary } from "@threatready/contracts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The rules of a business account as pure decisions (no database), so they can be unit-tested the
 * way role-change.ts is. OrgService gathers the facts and applies the plan in one transaction.
 */

/* ---------------- Seats ---------------- */

export function seatSummary(purchased: number, activeMembers: number, pendingInvites: number): OrgSummary["seats"] {
  return { purchased, used: activeMembers, pending: pendingInvites, available: Math.max(0, purchased - activeMembers - pendingInvites) };
}

/* ---------------- Invitation tokens ---------------- */

/** 32 random bytes, base64url: the only copy is in the email; the database keeps its SHA-256. */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A token as it arrives on the URL: base64url of 32 bytes, nothing else is even looked up. */
export const INVITE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "a***@example.com": enough for the invitee to recognise the address, not enough for anyone else to learn it. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(3, Math.min(6, local.length - shown.length)))}@${domain}`;
}

export type InvitationState = "valid" | "expired" | "revoked" | "accepted";

export function invitationState(row: { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }, now = new Date()): InvitationState {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "valid";
}

/* ---------------- Accepting ---------------- */

export interface AcceptFacts {
  state: InvitationState;
  /** The invited address and the accepting account's address, both lower-cased. */
  invitedEmail: string;
  accountEmail: string | null;
  accountVerified: boolean;
  accountIsTrial: boolean;
  /** The accepting account's organisation membership, if it already has one (one per user in phase 1). */
  existingOrgId: string | null;
  invitationOrgId: string;
  orgStatus: "pending" | "active" | "suspended";
  seatsAvailable: number;
}

export type AcceptPlan = { ok: true } | { ok: false; status: 400 | 403 | 409 | 410; code: string; message: string };

const refuse = (status: 400 | 403 | 409 | 410, code: string, message: string): AcceptPlan => ({ ok: false, status, code, message });

export function planAccept(f: AcceptFacts): AcceptPlan {
  if (f.state === "accepted") return refuse(410, "INVITE_USED", "This invitation has already been used.");
  if (f.state === "revoked") return refuse(410, "INVITE_REVOKED", "This invitation was withdrawn. Ask your organisation's admin for a new one.");
  if (f.state === "expired") return refuse(410, "INVITE_EXPIRED", "This invitation has expired. Ask your organisation's admin to send a new one.");
  if (f.accountIsTrial) return refuse(403, "INVITE_ACCOUNT_REQUIRED", "Create an account with the invited email address to join.");
  if (!f.accountEmail || f.accountEmail !== f.invitedEmail) {
    return refuse(403, "INVITE_EMAIL_MISMATCH", "This invitation was sent to a different email address. Sign in with that address, or ask for an invitation to this one.");
  }
  if (!f.accountVerified) return refuse(403, "INVITE_EMAIL_UNVERIFIED", "Verify your email address, then open the invitation again.");
  if (f.existingOrgId && f.existingOrgId === f.invitationOrgId) return refuse(409, "INVITE_ALREADY_MEMBER", "You're already a member of this organisation.");
  if (f.existingOrgId) return refuse(409, "INVITE_OTHER_ORG", "You already belong to another organisation. Leave it first, or ask its admin to remove you.");
  if (f.orgStatus === "suspended") return refuse(403, "ORG_SUSPENDED", "This organisation is suspended. Ask its admin to contact ThreatReady.");
  if (f.seatsAvailable <= 0) return refuse(409, "ORG_NO_SEATS", "This organisation has no free seats. Ask its admin to add seats or remove someone.");
  return { ok: true };
}

/* ---------------- Members: role, status, removal, leaving ---------------- */

export interface MemberChangeFacts {
  actor: { userId: string; role: OrgRole };
  target: { userId: string; role: OrgRole; status: MemberStatus };
  /** Active org admins in the organisation right now. */
  activeAdmins: number;
}

export type ChangePlan = { ok: true } | { ok: false; status: 400 | 403 | 409; code: string; message: string };
const no = (status: 400 | 403 | 409, code: string, message: string): ChangePlan => ({ ok: false, status, code, message });

/** Who may act on whom: org admins on anyone but themselves; managers on members only. */
function mayAct(f: MemberChangeFacts, what: string): ChangePlan {
  if (f.actor.userId === f.target.userId) return no(400, "ORG_SELF_CHANGE", `You can't ${what} yourself. Ask another admin.`);
  if (f.actor.role === "manager" && f.target.role !== "member") return no(403, "ORG_MANAGER_SCOPE", `Managers can ${what} members only. Ask an organisation admin.`);
  if (f.actor.role === "member") return no(403, "FORBIDDEN", "Forbidden");
  return { ok: true };
}

/** The last active org admin can neither be demoted, suspended nor removed. */
function keepsAnAdmin(f: MemberChangeFacts): ChangePlan {
  if (f.target.role === "org_admin" && f.target.status === "active" && f.activeAdmins <= 1) {
    return no(400, "ORG_LAST_ADMIN", "This is the organisation's last admin. Make someone else an admin first.");
  }
  return { ok: true };
}

export function planRoleChange(f: MemberChangeFacts, requested: OrgRole): ChangePlan {
  if (f.actor.role !== "org_admin") return no(403, "FORBIDDEN", "Only an organisation admin can change roles.");
  const act = mayAct(f, "change the role of");
  if (!act.ok) return act;
  if (f.target.role === requested) return no(409, "ORG_ROLE_SAME", "This person already has that role.");
  if (requested !== "org_admin") {
    const keep = keepsAnAdmin(f);
    if (!keep.ok) return keep;
  }
  return { ok: true };
}

export function planStatusChange(f: MemberChangeFacts, requested: MemberStatus): ChangePlan {
  const act = mayAct(f, requested === "suspended" ? "suspend" : "reinstate");
  if (!act.ok) return act;
  if (f.target.status === requested) return no(409, "ORG_STATUS_SAME", requested === "suspended" ? "This person is already suspended." : "This person is already active.");
  if (requested === "suspended") {
    const keep = keepsAnAdmin(f);
    if (!keep.ok) return keep;
  }
  return { ok: true };
}

export function planRemoval(f: MemberChangeFacts): ChangePlan {
  const act = mayAct(f, "remove");
  if (!act.ok) return act;
  return keepsAnAdmin(f);
}

/** Leaving on one's own: anyone may, except the last active org admin (hand over first). */
export function planLeave(self: { role: OrgRole; status: MemberStatus }, activeAdmins: number): ChangePlan {
  if (self.role === "org_admin" && self.status === "active" && activeAdmins <= 1) {
    return no(400, "ORG_LAST_ADMIN", "You're the organisation's last admin. Make someone else an admin before leaving.");
  }
  return { ok: true };
}

/* ---------------- Inviting ---------------- */

export type SkipReason = "already_member" | "already_invited" | "no_seats" | "invalid" | "self";

/**
 * Which addresses of a batch get an invitation. Duplicates in the batch count once; seats are taken
 * in the order given; the caller's own address is skipped (they are already in).
 */
export function planInvites(
  emails: string[],
  facts: { selfEmail: string | null; memberEmails: ReadonlySet<string>; openInviteEmails: ReadonlySet<string>; seatsAvailable: number; valid: (email: string) => boolean },
): { send: string[]; skipped: { email: string; reason: SkipReason }[] } {
  const send: string[] = [];
  const skipped: { email: string; reason: SkipReason }[] = [];
  const seen = new Set<string>();
  let seats = facts.seatsAvailable;
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    if (!facts.valid(email)) skipped.push({ email, reason: "invalid" });
    else if (facts.selfEmail && email === facts.selfEmail) skipped.push({ email, reason: "self" });
    else if (facts.memberEmails.has(email)) skipped.push({ email, reason: "already_member" });
    else if (facts.openInviteEmails.has(email)) skipped.push({ email, reason: "already_invited" });
    else if (seats <= 0) skipped.push({ email, reason: "no_seats" });
    else {
      seats -= 1;
      send.push(email);
    }
  }
  return { send, skipped };
}
