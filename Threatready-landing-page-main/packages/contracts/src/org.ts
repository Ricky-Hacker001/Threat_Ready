import { z } from "zod";
import type { AiUsageTotals, AppKey, OverviewApp } from "./platform.js";

/* ------------------------------------------------------------------ */
/* Business accounts (organisations): an organisation owns seats, a    */
/* plan and the people it invites. Shared by the onboard API (which    */
/* enforces) and the SPA (which only shows). Design: business-accounts */
/* plan, 28 Oct 2026.                                                  */
/* ------------------------------------------------------------------ */

export const ORG_NAME_MIN = 2;
export const ORG_NAME_MAX = 80;
/** Invites per request; the per-day cap is server configuration (ORG_INVITES_PER_DAY). */
export const ORG_INVITE_BATCH_MAX = 50;

export const orgSegmentSchema = z.enum(["business", "institute"]);
export type OrgSegment = z.infer<typeof orgSegmentSchema>;

/** Roles inside an organisation. Members use the product; managers run people and reports; org admins also own settings and roles. */
export const orgRoleSchema = z.enum(["org_admin", "manager", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const orgStatusSchema = z.enum(["pending", "active", "suspended"]);
export type OrgStatus = z.infer<typeof orgStatusSchema>;

export const memberStatusSchema = z.enum(["active", "suspended"]);
export type MemberStatus = z.infer<typeof memberStatusSchema>;

export const orgPlanSchema = z.enum(["business_trial", "business"]);
export type OrgPlan = z.infer<typeof orgPlanSchema>;

export const planStatusSchema = z.enum(["trialing", "active", "past_due", "suspended", "cancelled"]);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const orgNameSchema = z
  .string()
  .trim()
  .min(ORG_NAME_MIN, `Organisation name must be at least ${ORG_NAME_MIN} characters`)
  .max(ORG_NAME_MAX, `Organisation name must be at most ${ORG_NAME_MAX} characters`)
  // Letters, digits, spaces and common punctuation; no control characters or markup.
  .regex(/^[\p{L}\p{N} .,&'()\-_/]+$/u, "Use letters, numbers, spaces and basic punctuation");

/** `POST /api/org`: create the organisation the caller will administer. */
export const orgCreateSchema = z.object({
  name: orgNameSchema,
  segment: orgSegmentSchema.default("business"),
});
export type OrgCreate = z.infer<typeof orgCreateSchema>;

/** `PATCH /api/org` */
export const orgUpdateSchema = z.object({
  name: orgNameSchema,
});
export type OrgUpdate = z.infer<typeof orgUpdateSchema>;

/** `POST /api/org/invitations`: one role for the whole batch. Entries are checked one by one server-side (a bad address is reported as skipped, not refused as a whole). */
export const orgInviteCreateSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().max(254)).min(1).max(ORG_INVITE_BATCH_MAX),
  role: z.enum(["member", "manager"]).default("member"),
});
export type OrgInviteCreate = z.infer<typeof orgInviteCreateSchema>;

/** `POST /api/org/members/:userId/role` */
export const orgMemberRoleSchema = z.object({ role: orgRoleSchema });
export type OrgMemberRole = z.infer<typeof orgMemberRoleSchema>;

/** `POST /api/org/members/:userId/status` */
export const orgMemberStatusSchema = z.object({ status: memberStatusSchema });
export type OrgMemberStatusChange = z.infer<typeof orgMemberStatusSchema>;

export interface OrgEntitlement {
  plan: OrgPlan;
  status: PlanStatus;
  seats: number;
  periodEnd: string | null;
  /** Monthly AI budget the platform admin set for the organisation (USD); null = the plan's default. Informational until the apps enforce it. */
  aiCapUsd: number | null;
}

export interface OrgSummary {
  id: string;
  name: string;
  kind: "business" | "institute";
  segment: OrgSegment;
  status: OrgStatus;
  createdAt: string;
  /** Set when a platform admin approved the organisation (or null when self-serve). */
  approvedAt: string | null;
  entitlement: OrgEntitlement;
  seats: {
    purchased: number;
    /** Active members (every role) */
    used: number;
    /** Pending invitations hold a seat until accepted, expired or revoked */
    pending: number;
    available: number;
  };
}

export interface OrgUsageMonth {
  /** UTC month start, ISO */
  since: string;
  launches: { feature: "interview" | "simulations" | "reasoning"; count: number }[];
  /** Members with a sign-in session updated in the last 7 days */
  activeMembers7d: number;
  /** Seconds of measured active use by members this month, across apps */
  seconds: number;
}

/** `GET /api/org` */
export interface OrgOverview {
  org: OrgSummary;
  /** The caller's role */
  role: OrgRole;
  usage: OrgUsageMonth;
  /** Things an admin should look at: expiring invites, seats about to run out, trial ending. */
  attention: { kind: "invites_expiring" | "seats_low" | "trial_ending" | "plan_past_due" | "pending_approval"; message: string }[];
}

export interface OrgMemberRow {
  userId: string;
  name: string;
  email: string | null;
  username: string | null;
  emailVerified: boolean;
  role: OrgRole;
  status: MemberStatus;
  joinedAt: string;
  lastSeenAt: string | null;
  /** Launches by feature this UTC month, counted against this organisation */
  launches: Partial<Record<"interview" | "simulations" | "reasoning", number>>;
  /** Seconds of measured active use this month */
  seconds: number;
  /** Where they were last active */
  lastApp: { app: string; area: string; at: string } | null;
}

export interface OrgInvitationRow {
  id: string;
  email: string;
  role: "member" | "manager";
  invitedBy: { id: string | null; name: string | null };
  createdAt: string;
  expiresAt: string;
  state: "pending" | "expired";
}

/** `GET /api/org/members` */
export interface OrgMemberList {
  members: OrgMemberRow[];
  invitations: OrgInvitationRow[];
}

/** `POST /api/org/invitations` result: what was sent and what was skipped, per address. */
export interface OrgInviteResult {
  sent: { email: string; id: string; expiresAt: string }[];
  skipped: { email: string; reason: "already_member" | "already_invited" | "no_seats" | "invalid" | "self" }[];
  seats: OrgSummary["seats"];
}

/** `GET /api/invitations/:token`: what the invite page can show before the person signs in. Never the full email. */
export interface InvitationPreview {
  state: "valid" | "expired" | "revoked" | "accepted";
  org: { name: string; segment: OrgSegment };
  role: "member" | "manager";
  /** "a***@example.com" */
  emailHint: string;
  invitedBy: string | null;
  expiresAt: string;
}

/** `POST /api/invitations/:token/accept` */
export interface InvitationAcceptResult {
  org: { id: string; name: string };
  role: "member" | "manager";
}

export interface OrgAuditRow {
  id: number;
  at: string;
  action: string;
  actor: { id: string | null; email: string | null };
  target: { id: string | null; email: string | null };
  detail: Record<string, unknown>;
}

/** `GET /api/org/members/:userId/summary`: one member's progress in every app, as the apps report it. */
export interface OrgMemberDetail {
  member: OrgMemberRow;
  apps: OverviewApp[];
  /** Seconds this month by app and area */
  time: { app: string; area: string; seconds: number; lastAt: string }[];
}

/* ---------------- Platform admin ---------------- */

export interface AdminOrgRow {
  id: string;
  name: string;
  kind: "business" | "institute";
  segment: OrgSegment;
  status: OrgStatus;
  createdAt: string;
  approvedAt: string | null;
  entitlement: OrgEntitlement;
  members: number;
  admins: number;
  pendingInvites: number;
  /** The first org admin (who created it) */
  contact: { id: string | null; name: string | null; email: string | null };
  /** Launches by members this month, counted against the organisation */
  launchesThisMonth: number;
  /** Seconds of measured use in the console's range */
  seconds: number;
  /** Members' AI usage in the console's range (each member's own ledger rows, summed) */
  ai: AiUsageTotals;
  aiByApp: Partial<Record<AppKey, AiUsageTotals>>;
}

export interface AdminOrgList {
  range: { from: string; to: string };
  total: number;
  pending: number;
  rows: AdminOrgRow[];
  unavailable: { app: AppKey; error: string }[];
}

export interface AdminOrgMember extends OrgMemberRow {
  ai: AiUsageTotals;
}

export interface AdminOrgDetail {
  range: { from: string; to: string };
  org: AdminOrgRow;
  members: AdminOrgMember[];
  invitations: OrgInvitationRow[];
  audit: OrgAuditRow[];
}

/** `POST /api/admin/orgs/:id/plan`: the platform admin sets the plan by hand (billing is a later phase). The caller retypes the organisation name. */
export const adminOrgPlanSchema = z.object({
  plan: orgPlanSchema,
  status: planStatusSchema,
  seats: z.number().int().min(1).max(5000),
  /** ISO date-time or null for open-ended */
  periodEnd: z.iso.datetime({ offset: true }).nullable(),
  aiCapUsd: z.number().min(0).max(100_000).nullable(),
  confirmName: z.string().trim().max(ORG_NAME_MAX),
});
export type AdminOrgPlan = z.infer<typeof adminOrgPlanSchema>;

/** `POST /api/admin/orgs/:id/status`: approve a pending organisation, suspend or reinstate one. */
export const adminOrgStatusSchema = z.object({
  status: orgStatusSchema,
  confirmName: z.string().trim().max(ORG_NAME_MAX),
});
export type AdminOrgStatus = z.infer<typeof adminOrgStatusSchema>;

/** How a user is accounted for in the admin console: an individual on the free plan or a member of an organisation. */
export interface AdminUserAccount {
  type: "individual" | "organisation";
  org: { id: string; name: string; role: OrgRole; status: MemberStatus } | null;
}
