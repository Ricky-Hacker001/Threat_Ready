import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  FEATURE_KEYS,
  FEATURE_ROUTES,
  type FeatureKey,
  type FeatureState,
  type LaunchResponse,
} from "@threatready/contracts";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Principal } from "../authz/authz.js";
import { DB, withUserTx, type Db, type Tx } from "../db/db.js";
import { featureLaunches } from "../db/schema.js";
import { PLAN_LIMITS, type FeatureLimit } from "../entitlements/plans.js";

function periodStart(limit: FeatureLimit, now = new Date()): Date | null {
  if (limit.period === "lifetime") return null;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function toState(key: FeatureKey, limit: FeatureLimit, used: number, isTrial: boolean): FeatureState {
  if (limit.limit === null) return { key, access: "full", remaining: null, limit: null };
  const remaining = Math.max(0, limit.limit - used);
  return {
    key,
    access: remaining === 0 ? "exhausted" : isTrial ? "trial" : "full",
    remaining,
    limit: limit.limit,
  };
}

const uuid = z.string().uuid();

@Injectable()
export class FeaturesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Usage is counted inside a user-scoped transaction: RLS + explicit WHERE. */
  private async used(tx: Tx, p: Principal, key: FeatureKey, limit: FeatureLimit): Promise<number> {
    const since = periodStart(limit);
    const [row] = await tx
      .select({ n: count() })
      .from(featureLaunches)
      .where(
        and(
          eq(featureLaunches.userId, p.userId),
          eq(featureLaunches.feature, key),
          since ? gte(featureLaunches.createdAt, since) : undefined,
        ),
      );
    return row?.n ?? 0;
  }

  async states(p: Principal): Promise<FeatureState[]> {
    const limits = PLAN_LIMITS[p.plan];
    return withUserTx(this.db, p.userId, async (tx) => {
      const out: FeatureState[] = [];
      for (const key of FEATURE_KEYS) {
        out.push(toState(key, limits[key], await this.used(tx, p, key, limits[key]), p.isTrial));
      }
      return out;
    });
  }

  async state(p: Principal, key: FeatureKey): Promise<FeatureState> {
    const limit = PLAN_LIMITS[p.plan][key];
    return withUserTx(this.db, p.userId, async (tx) => toState(key, limit, await this.used(tx, p, key, limit), p.isTrial));
  }

  /**
   * Entitlement check and the usage record in one transaction, serialised per
   * user with an advisory lock so parallel requests cannot overspend a quota.
   * The feature modules call this when a session actually starts.
   */
  async launch(p: Principal, key: FeatureKey): Promise<LaunchResponse> {
    const limit = PLAN_LIMITS[p.plan][key];
    return withUserTx(this.db, p.userId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${p.userId}, 0))`);
      const used = await this.used(tx, p, key, limit);
      if (limit.limit !== null && used >= limit.limit) {
        throw new ForbiddenException({
          code: "ENTITLEMENT_EXHAUSTED",
          message: p.isTrial
            ? "Your free trial for this feature is used up. Create an account to keep going."
            : "You've reached this month's limit for this feature.",
        });
      }
      const [row] = await tx
        .insert(featureLaunches)
        .values({ userId: p.userId, orgId: p.orgId, feature: key })
        .returning({ id: featureLaunches.id });
      if (!row) throw new Error("launch insert returned nothing");
      return {
        launchId: row.id,
        feature: key,
        route: FEATURE_ROUTES[key],
        state: toState(key, limit, used + 1, p.isTrial),
      };
    });
  }

  /** Ownership (ADD L7 step 6): a miss is 404, never 403. */
  async getLaunch(p: Principal, id: string) {
    if (!uuid.safeParse(id).success) throw new NotFoundException({ code: "NOT_FOUND", message: "Not found" });
    const rows = await withUserTx(this.db, p.userId, (tx) =>
      tx
        .select({ id: featureLaunches.id, feature: featureLaunches.feature, createdAt: featureLaunches.createdAt })
        .from(featureLaunches)
        .where(and(eq(featureLaunches.id, id), eq(featureLaunches.userId, p.userId)))
        .limit(1),
    );
    const row = rows[0];
    if (!row) throw new NotFoundException({ code: "NOT_FOUND", message: "Not found" });
    return { id: row.id, feature: row.feature, createdAt: row.createdAt.toISOString() };
  }
}
