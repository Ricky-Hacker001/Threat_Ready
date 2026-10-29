import { BadRequestException, ConflictException, ForbiddenException, GoneException, HttpException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  FEATURE_KEYS,
  type FeatureKey,
  type InvitationAcceptResult,
  type InvitationPreview,
  type MemberStatus,
  type OrgAuditRow,
  type OrgCreate,
  type OrgInvitationRow,
  type OrgInviteCreate,
  type OrgInviteResult,
  type OrgMemberDetail,
  type OrgMemberList,
  type OrgMemberRow,
  type OrgOverview,
  type OrgRole,
  type OrgSummary,
  type OrgUpdate,
  type OrgUsageMonth,
  emailSchema,
} from "@threatready/contracts";
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Principal } from "../authz/authz.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db, type Tx } from "../db/db.js";
import { activityDays, entitlements, featureLaunches, memberships, orgAuditLog, orgInvitations, organizations, sessions, users } from "../db/schema.js";
import { EMAIL_PORT, dispatch, type EmailPort } from "../email/email.port.js";
import { orgInviteEmail } from "../email/templates.js";
import { lastApps, secondsByUser, userActivity } from "../admin/activity.queries.js";
import { AppsClient } from "../platform/apps.client.js";
import { isOrgRole } from "../tenancy/tenancy.js";
import {
  INVITE_TOKEN_SHAPE,
  freeSeats,
  hashInviteToken,
  invitationState,
  maskEmail,
  newInviteToken,
  planAccept,
  planInvites,
  planLeave,
  planRemoval,
  planResend,
  planRoleChange,
  planStatusChange,
  seatSummary,
  type ChangePlan,
} from "./org-rules.js";

const DAY = 24 * 60 * 60 * 1000;
const MAX_MEMBERS_LISTED = 2_000;

/** UTC month start: the organisation console counts launches and time per calendar month, like plan limits. */
const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const notFound = () => new NotFoundException({ code: "NOT_FOUND", message: "Not found" });

function fail(plan: ChangePlan): never {
  if (plan.ok) throw new Error("fail() with an ok plan");
  const body = { code: plan.code, message: plan.message };
  if (plan.status === 409) throw new ConflictException(body);
  if (plan.status === 403) throw new ForbiddenException(body);
  throw new BadRequestException(body);
}

/** Audit actions an organisation's log can hold (org admins' and platform admins' changes to it). */
export type OrgAuditAction =
  | "org.create"
  | "org.update"
  | "org.approve"
  | "org.suspend"
  | "org.reinstate"
  | "plan.set"
  | "invite.send"
  | "invite.resend"
  | "invite.revoke"
  | "invite.accept"
  | "member.role"
  | "member.suspend"
  | "member.reinstate"
  | "member.remove"
  | "member.leave"
  | "members.export"
  | "member.view";

/**
 * Business accounts: an organisation, its seats and plan, the people in it. Every method takes the
 * organisation from the caller's verified membership (Principal.org, set by the AuthGuard from the
 * memberships table), never from the request, and every query names that organisation. Queries run
 * with no request user (like the admin console): the RLS backstop would otherwise hide the other
 * members' rows from an org admin.
 */
