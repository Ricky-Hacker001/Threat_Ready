import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  addAiUsage,
  emptyAiUsage,
  type AdminOrgDetail,
  type AdminOrgList,
  type AdminOrgMember,
  type AdminOrgPlan,
  type AdminOrgRow,
  type AdminOrgStatus,
  type AdminUserAccount,
  type AiUsageTotals,
  type AppAiUsage,
  type AppKey,
} from "@threatready/contracts";
import { and, desc, eq, gte, inArray, isNull, sql, gt } from "drizzle-orm";
import { z } from "zod";
import type { Principal } from "../authz/authz.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db, type Tx } from "../db/db.js";
import { adminAuditLog, entitlements, featureLaunches, memberships, orgInvitations, organizations, users } from "../db/schema.js";
import { EMAIL_PORT, dispatch, type EmailPort } from "../email/email.port.js";
import { orgStatusEmail } from "../email/templates.js";
import { OrgService } from "../org/org.service.js";
import { isOrgRole } from "../tenancy/tenancy.js";
import { AppsClient } from "../platform/apps.client.js";
import { secondsByUser } from "./activity.queries.js";
import type { Range } from "./admin.service.js";

const MAX_ORGS = 2_000;

export const orgListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["pending", "active", "suspended"]).optional(),
  sort: z.enum(["created", "members", "cost", "name"]).default("created"),
});

const notFound = () => new NotFoundException({ code: "NOT_FOUND", message: "Not found" });

/** Per-user AI totals from every app's ledger, summed per user and kept per app. */
function usageByUser(perApp: Partial<Record<AppKey, AppAiUsage>>) {
  const map = new Map<string, { total: AiUsageTotals; byApp: Partial<Record<AppKey, AiUsageTotals>> }>();
  for (const [app, usage] of Object.entries(perApp) as [AppKey, AppAiUsage][]) {
    for (const u of usage.users) {
      const entry = map.get(u.userId) ?? { total: emptyAiUsage(), byApp: {} };
      addAiUsage(entry.total, u);
      entry.byApp[app] = addAiUsage(entry.byApp[app] ?? emptyAiUsage(), u);
      map.set(u.userId, entry);
    }
  }
  return map;
}

/**
 * The platform admin's view of organisations (business accounts): who they are, what plan they are
 * on, what their members use and cost. The plan is set here by hand until billing exists: every
 * change is written to the organisation's own audit log (which its admins can read, without the
 * staff member's identity) and to the platform audit log (admin_audit_log: org.plan, org.status).
 */
