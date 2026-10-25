import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  addAiUsage,
  emptyAiUsage,
  type AdminOverview,
  type AdminRoleChangeResult,
  type AdminUserDetail,
  type AdminUserList,
  type AdminUserRow,
  type AiUsageTotals,
  type AppAiUsage,
  type AppKey,
} from "@threatready/contracts";
import { and, count, desc, eq, gt, gte, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { adminSourceOf, isPlatformAdmin, type Principal } from "../authz/authz.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db } from "../db/db.js";
import { accounts, adminAuditLog, sessions, users } from "../db/schema.js";
import { AppsClient } from "../platform/apps.client.js";
import { lastApps, primaryLocations, secondsByUser, timeOverview, userActivity } from "./activity.queries.js";
import { planRoleChange } from "./role-change.js";

export interface Range {
  from: Date;
  to: Date;
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
/** Sized for S1/S2 (≤ 5,000 users): sorting by AI cost needs every matching user in memory. */
const MAX_USERS_SCANNED = 10_000;

const rangeSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * The console's range, widened to the whole UTC days it touches: `from` back to its midnight, `to` on
 * to the next one (unless it is a midnight). Time and locations are stored per UTC day, so every
 * figure (time, locations, AI cost and calls, new users) then covers the same [from, to).
 */
export function parseRange(query: Record<string, unknown>): Range {
  const parsed = rangeSchema.safeParse(query);
  if (!parsed.success) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "from/to must be ISO dates" });
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(to.getTime() - 30 * DAY);
  if (from >= to) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "from must be before to" });
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) {
    throw new BadRequestException({ code: "VALIDATION_FAILED", message: `Range is limited to ${MAX_RANGE_DAYS} days` });
  }
  const toDay = utcMidnight(to);
  return { from: utcMidnight(from), to: toDay.getTime() === to.getTime() ? to : new Date(toDay.getTime() + DAY) };
}

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["cost", "tokens", "time", "recent", "created"]).default("cost"),
  includeTrial: z.enum(["true", "false"]).default("false"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  size: z.coerce.number().int().min(5).max(100).default(25),
});