@Injectable()
export class OrgService {
  private readonly logger = new Logger("Org");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    private readonly apps: AppsClient,
  ) {}

  /* ---------------- Helpers ---------------- */

  private orgOf(p: Principal): string {
    if (!p.org) throw new ForbiddenException({ code: "ORG_REQUIRED", message: "You're not part of an organisation." });
    return p.org.id;
  }

  async audit(
    db: Pick<Db, "insert"> | Tx,
    orgId: string,
    action: OrgAuditAction,
    actor: { userId: string | null; email: string | null },
    target: { id: string; email: string | null } | null,
    detail: Record<string, unknown>,
    ip: string | null,
  ): Promise<void> {
    await db.insert(orgAuditLog).values({ orgId, action, actorId: actor.userId, actorEmail: actor.email, targetId: target?.id ?? null, targetEmail: target?.email ?? null, detail, ip });
  }

  private async seatsOf(db: Pick<Db, "select"> | Tx, orgId: string, purchased: number, now = new Date()): Promise<OrgSummary["seats"]> {
    const [m] = await db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active"), sql`${memberships.role} in ('org_admin', 'manager', 'member')`));
    const [i] = await db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(orgInvitations)
      .where(and(eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt), isNull(orgInvitations.revokedAt), gt(orgInvitations.expiresAt, now)));
    return seatSummary(purchased, m?.n ?? 0, i?.n ?? 0);
  }

  /** The organisation and its entitlement; the seat figures are computed live. */
  async summary(orgId: string, db: Pick<Db, "select"> | Tx = this.db): Promise<OrgSummary> {
    const [row] = await db
      .select({ org: organizations, ent: entitlements })
      .from(organizations)
      .innerJoin(entitlements, eq(entitlements.orgId, organizations.id))
      .where(and(eq(organizations.id, orgId), sql`${organizations.kind} <> 'personal'`))
      .limit(1);
    if (!row) throw notFound();
    const { org, ent } = row;
    const kind = org.kind === "institute" ? "institute" : "business";
    return {
      id: org.id,
      name: org.name,
      kind,
      segment: org.segment === "institute" ? "institute" : kind === "institute" ? "institute" : "business",
      status: org.status as OrgSummary["status"],
      createdAt: org.createdAt.toISOString(),
      approvedAt: org.approvedAt?.toISOString() ?? null,
      entitlement: {
        plan: ent.plan === "business" ? "business" : "business_trial",
        status: ent.status as OrgSummary["entitlement"]["status"],
        seats: ent.seats,
        periodEnd: ent.periodEnd?.toISOString() ?? null,
        aiCapUsd: ent.aiCapUsd,
      },
      seats: await this.seatsOf(db, orgId, ent.seats),
    };
  }

  private async activeAdmins(db: Pick<Db, "select"> | Tx, orgId: string): Promise<number> {
    const [r] = await db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "org_admin"), eq(memberships.status, "active")));
    return r?.n ?? 0;
  }

  /* ---------------- Create ---------------- */

  async create(p: Principal, body: OrgCreate, ip: string | null): Promise<OrgSummary> {
    if (p.isTrial) throw new ForbiddenException({ code: "ORG_ACCOUNT_REQUIRED", message: "Create an account first, then set up your organisation." });
    if (!p.emailVerified) throw new ForbiddenException({ code: "ORG_EMAIL_UNVERIFIED", message: "Verify your email address before setting up an organisation." });
    if (p.org) throw new ConflictException({ code: "ORG_ALREADY_MEMBER", message: `You already belong to ${p.org.name}. One organisation per account for now.` });

    const now = new Date();
    const status = this.config.orgApprovalRequired ? "pending" : "active";
    const orgId = await this.db.transaction(async (tx) => {
      // Serialised per user: two parallel "create" clicks must not make two organisations.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org-create:${p.userId}`}, 0))`);
      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.userId, p.userId), sql`${memberships.role} in ('org_admin', 'manager', 'member')`))
        .limit(1);
      if (existing) throw new ConflictException({ code: "ORG_ALREADY_MEMBER", message: "You already belong to an organisation." });
      const [org] = await tx
        .insert(organizations)
        .values({ name: body.name, kind: body.segment, segment: body.segment, status, createdBy: p.userId, approvedAt: status === "active" ? now : null })
        .returning({ id: organizations.id });
      if (!org) throw new Error("organisation insert returned nothing");
      await tx.insert(memberships).values({ orgId: org.id, userId: p.userId, role: "org_admin", status: "active" });
      await tx.insert(entitlements).values({
        orgId: org.id,
        plan: "business_trial",
        seats: this.config.ORG_TRIAL_SEATS,
        status: "trialing",
        periodEnd: new Date(now.getTime() + this.config.ORG_TRIAL_DAYS * DAY),
      });
      await this.audit(tx, org.id, "org.create", { userId: p.userId, email: p.email }, null, { name: body.name, segment: body.segment, status, trialSeats: this.config.ORG_TRIAL_SEATS, trialDays: this.config.ORG_TRIAL_DAYS }, ip);
      return org.id;
    });
    this.logger.log(`organisation created id=${orgId} status=${status}`);
    return this.summary(orgId);
  }

  /* ---------------- Overview ---------------- */

  private async usageMonth(orgId: string, now = new Date()): Promise<OrgUsageMonth> {
    const since = monthStart(now);
    const launches = await this.db
      .select({ feature: featureLaunches.feature, count: sql<number>`count(*)`.mapWith(Number) })
      .from(featureLaunches)
      .where(and(eq(featureLaunches.orgId, orgId), gte(featureLaunches.createdAt, since)))
      .groupBy(featureLaunches.feature);
    const [active] = await this.db
      .select({ n: sql<number>`count(distinct ${sessions.userId})`.mapWith(Number) })
      .from(sessions)
      .innerJoin(memberships, and(eq(memberships.userId, sessions.userId), eq(memberships.orgId, orgId)))
      .where(gte(sessions.updatedAt, new Date(now.getTime() - 7 * DAY)));
    const [time] = await this.db
      .select({ seconds: sql<number>`coalesce(sum(${activityDays.seconds}), 0)`.mapWith(Number) })
      .from(activityDays)
      .innerJoin(memberships, and(eq(memberships.userId, activityDays.userId), eq(memberships.orgId, orgId)))
      .where(gte(activityDays.day, since.toISOString().slice(0, 10)));
    return {
      since: since.toISOString(),
      launches: FEATURE_KEYS.map((feature) => ({ feature, count: launches.find((l) => l.feature === feature)?.count ?? 0 })),
      activeMembers7d: active?.n ?? 0,
      seconds: time?.seconds ?? 0,
    };
  }

  async overview(p: Principal): Promise<OrgOverview> {
    const orgId = this.orgOf(p);
    const now = new Date();
    const [org, usage] = await Promise.all([this.summary(orgId), this.usageMonth(orgId, now)]);
    const attention: OrgOverview["attention"] = [];
    if (org.status === "pending") attention.push({ kind: "pending_approval", message: "Your organisation is waiting for approval. You can invite people now; launches count on your plan once it is approved." });
    if (org.entitlement.status === "past_due") attention.push({ kind: "plan_past_due", message: "Your plan is past due. Members fall back to the free plan until it is settled." });
    if (org.entitlement.periodEnd) {
      const left = Math.ceil((new Date(org.entitlement.periodEnd).getTime() - now.getTime()) / DAY);
      if (org.entitlement.status === "trialing" && left <= 7) attention.push({ kind: "trial_ending", message: left > 0 ? `Your trial ends in ${left} day${left === 1 ? "" : "s"}. Contact ThreatReady to continue on a plan.` : "Your trial has ended. Members are on the free plan until a plan is set." });
      else if (org.entitlement.status === "active" && left <= 14) attention.push({ kind: "trial_ending", message: left > 0 ? `Your plan period ends in ${left} day${left === 1 ? "" : "s"}.` : "Your plan period has ended. Members are on the free plan until it is renewed." });
    }
    if (org.seats.available === 0 && org.seats.purchased > 0) attention.push({ kind: "seats_low", message: "Every seat is taken or held by a pending invitation. Add seats or revoke an invitation to invite more people." });
    const [expiring] = await this.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(orgInvitations)
      .where(and(eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt), isNull(orgInvitations.revokedAt), gt(orgInvitations.expiresAt, now), sql`${orgInvitations.expiresAt} < ${new Date(now.getTime() + 2 * DAY)}`));
    if (expiring?.n) attention.push({ kind: "invites_expiring", message: `${expiring.n} invitation${expiring.n === 1 ? "" : "s"} expire${expiring.n === 1 ? "s" : ""} within two days. Resend any that are still wanted.` });
    return { org, role: p.org!.role, usage, attention };
  }

  /* ---------------- Members and invitations ---------------- */

  private async invitationRows(orgId: string, now = new Date()): Promise<OrgInvitationRow[]> {
    const rows = await this.db
      .select({ inv: orgInvitations, inviterName: users.name })
      .from(orgInvitations)
      .leftJoin(users, eq(users.id, orgInvitations.invitedBy))
      .where(and(eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt), isNull(orgInvitations.revokedAt)))
      .orderBy(desc(orgInvitations.createdAt))
      .limit(500);
    return rows.map(({ inv, inviterName }) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role === "manager" ? "manager" : "member",
      invitedBy: { id: inv.invitedBy, name: inviterName ?? null },
      createdAt: inv.createdAt.toISOString(),
      expiresAt: inv.expiresAt.toISOString(),
      state: invitationState(inv, now) === "expired" ? "expired" : "pending",
    }));
  }

  private async memberRows(orgId: string, userId?: string): Promise<OrgMemberRow[]> {
    const since = monthStart();
    const ss = this.db
      .select({ userId: sessions.userId, lastSeenAt: sql<Date | null>`max(${sessions.updatedAt})`.as("last_seen_at") })
      .from(sessions)
      .groupBy(sessions.userId)
      .as("ss");
    const rows = await this.db
      .select({ m: memberships, u: users, lastSeenAt: ss.lastSeenAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(ss, eq(ss.userId, memberships.userId))
      .where(and(eq(memberships.orgId, orgId), sql`${memberships.role} in ('org_admin', 'manager', 'member')`, userId ? eq(memberships.userId, userId) : undefined))
      .orderBy(memberships.createdAt)
      .limit(MAX_MEMBERS_LISTED);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.u.id);
    const launches = await this.db
      .select({ userId: featureLaunches.userId, feature: featureLaunches.feature, count: sql<number>`count(*)`.mapWith(Number) })
      .from(featureLaunches)
      .where(and(eq(featureLaunches.orgId, orgId), gte(featureLaunches.createdAt, since), inArray(featureLaunches.userId, ids)))
      .groupBy(featureLaunches.userId, featureLaunches.feature);
    const [secs, recent] = await Promise.all([secondsByUser(this.db, { from: since, to: new Date() }), lastApps(this.db, userId)]);
    return rows.map(({ m, u, lastSeenAt }) => {
      const l: Partial<Record<FeatureKey, number>> = {};
      for (const row of launches) if (row.userId === u.id) l[row.feature] = row.count;
      return {
        userId: u.id,
        name: u.name,
        email: u.isAnonymous ? null : u.email,
        username: u.username,
        emailVerified: u.emailVerified,
        role: isOrgRole(m.role) ? m.role : "member",
        status: m.status as MemberStatus,
        joinedAt: m.createdAt.toISOString(),
        lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
        launches: l,
        seconds: secs.get(u.id) ?? 0,
        lastApp: recent.get(u.id) ?? null,
      };
    });
  }

  async membersOf(orgId: string): Promise<OrgMemberList> {
    const [members, invitations] = await Promise.all([this.memberRows(orgId), this.invitationRows(orgId)]);
    return { members, invitations };
  }

  members(p: Principal): Promise<OrgMemberList> {
    return this.membersOf(this.orgOf(p));
  }

  /** One member's progress as every app reports it (the same summaries the profile page shows them). Audited: a read of someone else's data. */
  async memberDetail(p: Principal, userId: string, ip: string | null): Promise<OrgMemberDetail> {
    const orgId = this.orgOf(p);
    if (userId.length > 100) throw notFound();
    const [member] = await this.memberRows(orgId, userId);
    if (!member) throw notFound();
    const since = monthStart();
    const [apps, activity] = await Promise.all([this.apps.overviewApps(userId), userActivity(this.db, { from: since, to: new Date() }, userId)]);
    if (userId !== p.userId) await this.audit(this.db, orgId, "member.view", { userId: p.userId, email: p.email }, { id: member.userId, email: member.email }, {}, ip);
    return { member, apps, time: activity.byArea };
  }

  private async inviteLimitLeft(orgId: string, now = new Date()): Promise<number> {
    const cap = this.config.ORG_INVITES_PER_DAY;
    if (cap <= 0) return Number.POSITIVE_INFINITY;
    const [r] = await this.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(orgAuditLog)
      .where(and(eq(orgAuditLog.orgId, orgId), inArray(orgAuditLog.action, ["invite.send", "invite.resend"]), gte(orgAuditLog.at, new Date(now.getTime() - DAY))));
    return Math.max(0, cap - (r?.n ?? 0));
  }

  private acceptUrl(token: string): string {
    return `${this.config.WEB_ORIGIN}/invite/${token}`;
  }

  async invite(p: Principal, body: OrgInviteCreate, ip: string | null): Promise<OrgInviteResult> {
    const orgId = this.orgOf(p);
    if (p.org!.status === "suspended") throw new ForbiddenException({ code: "ORG_SUSPENDED", message: "The organisation is suspended; invitations are paused." });
    const left = await this.inviteLimitLeft(orgId);
    if (left <= 0) throw new HttpException({ code: "ORG_INVITE_LIMIT", message: "This organisation has sent its daily limit of invitations. Try again tomorrow." }, 429);
    const now = new Date();
    const ttl = this.config.ORG_INVITE_TTL_DAYS;
    const toSend: { email: string; token: string }[] = [];
    const result = await this.db.transaction(async (tx) => {
      // Seat accounting is serialised per organisation: parallel invites (or an accept) cannot overbook.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org-seats:${orgId}`}, 0))`);
      const org = await this.summary(orgId, tx);
      const memberEmails = new Set(
        (
          await tx
            .select({ email: users.email })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(eq(memberships.orgId, orgId))
        ).map((r) => r.email.toLowerCase()),
      );
      const open = new Set(
        (
          await tx
            .select({ email: orgInvitations.email })
            .from(orgInvitations)
            .where(and(eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt), isNull(orgInvitations.revokedAt), gt(orgInvitations.expiresAt, now)))
        ).map((r) => r.email),
      );
      const plan = planInvites(body.emails, {
        selfEmail: p.email?.toLowerCase() ?? null,
        memberEmails,
        openInviteEmails: open,
        seatsAvailable: Math.min(org.seats.available, left),
        valid: (e) => emailSchema.safeParse(e).success,
      });
      const sent: OrgInviteResult["sent"] = [];
      for (const email of plan.send) {
        const { token, hash } = newInviteToken();
        const expiresAt = new Date(now.getTime() + ttl * DAY);
        // An expired open invitation for the same address is replaced (the partial unique index allows one open row).
        await tx.delete(orgInvitations).where(and(eq(orgInvitations.orgId, orgId), eq(orgInvitations.email, email), isNull(orgInvitations.acceptedAt), isNull(orgInvitations.revokedAt)));
        const [row] = await tx.insert(orgInvitations).values({ orgId, email, role: body.role, tokenHash: hash, invitedBy: p.userId, expiresAt }).returning({ id: orgInvitations.id });
        if (!row) throw new Error("invitation insert returned nothing");
        await this.audit(tx, orgId, "invite.send", { userId: p.userId, email: p.email }, null, { email, role: body.role, invitationId: row.id }, ip);
        sent.push({ email, id: row.id, expiresAt: expiresAt.toISOString() });
        toSend.push({ email, token });
      }
      return { sent, skipped: plan.skipped, seats: await this.seatsOf(tx, orgId, org.seats.purchased, now) };
    });
    // After commit: the link must not reach an inbox for a row that was rolled back.
    const inviter = p.username ?? p.email;
    for (const { email, token } of toSend) dispatch(this.email, orgInviteEmail(email, p.org!.name, inviter, body.role, this.acceptUrl(token), ttl), this.logger);
    return result;
  }

  private async openInvitation(orgId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const [inv] = await this.db
      .select()
      .from(orgInvitations)
      .where(and(eq(orgInvitations.id, id), eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt), isNull(orgInvitations.revokedAt)))
      .limit(1);
    if (!inv) throw notFound();
    return inv;
  }

  async resend(p: Principal, id: string, ip: string | null): Promise<OrgInvitationRow> {
    const orgId = this.orgOf(p);
    if (p.org!.status === "suspended") throw new ForbiddenException({ code: "ORG_SUSPENDED", message: "The organisation is suspended; invitations are paused." });
    if ((await this.inviteLimitLeft(orgId)) <= 0) throw new HttpException({ code: "ORG_INVITE_LIMIT", message: "This organisation has sent its daily limit of invitations. Try again tomorrow." }, 429);
    const inv = await this.openInvitation(orgId, id);
    const { token, hash } = newInviteToken();
    const ttl = this.config.ORG_INVITE_TTL_DAYS;
    const expiresAt = new Date(Date.now() + ttl * DAY);
    await this.db.transaction(async (tx) => {
      // Serialised with invite/accept/reinstate: renewing an expired invitation takes a seat back.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org-seats:${orgId}`}, 0))`);
      const [fresh] = await tx.select().from(orgInvitations).where(and(eq(orgInvitations.id, inv.id), eq(orgInvitations.orgId, orgId))).limit(1);
      if (!fresh) throw notFound();
      const org = await this.summary(orgId, tx);
      const plan = planResend({ state: invitationState(fresh), seatsFree: freeSeats(org.seats) });
      if (!plan.ok) fail(plan);
      await tx.update(orgInvitations).set({ tokenHash: hash, expiresAt }).where(eq(orgInvitations.id, inv.id));
      await this.audit(tx, orgId, "invite.resend", { userId: p.userId, email: p.email }, null, { email: inv.email, invitationId: inv.id }, ip);
    });
    dispatch(this.email, orgInviteEmail(inv.email, p.org!.name, p.username ?? p.email, inv.role === "manager" ? "manager" : "member", this.acceptUrl(token), ttl), this.logger);
    return (await this.invitationRows(orgId)).find((r) => r.id === inv.id)!;
  }

  async revoke(p: Principal, id: string, ip: string | null): Promise<{ revoked: true }> {
    const orgId = this.orgOf(p);
    const inv = await this.openInvitation(orgId, id);
    await this.db.transaction(async (tx) => {
      await tx.update(orgInvitations).set({ revokedAt: new Date() }).where(eq(orgInvitations.id, inv.id));
      await this.audit(tx, orgId, "invite.revoke", { userId: p.userId, email: p.email }, null, { email: inv.email, invitationId: inv.id }, ip);
    });
    return { revoked: true };
  }

  private async memberFacts(tx: Tx, orgId: string, p: Principal, targetId: string) {
    if (targetId.length > 100) throw notFound();
    const [t] = await tx
      .select({ m: memberships, u: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, targetId), sql`${memberships.role} in ('org_admin', 'manager', 'member')`))
      .limit(1);
    if (!t || !isOrgRole(t.m.role)) throw notFound();
    const org = await this.summary(orgId, tx);
    return {
      target: { userId: t.u.id, email: t.u.email, role: t.m.role, status: t.m.status as MemberStatus },
      facts: { actor: { userId: p.userId, role: p.org!.role }, target: { userId: t.u.id, role: t.m.role, status: t.m.status as MemberStatus }, activeAdmins: await this.activeAdmins(tx, orgId), seatsFree: freeSeats(org.seats) },
    };
  }

  /** Role, status and removal share one shape: lock the organisation, gather the facts, decide (org-rules.ts), apply with an audit row. */
  private async changeMember(p: Principal, targetId: string, ip: string | null, decide: (f: Awaited<ReturnType<OrgService["memberFacts"]>>["facts"]) => ChangePlan, apply: (tx: Tx, target: { userId: string; email: string; role: OrgRole; status: MemberStatus }) => Promise<{ action: OrgAuditAction; detail: Record<string, unknown> }>) {
    const orgId = this.orgOf(p);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org-seats:${orgId}`}, 0))`);
      const { target, facts } = await this.memberFacts(tx, orgId, p, targetId);
      const plan = decide(facts);
      if (!plan.ok) fail(plan);
      const { action, detail } = await apply(tx, target);
      await this.audit(tx, orgId, action, { userId: p.userId, email: p.email }, { id: target.userId, email: target.email }, detail, ip);
      return { userId: target.userId };
    });
  }

  setRole(p: Principal, targetId: string, role: OrgRole, ip: string | null) {
    return this.changeMember(
      p,
      targetId,
      ip,
      (f) => planRoleChange(f, role),
      async (tx, t) => {
        await tx.update(memberships).set({ role, updatedAt: new Date() }).where(and(eq(memberships.orgId, this.orgOf(p)), eq(memberships.userId, t.userId)));
        return { action: "member.role", detail: { from: t.role, to: role } };
      },
    );
  }

  setStatus(p: Principal, targetId: string, status: MemberStatus, ip: string | null) {
    return this.changeMember(
      p,
      targetId,
      ip,
      (f) => planStatusChange(f, status),
      async (tx, t) => {
        await tx.update(memberships).set({ status, updatedAt: new Date() }).where(and(eq(memberships.orgId, this.orgOf(p)), eq(memberships.userId, t.userId)));
        return { action: status === "suspended" ? "member.suspend" : "member.reinstate", detail: { from: t.status, to: status } };
      },
    );
  }

  /** The seat is freed; the person keeps their account and personal workspace, and their launches stay recorded against the organisation. */
  remove(p: Principal, targetId: string, ip: string | null) {
    return this.changeMember(
      p,
      targetId,
      ip,
      (f) => planRemoval(f),
      async (tx, t) => {
        await tx.delete(memberships).where(and(eq(memberships.orgId, this.orgOf(p)), eq(memberships.userId, t.userId)));
        return { action: "member.remove", detail: { role: t.role } };
      },
    );
  }

  async leave(p: Principal, ip: string | null): Promise<{ left: true }> {
    if (!p.org) throw new ForbiddenException({ code: "ORG_REQUIRED", message: "You're not part of an organisation." });
    const orgId = p.org.id;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org-seats:${orgId}`}, 0))`);
      const plan = planLeave({ role: p.org!.role, status: p.org!.memberStatus }, await this.activeAdmins(tx, orgId));
      if (!plan.ok) fail(plan);
      await tx.delete(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, p.userId)));
      await this.audit(tx, orgId, "member.leave", { userId: p.userId, email: p.email }, { id: p.userId, email: p.email }, { role: p.org!.role }, ip);
    });
    return { left: true };
  }

  async update(p: Principal, body: OrgUpdate, ip: string | null): Promise<OrgSummary> {
    const orgId = this.orgOf(p);
    await this.db.transaction(async (tx) => {
      await tx.update(organizations).set({ name: body.name, updatedAt: new Date() }).where(eq(organizations.id, orgId));
      await this.audit(tx, orgId, "org.update", { userId: p.userId, email: p.email }, null, { name: body.name }, ip);
    });
    return this.summary(orgId);
  }

  async auditRows(orgId: string, limit = 100): Promise<OrgAuditRow[]> {
    const rows = await this.db.select().from(orgAuditLog).where(eq(orgAuditLog.orgId, orgId)).orderBy(desc(orgAuditLog.at), desc(orgAuditLog.id)).limit(limit);
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      action: r.action,
      actor: { id: r.actorId, email: r.actorEmail },
      target: { id: r.targetId, email: r.targetEmail },
      detail: r.detail as Record<string, unknown>,
    }));
  }

  auditOf(p: Principal): Promise<OrgAuditRow[]> {
    return this.auditRows(this.orgOf(p));
  }

  /** The CSV export is a bulk read of the team's data: recorded like the admin console's export. */
  recordExport(p: Principal, rows: number, ip: string | null): Promise<void> {
    return this.audit(this.db, this.orgOf(p), "members.export", { userId: p.userId, email: p.email }, null, { rows }, ip);
  }

  /* ---------------- Invitations: the invitee's side ---------------- */

  private async invitationByToken(token: string) {
    if (!INVITE_TOKEN_SHAPE.test(token)) throw notFound();
    const [row] = await this.db
      .select({ inv: orgInvitations, org: organizations, inviterName: users.name })
      .from(orgInvitations)
      .innerJoin(organizations, eq(organizations.id, orgInvitations.orgId))
      .leftJoin(users, eq(users.id, orgInvitations.invitedBy))
      .where(eq(orgInvitations.tokenHash, hashInviteToken(token)))
      .limit(1);
    if (!row) throw notFound();
    return row;
  }

  /** What the invite page shows before sign-in. A wrong token is a 404; the email is only hinted at. */
  async preview(token: string): Promise<InvitationPreview> {
    const { inv, org, inviterName } = await this.invitationByToken(token);
    return {
      state: invitationState(inv),
      org: { name: org.name, segment: org.segment === "institute" ? "institute" : "business" },
      role: inv.role === "manager" ? "manager" : "member",
      emailHint: maskEmail(inv.email),
      invitedBy: inviterName ?? null,
      expiresAt: inv.expiresAt.toISOString(),
    };
  }

  async accept(p: Principal, token: string, ip: string | null): Promise<InvitationAcceptResult> {
    const { inv, org } = await this.invitationByToken(token);
    const role = inv.role === "manager" ? "manager" : "member";
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org-seats:${inv.orgId}`}, 0))`);
      const [fresh] = await tx.select().from(orgInvitations).where(eq(orgInvitations.id, inv.id)).limit(1);
      if (!fresh) throw notFound();
      const [ent] = await tx.select({ seats: entitlements.seats }).from(entitlements).where(eq(entitlements.orgId, inv.orgId)).limit(1);
      const seats = await this.seatsOf(tx, inv.orgId, ent?.seats ?? 0);
      const [existing] = await tx
        .select({ orgId: memberships.orgId })
        .from(memberships)
        .where(and(eq(memberships.userId, p.userId), sql`${memberships.role} in ('org_admin', 'manager', 'member')`))
        .limit(1);
      const plan = planAccept({
        state: invitationState(fresh),
        invitedEmail: fresh.email,
        accountEmail: p.email?.toLowerCase() ?? null,
        accountVerified: p.emailVerified,
        accountIsTrial: p.isTrial,
        existingOrgId: existing?.orgId ?? null,
        invitationOrgId: inv.orgId,
        orgStatus: org.status as "pending" | "active" | "suspended",
        // The invitation itself holds one of the pending seats: it does not compete with itself. Not
        // clamped: an organisation already over its seats (used + pending > purchased) stays refused.
        seatsAvailable: freeSeats(seats) + 1,
      });
      if (!plan.ok) {
        const body = { code: plan.code, message: plan.message };
        if (plan.status === 410) throw new GoneException(body);
        if (plan.status === 409) throw new ConflictException(body);
        if (plan.status === 403) throw new ForbiddenException(body);
        throw new BadRequestException(body);
      }
      await tx.insert(memberships).values({ orgId: inv.orgId, userId: p.userId, role, status: "active", invitedBy: fresh.invitedBy });
      await tx.update(orgInvitations).set({ acceptedAt: new Date(), acceptedBy: p.userId }).where(eq(orgInvitations.id, inv.id));
      await this.audit(tx, inv.orgId, "invite.accept", { userId: p.userId, email: p.email }, { id: p.userId, email: p.email }, { role, invitationId: inv.id }, ip);
    });
    return { org: { id: org.id, name: org.name }, role };
  }
}