@Injectable()
export class AdminOrgsService {
  private readonly logger = new Logger("AdminOrgs");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    private readonly apps: AppsClient,
    private readonly org: OrgService,
  ) {}

  /** Which organisation each of these users belongs to (for the users table's "Account" column). */
  async accountsOf(userIds: string[]): Promise<Map<string, AdminUserAccount>> {
    const out = new Map<string, AdminUserAccount>();
    if (!userIds.length) return out;
    const rows = await this.db
      .select({ userId: memberships.userId, role: memberships.role, status: memberships.status, orgId: organizations.id, name: organizations.name })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(and(inArray(memberships.userId, userIds), sql`${organizations.kind} <> 'personal'`, sql`${memberships.role} in ('org_admin', 'manager', 'member')`));
    for (const r of rows) {
      if (!isOrgRole(r.role)) continue;
      out.set(r.userId, { type: "organisation", org: { id: r.orgId, name: r.name, role: r.role, status: r.status as "active" | "suspended" } });
    }
    return out;
  }

  /** Counts for the overview tiles. */
  async counts(range: Range) {
    const [o] = await this.db
      .select({
        total: sql<number>`count(*)`.mapWith(Number),
        active: sql<number>`count(*) filter (where ${organizations.status} = 'active')`.mapWith(Number),
        pending: sql<number>`count(*) filter (where ${organizations.status} = 'pending')`.mapWith(Number),
        suspended: sql<number>`count(*) filter (where ${organizations.status} = 'suspended')`.mapWith(Number),
        newInRange: sql<number>`count(*) filter (where ${organizations.createdAt} >= ${range.from} and ${organizations.createdAt} < ${range.to})`.mapWith(Number),
      })
      .from(organizations)
      .where(sql`${organizations.kind} <> 'personal'`);
    const [m] = await this.db
      .select({ n: sql<number>`count(distinct ${memberships.userId})`.mapWith(Number) })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(sql`${organizations.kind} <> 'personal'`, sql`${memberships.role} in ('org_admin', 'manager', 'member')`, sql`${users.isAnonymous} is not true`));
    return {
      organisations: { total: o?.total ?? 0, active: o?.active ?? 0, pending: o?.pending ?? 0, suspended: o?.suspended ?? 0, newInRange: o?.newInRange ?? 0 },
      organisationMembers: m?.n ?? 0,
    };
  }

  private async rows(range: Range, orgId?: string): Promise<{ rows: AdminOrgRow[]; unavailable: { app: AppKey; error: string }[] }> {
    const now = new Date();
    const orgs = await this.db
      .select({ org: organizations, ent: entitlements })
      .from(organizations)
      .innerJoin(entitlements, eq(entitlements.orgId, organizations.id))
      .where(and(sql`${organizations.kind} <> 'personal'`, orgId ? eq(organizations.id, orgId) : undefined))
      .orderBy(desc(organizations.createdAt))
      .limit(MAX_ORGS);
    if (!orgs.length) return { rows: [], unavailable: [] };
    const ids = orgs.map((o) => o.org.id);
    const members = await this.db
      .select({ orgId: memberships.orgId, userId: memberships.userId, role: memberships.role, status: memberships.status, createdAt: memberships.createdAt, name: users.name, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(inArray(memberships.orgId, ids), sql`${memberships.role} in ('org_admin', 'manager', 'member')`))
      .orderBy(memberships.createdAt);
    const invites = await this.db
      .select({ orgId: orgInvitations.orgId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(orgInvitations)
      .where(and(inArray(orgInvitations.orgId, ids), isNull(orgInvitations.acceptedAt), isNull(orgInvitations.revokedAt), gt(orgInvitations.expiresAt, now)))
      .groupBy(orgInvitations.orgId);
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const launches = await this.db
      .select({ orgId: featureLaunches.orgId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(featureLaunches)
      .where(and(inArray(featureLaunches.orgId, ids), gte(featureLaunches.createdAt, since)))
      .groupBy(featureLaunches.orgId);
    const [{ ok, unavailable }, secs] = await Promise.all([this.apps.aiUsageAll(range), secondsByUser(this.db, range)]);
    const usage = usageByUser(ok);

    const rows: AdminOrgRow[] = orgs.map(({ org, ent }) => {
      const mine = members.filter((m) => m.orgId === org.id);
      const active = mine.filter((m) => m.status === "active");
      const ai = emptyAiUsage();
      const aiByApp: Partial<Record<AppKey, AiUsageTotals>> = {};
      let seconds = 0;
      for (const m of mine) {
        const u = usage.get(m.userId);
        if (u) {
          addAiUsage(ai, u.total);
          for (const [app, t] of Object.entries(u.byApp) as [AppKey, AiUsageTotals][]) aiByApp[app] = addAiUsage(aiByApp[app] ?? emptyAiUsage(), t);
        }
        seconds += secs.get(m.userId) ?? 0;
      }
      const contact = mine.find((m) => m.userId === org.createdBy) ?? mine.find((m) => m.role === "org_admin") ?? null;
      const kind = org.kind === "institute" ? "institute" : "business";
      return {
        id: org.id,
        name: org.name,
        kind,
        segment: org.segment === "institute" ? "institute" : kind === "institute" ? "institute" : "business",
        status: org.status as AdminOrgRow["status"],
        createdAt: org.createdAt.toISOString(),
        approvedAt: org.approvedAt?.toISOString() ?? null,
        entitlement: {
          plan: ent.plan === "business" ? "business" : "business_trial",
          status: ent.status as AdminOrgRow["entitlement"]["status"],
          seats: ent.seats,
          periodEnd: ent.periodEnd?.toISOString() ?? null,
          aiCapUsd: ent.aiCapUsd,
        },
        members: active.length,
        admins: active.filter((m) => m.role === "org_admin").length,
        pendingInvites: invites.find((i) => i.orgId === org.id)?.n ?? 0,
        contact: contact ? { id: contact.userId, name: contact.name, email: contact.email } : { id: null, name: null, email: null },
        launchesThisMonth: launches.find((l) => l.orgId === org.id)?.n ?? 0,
        seconds,
        ai,
        aiByApp,
      };
    });
    return { rows, unavailable };
  }

  async list(range: Range, query: z.infer<typeof orgListQuerySchema>): Promise<AdminOrgList> {
    const { rows, unavailable } = await this.rows(range);
    const q = query.q?.toLowerCase();
    let out = rows.filter((r) => (!query.status || r.status === query.status) && (!q || r.name.toLowerCase().includes(q) || (r.contact.email ?? "").toLowerCase().includes(q)));
    const sorters: Record<typeof query.sort, (a: AdminOrgRow, b: AdminOrgRow) => number> = {
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
      members: (a, b) => b.members - a.members || b.createdAt.localeCompare(a.createdAt),
      cost: (a, b) => b.ai.costUsd - a.ai.costUsd || b.createdAt.localeCompare(a.createdAt),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    out = out.sort(sorters[query.sort]);
    return { range: { from: range.from.toISOString(), to: range.to.toISOString() }, total: out.length, pending: rows.filter((r) => r.status === "pending").length, rows: out, unavailable };
  }

  async detail(id: string, range: Range): Promise<AdminOrgDetail> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const { rows } = await this.rows(range, id);
    const org = rows[0];
    if (!org) throw notFound();
    // The organisation console's own member rows (launches, time this month, last app), plus each member's AI usage in the range.
    const [{ ok }, list] = await Promise.all([this.apps.aiUsageAll(range), this.org.membersOf(id)]);
    const usage = usageByUser(ok);
    const members: AdminOrgMember[] = list.members.map((m) => ({ ...m, ai: usage.get(m.userId)?.total ?? emptyAiUsage() }));
    return { range: { from: range.from.toISOString(), to: range.to.toISOString() }, org, members, invitations: list.invitations, audit: await this.org.auditRows(id, 200) };
  }

  private async load(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const [row] = await this.db
      .select({ org: organizations, ent: entitlements })
      .from(organizations)
      .innerJoin(entitlements, eq(entitlements.orgId, organizations.id))
      .where(and(eq(organizations.id, id), sql`${organizations.kind} <> 'personal'`))
      .limit(1);
    if (!row) throw notFound();
    return row;
  }

  /**
   * The platform's own append-only trail (admin_audit_log), next to role changes: written in the same
   * transaction as the change and the organisation's log row. Inserted here rather than through
   * AdminService, which already depends on this service.
   */
  private async adminTrail(tx: Tx, action: "org.plan" | "org.status", actor: Principal, org: { id: string; name: string }, detail: Record<string, unknown>, ip: string | null): Promise<void> {
    await tx.insert(adminAuditLog).values({ action, actorId: actor.userId, actorEmail: actor.email, targetId: null, targetEmail: null, detail: { orgId: org.id, name: org.name, ...detail }, ip });
  }

  private confirm(name: string, typed: string) {
    if (name.trim().toLowerCase() !== typed.trim().toLowerCase()) throw new BadRequestException({ code: "ADMIN_CONFIRM_MISMATCH", message: "The organisation name you typed doesn't match." });
  }

  /** Plan, seats, status, period and AI cap, by hand. Seats may not drop below the active members plus pending invitations. */
  async setPlan(actor: Principal, id: string, body: AdminOrgPlan, ip: string | null): Promise<AdminOrgRow> {
    const { org, ent } = await this.load(id);
    this.confirm(org.name, body.confirmName);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org-seats:${id}`}, 0))`);
      const seats = await this.org.summary(id, tx);
      const inUse = seats.seats.used + seats.seats.pending;
      if (body.seats < inUse) throw new BadRequestException({ code: "ORG_SEATS_IN_USE", message: `${inUse} seats are in use (members plus pending invitations). Remove people or revoke invitations before reducing below that.` });
      await tx
        .update(entitlements)
        .set({ plan: body.plan, status: body.status, seats: body.seats, periodEnd: body.periodEnd ? new Date(body.periodEnd) : null, aiCapUsd: body.aiCapUsd === null ? null : Math.round(body.aiCapUsd), updatedAt: new Date() })
        .where(eq(entitlements.orgId, id));
      const change = { from: { plan: ent.plan, status: ent.status, seats: ent.seats, periodEnd: ent.periodEnd?.toISOString() ?? null, aiCapUsd: ent.aiCapUsd }, to: { plan: body.plan, status: body.status, seats: body.seats, periodEnd: body.periodEnd, aiCapUsd: body.aiCapUsd } };
      await this.org.audit(tx, id, "plan.set", { userId: actor.userId, email: actor.email }, null, { ...change, by: "platform_admin" }, ip);
      await this.adminTrail(tx, "org.plan", actor, org, change, ip);
    });
    this.logger.log(`plan set org=${id} plan=${body.plan} status=${body.status} seats=${body.seats}`);
    return (await this.rows({ from: new Date(Date.now() - 30 * 86_400_000), to: new Date() }, id)).rows[0]!;
  }

  /** Approve a pending organisation, suspend one, or reinstate it. Its admins are told by email. */
  async setStatus(actor: Principal, id: string, body: AdminOrgStatus, ip: string | null): Promise<AdminOrgRow> {
    const { org } = await this.load(id);
    this.confirm(org.name, body.confirmName);
    if (org.status === body.status) throw new BadRequestException({ code: "ORG_STATUS_SAME", message: `The organisation is already ${body.status}.` });
    const action = body.status === "active" ? (org.status === "pending" ? "org.approve" : "org.reinstate") : body.status === "suspended" ? "org.suspend" : "org.update";
    await this.db.transaction(async (tx) => {
      await tx.update(organizations).set({ status: body.status, approvedAt: body.status === "active" && !org.approvedAt ? new Date() : org.approvedAt, updatedAt: new Date() }).where(eq(organizations.id, id));
      await this.org.audit(tx, id, action, { userId: actor.userId, email: actor.email }, null, { from: org.status, to: body.status, by: "platform_admin" }, ip);
      await this.adminTrail(tx, "org.status", actor, org, { action, from: org.status, to: body.status }, ip);
    });
    if (body.status === "active" || body.status === "suspended") {
      const admins = await this.db
        .select({ email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.orgId, id), eq(memberships.role, "org_admin"), eq(memberships.status, "active"), eq(users.emailVerified, true)));
      for (const a of admins) dispatch(this.email, orgStatusEmail(a.email, org.name, body.status, `${this.config.WEB_ORIGIN}/app/org`), this.logger);
    }
    this.logger.log(`organisation ${action} id=${id}`);
    return (await this.rows({ from: new Date(Date.now() - 30 * 86_400_000), to: new Date() }, id)).rows[0]!;
  }
}
