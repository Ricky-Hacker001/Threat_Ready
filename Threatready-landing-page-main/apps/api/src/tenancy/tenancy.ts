import type { MemberStatus, OrgContext, OrgPlan, OrgRole, OrgStatus, Plan, PlanStatus } from "@threatready/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/db.js";
import { entitlements, memberships, organizations } from "../db/schema.js";

export type PersonalRole = "learner" | "trial";

/** Membership roles that make a user part of an organisation (business or institute account). */
export const ORG_ROLES: readonly OrgRole[] = ["org_admin", "manager", "member"];
export const isOrgRole = (role: string): role is OrgRole => (ORG_ROLES as readonly string[]).includes(role);

/**
 * Every user gets a personal organisation with one membership and one
 * entitlement row (ADD L7 step 2). Idempotent: safe to call twice, and safe to
 * call in parallel (the sign-up hook and the AuthGuard self-heal can race): a
 * per-user advisory lock serialises the check and the insert, and the unique
 * index memberships_personal_user_uidx (migration 0008) backs it up.
 */
export async function ensurePersonalWorkspace(db: Db, userId: string, role: PersonalRole): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`personal-ws:${userId}`}, 0))`);
    const existing = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), sql`${memberships.role} in ('learner', 'trial')`))
      .limit(1);
    if (existing.length > 0) return;

    const [org] = await tx
      .insert(organizations)
      .values({ name: role === "trial" ? "Trial workspace" : "Personal workspace", kind: "personal" })
      .returning({ id: organizations.id });
    if (!org) throw new Error("failed to create organisation");

    await tx.insert(memberships).values({ orgId: org.id, userId, role });
    await tx.insert(entitlements).values({ orgId: org.id, plan: role === "trial" ? "trial" : "free" });
  });
}

export interface Membership {
  orgId: string;
  role: PersonalRole;
  plan: "trial" | "free";
}

/** Personal membership for the principal. Never read from the request body. */
export async function findPersonalMembership(db: Db, userId: string): Promise<Membership | null> {
  const rows = await db
    .select({ orgId: memberships.orgId, role: memberships.role, plan: entitlements.plan })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .innerJoin(entitlements, eq(entitlements.orgId, memberships.orgId))
    .where(and(eq(memberships.userId, userId), sql`${memberships.role} in ('learner', 'trial')`))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.role !== "learner" && row.role !== "trial") return null;
  if (row.plan !== "free" && row.plan !== "trial") return null;
  return { orgId: row.orgId, role: row.role, plan: row.plan };
}

/** The organisation membership as stored, before any decision about whether its plan applies. */
export interface OrgMembership {
  orgId: string;
  name: string;
  kind: "business" | "institute";
  segment: "business" | "institute";
  orgStatus: OrgStatus;
  role: OrgRole;
  memberStatus: MemberStatus;
  plan: OrgPlan;
  planStatus: PlanStatus;
  seats: number;
  periodEnd: Date | null;
}

/** The one organisation (business or institute account) the user belongs to, if any (one per user in phase 1). */
export async function findOrgMembership(db: Db, userId: string): Promise<OrgMembership | null> {
  const rows = await db
    .select({
      orgId: memberships.orgId,
      role: memberships.role,
      memberStatus: memberships.status,
      name: organizations.name,
      kind: organizations.kind,
      segment: organizations.segment,
      orgStatus: organizations.status,
      plan: entitlements.plan,
      planStatus: entitlements.status,
      seats: entitlements.seats,
      periodEnd: entitlements.periodEnd,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .innerJoin(entitlements, eq(entitlements.orgId, memberships.orgId))
    .where(and(eq(memberships.userId, userId), sql`${memberships.role} in ('org_admin', 'manager', 'member')`, sql`${organizations.kind} <> 'personal'`))
    .limit(1);
  const r = rows[0];
  if (!r || !isOrgRole(r.role)) return null;
  const kind = r.kind === "institute" ? "institute" : "business";
  return {
    orgId: r.orgId,
    name: r.name,
    kind,
    segment: r.segment === "institute" ? "institute" : kind === "institute" ? "institute" : "business",
    orgStatus: r.orgStatus as OrgStatus,
    role: r.role,
    memberStatus: r.memberStatus as MemberStatus,
    plan: r.plan === "business" ? "business" : "business_trial",
    planStatus: r.planStatus as PlanStatus,
    seats: r.seats,
    periodEnd: r.periodEnd,
  };
}

/**
 * Whether launches count against the organisation's plan right now: the organisation is active (not
 * pending approval or suspended), the member is active, the plan is live (trialing or active; past_due
 * is read-only on the organisation side) and the period has not ended. Otherwise the user is served
 * from their personal workspace and plan, and the console says why.
 */
export function orgPlanApplies(m: Pick<OrgMembership, "orgStatus" | "memberStatus" | "planStatus" | "periodEnd">, now = new Date()): boolean {
  if (m.orgStatus !== "active") return false;
  if (m.memberStatus !== "active") return false;
  if (m.planStatus !== "trialing" && m.planStatus !== "active") return false;
  if (m.periodEnd && m.periodEnd.getTime() <= now.getTime()) return false;
  return true;
}

export function toOrgContext(m: OrgMembership, now = new Date()): OrgContext {
  return {
    id: m.orgId,
    name: m.name,
    kind: m.kind,
    segment: m.segment,
    status: m.orgStatus,
    role: m.role,
    memberStatus: m.memberStatus,
    plan: m.plan,
    planStatus: m.planStatus,
    seats: m.seats,
    periodEnd: m.periodEnd ? m.periodEnd.toISOString() : null,
    effective: orgPlanApplies(m, now),
  };
}

/** The tenant and plan a request runs under: the organisation while its plan applies, else the personal workspace. */
export function effectiveTenant(personal: Membership, org: OrgMembership | null, now = new Date()): { orgId: string; plan: Plan } {
  if (org && orgPlanApplies(org, now)) return { orgId: org.orgId, plan: org.plan };
  return { orgId: personal.orgId, plan: personal.plan };
}
