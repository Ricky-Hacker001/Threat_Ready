import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/db.js";
import { entitlements, memberships, organizations } from "../db/schema.js";

export type PersonalRole = "learner" | "trial";

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
      // Personal memberships only: from onboard migration 0012 a user may also hold an organisation membership.
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
    // Personal memberships only: from onboard migration 0012 a user may also hold an organisation
    // membership, and without this filter limit(1) could return it first (403 NO_MEMBERSHIP).
    .where(and(eq(memberships.userId, userId), sql`${memberships.role} in ('learner', 'trial')`))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.role !== "learner" && row.role !== "trial") return null;
  return { orgId: row.orgId, role: row.role, plan: row.plan };
}
