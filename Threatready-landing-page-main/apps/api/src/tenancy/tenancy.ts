import { eq } from "drizzle-orm";
import type { Db } from "../db/db.js";
import { entitlements, memberships, organizations } from "../db/schema.js";

export type PersonalRole = "learner" | "trial";

/**
 * Every user gets a personal organisation with one membership and one
 * entitlement row (ADD L7 step 2). Idempotent: safe to call twice.
 */
export async function ensurePersonalWorkspace(db: Db, userId: string, role: PersonalRole): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, userId))
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
    .where(eq(memberships.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.role !== "learner" && row.role !== "trial") return null;
  return { orgId: row.orgId, role: row.role, plan: row.plan };
}