const totalTokens = (u: AiUsageTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** Per-user AI usage across apps: userId → { total, byApp }. */
function usageByUser(perApp: Partial<Record<AppKey, AppAiUsage>>) {
  const map = new Map<string, { total: AiUsageTotals; byApp: Partial<Record<AppKey, AiUsageTotals>>; lastCallAt: string | null }>();
  for (const [app, usage] of Object.entries(perApp) as [AppKey, AppAiUsage][]) {
    for (const u of usage.users) {
      const entry = map.get(u.userId) ?? { total: emptyAiUsage(), byApp: {}, lastCallAt: null };
      addAiUsage(entry.total, u);
      entry.byApp[app] = addAiUsage(entry.byApp[app] ?? emptyAiUsage(), u);
      if (u.lastCallAt && (!entry.lastCallAt || u.lastCallAt > entry.lastCallAt)) entry.lastCallAt = u.lastCallAt;
      map.set(u.userId, entry);
    }
  }
  return map;
}

/**
 * Platform admin console. Identity data comes from this database; AI usage
 * (tokens, cost) comes from each app's own LLM ledger over /internal/v1/ai-usage,
 * so the numbers are the ones each app budgets against.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    private readonly apps: AppsClient,
  ) {}

  private isAdmin(u: { role: string; email: string; emailVerified: boolean; isAnonymous: boolean | null }) {
    return isPlatformAdmin(u, this.config.adminEmails);
  }

  async overview(range: Range): Promise<AdminOverview> {
    const now = new Date();
    const [counts] = await this.db
      .select({
        total: sql<number>`count(*) filter (where ${users.isAnonymous} is not true)`.mapWith(Number),
        verified: sql<number>`count(*) filter (where ${users.isAnonymous} is not true and ${users.emailVerified})`.mapWith(Number),
        trial: sql<number>`count(*) filter (where ${users.isAnonymous} is true)`.mapWith(Number),
        admins: sql<number>`count(*) filter (where ${users.role} = 'admin')`.mapWith(Number),
        newInRange: sql<number>`count(*) filter (where ${users.isAnonymous} is not true and ${users.createdAt} >= ${range.from} and ${users.createdAt} < ${range.to})`.mapWith(Number),
      })
      .from(users);
    const [active] = await this.db
      .select({ n: sql<number>`count(distinct ${sessions.userId})`.mapWith(Number) })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(gte(sessions.updatedAt, new Date(now.getTime() - 7 * DAY)), sql`${users.isAnonymous} is not true`));

    // ADMIN_EMAILS admins are not in the role column; count them too.
    const listed = [...this.config.adminEmails];
    let envAdmins = 0;
    if (listed.length) {
      const [r] = await this.db
        .select({ n: count() })
        .from(users)
        .where(
          and(
            sql`lower(${users.email}) in (${sql.join(listed.map((e) => sql`${e}`), sql`, `)})`,
            eq(users.emailVerified, true),
            sql`${users.role} <> 'admin'`,
          ),
        );
      envAdmins = r?.n ?? 0;
    }

    const { ok, unavailable } = await this.apps.aiUsageAll(range);
    const total = emptyAiUsage();
    const byApp: Partial<Record<AppKey, AiUsageTotals>> = {};
    const byModel = new Map<string, AiUsageTotals & { model: string }>();
    const byFeature: (AiUsageTotals & { app: AppKey; feature: string })[] = [];
    const aiUsers = new Set<string>();
    for (const [app, usage] of Object.entries(ok) as [AppKey, AppAiUsage][]) {
      const appTotal = emptyAiUsage();
      for (const u of usage.users) {
        addAiUsage(appTotal, u);
        if (u.calls > 0) aiUsers.add(u.userId);
      }
      byApp[app] = appTotal;
      addAiUsage(total, appTotal);
      for (const m of usage.byModel) {
        const e = byModel.get(m.model) ?? { ...emptyAiUsage(), model: m.model };
        byModel.set(m.model, addAiUsage(e, m) as typeof e);
      }
      for (const f of usage.byFeature) byFeature.push({ ...f, app });
    }

    // Time, locations, and AI cost per country (each user counted in their most-used country).
    const [time, primary] = await Promise.all([timeOverview(this.db, range), primaryLocations(this.db, range)]);
    const perUser = usageByUser(ok);
    const known = perUser.size
      ? new Set(
          (
            await this.db
              .select({ id: users.id })
              .from(users)
              .where(sql`${users.id} in (${sql.join([...perUser.keys()].map((k) => sql`${k}`), sql`, `)})`)
          ).map((r) => r.id),
        )
      : new Set<string>();
    let attributed = 0;
    for (const [id, u] of perUser) if (known.has(id)) attributed += u.total.costUsd;
    const secs = await secondsByUser(this.db, range);
    const countries = new Map<string, { country: string; users: number; seconds: number; costUsd: number }>();
    const zones = new Map<string, { timeZone: string; users: number; seconds: number }>();
    for (const [userId, loc] of primary) {
      const c = countries.get(loc.country) ?? { country: loc.country, users: 0, seconds: 0, costUsd: 0 };
      c.users += 1;
      c.seconds += secs.get(userId) ?? 0;
      c.costUsd += perUser.get(userId)?.total.costUsd ?? 0;
      countries.set(loc.country, c);
      const z = zones.get(loc.timeZone) ?? { timeZone: loc.timeZone, users: 0, seconds: 0 };
      z.users += 1;
      z.seconds += secs.get(userId) ?? 0;
      zones.set(loc.timeZone, z);
    }

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      unattributedCostUsd: Math.max(0, total.costUsd - attributed),
      time,
      locations: {
        countries: [...countries.values()].sort((a, b) => b.users - a.users || b.seconds - a.seconds),
        timeZones: [...zones.values()].sort((a, b) => b.users - a.users || b.seconds - a.seconds),
      },
      users: {
        total: counts?.total ?? 0,
        verified: counts?.verified ?? 0,
        trial: counts?.trial ?? 0,
        admins: (counts?.admins ?? 0) + envAdmins,
        activeLast7Days: active?.n ?? 0,
        newInRange: counts?.newInRange ?? 0,
      },
      ai: { ...total, byApp, users: aiUsers.size },
      byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
      byFeature: byFeature.sort((a, b) => b.costUsd - a.costUsd),
      unavailable,
    };
  }

  /** Sessions per user: last activity and how many are still valid. */
  private sessionStats() {
    return this.db
      .select({
        userId: sessions.userId,
        lastSeenAt: sql<Date | null>`max(${sessions.updatedAt})`.as("last_seen_at"),
        active: sql<number>`count(*) filter (where ${sessions.expiresAt} > now())`.mapWith(Number).as("active_sessions"),
      })
      .from(sessions)
      .groupBy(sessions.userId)
      .as("ss");
  }

  async listUsers(range: Range, query: z.infer<typeof listQuerySchema>): Promise<AdminUserList> {
    const { rows, unavailable } = await this.allUserRows(range, query);
    const start = (query.page - 1) * query.size;
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      total: rows.length,
      rows: rows.slice(start, start + query.size),
      unavailable,
    };
  }

  /** Every matching user (sorted), for the list and the CSV export. */
  async allUserRows(range: Range, query: Omit<z.infer<typeof listQuerySchema>, "page" | "size">) {
    const ss = this.sessionStats();
    const q = query.q ? `%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const where = and(
      query.includeTrial === "true" ? undefined : sql`${users.isAnonymous} is not true`,
      q ? or(ilike(users.email, q), ilike(users.username, q), ilike(users.name, q)) : undefined,
    );
    const rows = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        username: users.username,
        emailVerified: users.emailVerified,
        isAnonymous: users.isAnonymous,
        role: users.role,
        createdAt: users.createdAt,
        lastSeenAt: ss.lastSeenAt,
        active: ss.active,
      })
      .from(users)
      .leftJoin(ss, eq(ss.userId, users.id))
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(MAX_USERS_SCANNED);

    const [{ ok, unavailable }, secs, primary, recent] = await Promise.all([
      this.apps.aiUsageAll(range),
      secondsByUser(this.db, range),
      primaryLocations(this.db, range),
      lastApps(this.db),
    ]);
    const usage = usageByUser(ok);

    const out: AdminUserRow[] = rows.map((r) => {
      const u = usage.get(r.id);
      const loc = primary.get(r.id);
      const lastSeen = r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null;
      return {
        id: r.id,
        name: r.name,
        email: r.isAnonymous ? null : r.email,
        username: r.username,
        emailVerified: r.emailVerified,
        isTrial: r.isAnonymous === true,
        isAdmin: this.isAdmin(r),
        adminSource: adminSourceOf(r, this.config.adminEmails),
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: lastSeen,
        activeSessions: Number(r.active ?? 0),
        ai: u?.total ?? emptyAiUsage(),
        aiByApp: u?.byApp ?? {},
        seconds: secs.get(r.id) ?? 0,
        country: loc?.country ?? null,
        timeZone: loc?.timeZone || null,
        lastApp: recent.get(r.id) ?? null,
      };
    });

    const sorters: Record<typeof query.sort, (a: AdminUserRow, b: AdminUserRow) => number> = {
      cost: (a, b) => b.ai.costUsd - a.ai.costUsd || b.createdAt.localeCompare(a.createdAt),
      tokens: (a, b) => totalTokens(b.ai) - totalTokens(a.ai) || b.createdAt.localeCompare(a.createdAt),
      time: (a, b) => b.seconds - a.seconds || b.createdAt.localeCompare(a.createdAt),
      recent: (a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""),
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    };
    out.sort(sorters[query.sort]);
    return { rows: out, unavailable };
  }

  /** Platform admins right now: the role column plus verified ADMIN_EMAILS accounts that are not already role admins. */
  private async adminCount(db: Pick<Db, "select"> = this.db): Promise<number> {
    const [byRole] = await db.select({ n: count() }).from(users).where(and(eq(users.role, "admin"), sql`${users.isAnonymous} is not true`));
    let byEnv = 0;
    const listed = [...this.config.adminEmails];
    if (listed.length) {
      const [r] = await db
        .select({ n: count() })
        .from(users)
        .where(and(sql`lower(${users.email}) in (${sql.join(listed.map((e) => sql`${e}`), sql`, `)})`, eq(users.emailVerified, true), sql`${users.role} <> 'admin'`, sql`${users.isAnonymous} is not true`));
      byEnv = r?.n ?? 0;
    }
    return (byRole?.n ?? 0) + byEnv;
  }

  /**
   * Append an admin_audit_log row for a read of personal data (export, user detail). Same shape as the
   * role-change row; the table is append-only for the API role (migration 0005).
   */
  async audit(action: "users.export" | "user.view", actor: Principal, target: { id: string; email: string | null } | null, detail: Record<string, unknown>, ip: string | null): Promise<void> {
    await this.db.insert(adminAuditLog).values({
      action,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetId: target?.id ?? null,
      targetEmail: target?.email ?? null,
      detail,
      ip,
    });
  }

  /**
   * Promote a user to platform admin or remove it. The rules live in planRoleChange (pure); this
   * gathers the facts, applies the plan in one transaction with an audit row, and on demotion ends
   * every session of the user so cached admin rights stop immediately.
   */
  async setRole(actor: Principal, targetId: string, requested: "admin" | "user", confirmEmail: string, ip: string | null): Promise<AdminRoleChangeResult> {
    if (targetId.length > 100) throw new NotFoundException({ code: "NOT_FOUND", message: "Not found" });
    const [t] = await this.db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!t) throw new NotFoundException({ code: "NOT_FOUND", message: "Not found" });

    const envListed = !!t.email && this.config.adminEmails.has(t.email.toLowerCase());
    const plan = planRoleChange({
      actor: { userId: actor.userId },
      target: { id: t.id, email: t.email, role: t.role, emailVerified: t.emailVerified, isAnonymous: t.isAnonymous, envListed },
      requested,
      confirmEmail,
      adminCount: requested === "user" ? await this.adminCount() : 0,
    });
    if (!plan.ok) {
      const body = { code: plan.code, message: plan.message };
      throw plan.status === 409 ? new ConflictException(body) : new BadRequestException(body);
    }

    const sessionsEnded = await this.db.transaction(async (tx) => {
      // Role changes are serialised (transaction-scoped advisory lock), and a demotion recounts the
      // admins under that lock, so two admins demoting each other at the same moment cannot leave none.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('threatready:admin-role'))`);
      if (plan.signOut && (await this.adminCount(tx)) <= 1) {
        throw new BadRequestException({ code: "ADMIN_LAST_ADMIN", message: "This is the last admin. Promote someone else before removing this one." });
      }
      const [updated] = await tx
        .update(users)
        .set({ role: requested, updatedAt: new Date() })
        .where(and(eq(users.id, t.id), eq(users.role, t.role)))
        .returning({ id: users.id });
      if (!updated) throw new ConflictException({ code: "ADMIN_CHANGED", message: "This user's role changed a moment ago. Reload and try again." });
      let ended = 0;
      if (plan.signOut) {
        const gone = await tx.delete(sessions).where(eq(sessions.userId, t.id)).returning({ id: sessions.id });
        ended = gone.length;
      }
      await tx.insert(adminAuditLog).values({
        action: plan.action,
        actorId: actor.userId,
        actorEmail: actor.email,
        targetId: t.id,
        targetEmail: t.email,
        detail: { from: t.role, to: requested, sessionsEnded: ended },
        ip,
      });
      return ended;
    });

    const after = { ...t, role: requested };
    return {
      user: { id: t.id, email: t.email, isAdmin: this.isAdmin(after), adminSource: adminSourceOf(after, this.config.adminEmails) },
      sessionsEnded,
    };
  }

  async userDetail(id: string, range: Range): Promise<AdminUserDetail> {
    if (id.length > 100) throw new NotFoundException({ code: "NOT_FOUND", message: "Not found" });
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw new NotFoundException({ code: "NOT_FOUND", message: "Not found" });

    const [userSessions, methods, apps, usage] = await Promise.all([
      this.db
        .select({
          id: sessions.id,
          createdAt: sessions.createdAt,
          updatedAt: sessions.updatedAt,
          expiresAt: sessions.expiresAt,
          ipAddress: sessions.ipAddress,
          userAgent: sessions.userAgent,
        })
        .from(sessions)
        .where(and(eq(sessions.userId, id), gt(sessions.expiresAt, new Date())))
        .orderBy(desc(sessions.updatedAt))
        .limit(20),
      this.db.selectDistinct({ providerId: accounts.providerId }).from(accounts).where(eq(accounts.userId, id)),
      this.apps.overviewApps(id),
      this.apps.aiUsageAll(range, id),
    ]);
    const [activity, recent] = await Promise.all([userActivity(this.db, range, id), lastApps(this.db, id)]);
    const top = activity.locations[0];
    const [lastSeen] = await this.db
      .select({ at: sql<Date | null>`max(${sessions.updatedAt})` })
      .from(sessions)
      .where(eq(sessions.userId, id));

    const perUser = usageByUser(usage.ok).get(id);
    const byModel: AdminUserDetail["byModel"] = [];
    const byFeature: AdminUserDetail["byFeature"] = [];
    for (const [app, a] of Object.entries(usage.ok) as [AppKey, AppAiUsage][]) {
      for (const m of a.byModel) byModel.push({ ...m, app });
      for (const f of a.byFeature) byFeature.push({ ...f, app });
    }

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      user: {
        id: u.id,
        name: u.name,
        email: u.isAnonymous ? null : u.email,
        username: u.username,
        emailVerified: u.emailVerified,
        isTrial: u.isAnonymous === true,
        isAdmin: this.isAdmin(u),
        adminSource: adminSourceOf(u, this.config.adminEmails),
        createdAt: u.createdAt.toISOString(),
        lastSeenAt: lastSeen?.at ? new Date(lastSeen.at).toISOString() : null,
        activeSessions: userSessions.length,
        ai: perUser?.total ?? emptyAiUsage(),
        aiByApp: perUser?.byApp ?? {},
        seconds: activity.seconds,
        country: top?.country ?? null,
        timeZone: top?.timeZone || null,
        lastApp: recent.get(id) ?? null,
      },
      time: { seconds: activity.seconds, byArea: activity.byArea, daily: activity.daily },
      locations: activity.locations,
      sessions: userSessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
      })),
      signInMethods: methods.map((m) => m.providerId),
      apps,
      byModel: byModel.sort((a, b) => b.costUsd - a.costUsd),
      byFeature: byFeature.sort((a, b) => b.costUsd - a.costUsd),
    };
  }
}
