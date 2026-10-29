import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The API connects as `threatready_app`: no table ownership, no BYPASSRLS.
 * Migrations run as the owner role. Both roles are created by infra/db/init.sql
 * (local) or OpenTofu (AWS); `.existing()` keeps drizzle-kit from creating them.
 */
export const appRole = pgRole("threatready_app").existing();

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/**
 * Request-scoped backstop for the shared tables (migration 0011). The API's one role serves Better
 * Auth (looks users up by email/token before anyone is signed in), the admin console (reads across
 * users) and the tenancy helpers, so these tables cannot be owner-only for the role. Instead the
 * policies bite whenever a request user is set (withUserTx): a query that runs under one user's
 * app.user_id can then see and write only that user's own row / memberships / organisations. With no
 * user context (the setting unset, or "" after a previous transaction reset it) the role-wide grants
 * apply as before. A real split would need a second database role for Better Auth and admin.
 */
const noUserContext = sql`coalesce(current_setting('app.user_id', true), '') = ''`;
const currentUser = sql`current_setting('app.user_id', true)`;

/* ------------------------------------------------------------------ */
/* Better Auth tables (fields match better-auth 1.7.7 + username,      */
/* emailOTP, anonymous plugins and database rate limiting).            */
/* Better Auth must look users up across accounts: `users` carries     */
/* only the request-scoped backstop above, the other tables no RLS.    */
/* ------------------------------------------------------------------ */

const usersSelfOrNoContext = sql`${noUserContext} OR id = ${currentUser}`;
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    username: text("username").unique(),
    displayUsername: text("display_username"),
    isAnonymous: boolean("is_anonymous").default(false),
    /** Platform role: "user" or "admin". Admin sees /admin (all users, tokens, AI cost). */
    role: text("role").notNull().default("user"),
    ...timestamps,
  },
  () => [
    check("users_role_check", sql`"role" IN ('user', 'admin')`),
    pgPolicy("users_self_or_no_context", { for: "all", to: appRole, using: usersSelfOrNoContext, withCheck: usersSelfOrNoContext }),
  ],
).enableRLS();

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [
    index("accounts_user_id_idx").on(t.userId),
    uniqueIndex("accounts_provider_account_uidx").on(t.providerId, t.accountId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/* ------------------------------------------------------------------ */
/* Tenancy and entitlements (ours, not Better Auth's).                 */
/* Every user gets a personal organisation at creation (L7 step 2).    */
/* ------------------------------------------------------------------ */

export const orgKind = pgEnum("org_kind", ["personal", "institute", "business"]);
/** learner/trial: the personal workspace. org_admin/manager/member: an organisation (migration 0012). student/instructor: reserved. */
export const memberRole = pgEnum("member_role", ["learner", "trial", "student", "instructor", "org_admin", "manager", "member"]);
export const planKind = pgEnum("plan_kind", ["trial", "free", "business_trial", "business"]);
export const featureKey = pgEnum("feature_key", ["interview", "simulations", "reasoning"]);

/** With a request user set: only organisations that user is a member of. */
const orgMemberOrNoContext = sql`${noUserContext} OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = organizations.id AND m.user_id = ${currentUser})`;
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: orgKind("kind").notNull().default("personal"),
    /** Organisations only (migration 0012): pending = waiting for platform approval; suspended = members fall back to their personal plan. */
    status: text("status").notNull().default("active"),
    /** Organisations only: who it is for. Drives console copy, never permissions. */
    segment: text("segment"),
    /** The user who created the organisation (its first org admin). */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...timestamps,
  },
  () => [
    check("organizations_status_check", sql`"status" IN ('pending', 'active', 'suspended')`),
    check("organizations_segment_check", sql`"segment" IS NULL OR "segment" IN ('business', 'institute')`),
    pgPolicy("organizations_member_or_no_context", { for: "all", to: appRole, using: orgMemberOrNoContext, withCheck: orgMemberOrNoContext }),
  ],
).enableRLS();

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    /** Organisation memberships only: a suspended member keeps the account and falls back to the personal plan. */
    status: text("status").notNull().default("active"),
    /** Who invited them (organisation memberships). */
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("memberships_org_user_uidx").on(t.orgId, t.userId),
    index("memberships_user_id_idx").on(t.userId),
    index("memberships_org_id_idx").on(t.orgId),
    // One personal workspace per user (migration 0008); institute roles may repeat.
    uniqueIndex("memberships_personal_user_uidx").on(t.userId).where(sql`${t.role} in ('learner', 'trial')`),
    // One organisation per user for now (business-accounts plan, phase 1): a member of two would need a workspace switcher.
    // Spelled as "not a personal or reserved role": an enum cast in an index predicate is not immutable, and the new
    // values (org_admin was there, manager and member are new) cannot be named in the migration that adds them.
    uniqueIndex("memberships_org_member_user_uidx").on(t.userId).where(sql`${t.role} not in ('learner', 'trial', 'student', 'instructor')`),
    check("memberships_status_check", sql`"status" IN ('active', 'suspended')`),
    pgPolicy("memberships_own_or_no_context", { for: "all", to: appRole, using: sql`${noUserContext} OR user_id = ${currentUser}`, withCheck: sql`${noUserContext} OR user_id = ${currentUser}` }),
  ],
).enableRLS();

export const entitlements = pgTable(
  "entitlements",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    plan: planKind("plan").notNull(),
    /** Organisations: purchased seats (active members plus pending invitations may not exceed it). Personal workspaces: 1. */
    seats: integer("seats").notNull().default(1),
    /** Organisations: trialing | active | past_due | suspended | cancelled. Personal workspaces stay active. */
    status: text("status").notNull().default("active"),
    /** Trial end or renewal; null = open-ended. Launches on an organisation plan stop after it. */
    periodEnd: timestamp("period_end", { withTimezone: true }),
    /** Monthly AI budget (USD) the platform admin set; null = the plan's default. Recorded for the apps; informational until they enforce it. */
    aiCapUsd: integer("ai_cap_usd"),
    /** Free text from the platform admin: who agreed what (invoice number, PO, pilot terms). */
    notes: text("notes"),
    ...timestamps,
  },
  () => [
    check("entitlements_seats_check", sql`"seats" >= 0`),
    check("entitlements_status_check", sql`"status" IN ('trialing', 'active', 'past_due', 'suspended', 'cancelled')`),
  ],
);

/**
 * Invitations into an organisation (migration 0012). The token the email carries is never stored:
 * only its SHA-256. One open invitation per address per organisation; accepted, expired and revoked
 * rows are kept for the audit trail. No RLS: every query names the organisation it works for, and
 * the organisation is taken from the caller's verified membership, never from the request.
 */
export const orgInvitations = pgTable(
  "org_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lower-cased */
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("org_invitations_org_idx").on(t.orgId),
    index("org_invitations_email_idx").on(t.email),
    uniqueIndex("org_invitations_open_uidx").on(t.orgId, t.email).where(sql`${t.acceptedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    check("org_invitations_role_check", sql`"role" IN ('member', 'manager')`),
  ],
);

/** What organisation admins did (invites, removals, role changes) and what platform admins did to the organisation. Append-only. */
export const orgAuditLog = pgTable(
  "org_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    action: text("action").notNull(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    targetId: text("target_id").references(() => users.id, { onDelete: "set null" }),
    targetEmail: text("target_email"),
    detail: jsonb("detail").notNull().default({}),
    ip: text("ip"),
  },
  // action+at: the platform-wide invitation email counts (migration 0014).
  (t) => [index("org_audit_log_org_at_idx").on(t.orgId, t.at), index("org_audit_log_action_at_idx").on(t.action, t.at)],
);

/* ------------------------------------------------------------------ */
/* User-owned data: RLS backstop (L7). The API sets app.user_id per    */
/* transaction; a query that forgets WHERE user_id returns nothing.    */
/* ------------------------------------------------------------------ */

const ownRows = sql`user_id = current_setting('app.user_id', true)`;

export const featureLaunches = pgTable(
  "feature_launches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    feature: featureKey("feature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("feature_launches_user_feature_created_idx").on(t.userId, t.feature, t.createdAt),
    pgPolicy("feature_launches_owner_select", { for: "select", to: appRole, using: ownRows }),
    pgPolicy("feature_launches_owner_insert", { for: "insert", to: appRole, withCheck: ownRows }),
    // The organisation and admin consoles count launches per organisation with no request user set (migration 0012).
    pgPolicy("feature_launches_no_context_select", { for: "select", to: appRole, using: noUserContext }),
  ],
).enableRLS();

/* ------------------------------------------------------------------ */
/* Platform activity: time spent in each app and where users are.     */
/* Written by POST /api/activity/ping (the signed-in user's own rows); */
/* read by the admin console. No RLS: admins read across users, and    */
/* the API only ever writes the caller's rows.                         */
/* ------------------------------------------------------------------ */

/** Seconds of active use per user, UTC day, app and area (e.g. a lab console). */
export const activityDays = pgTable(
  "activity_days",
  {
    userId: text("user_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    /** home | interview | labs | reasoning */
    app: text("app").notNull(),
    /** Where in the app: a lab slug, an Attack Reasoning domain, or "" for the app's main pages. */
    area: text("area").notNull().default(""),
    seconds: integer("seconds").notNull().default(0),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Constraint names as migration 0003 created them (inline REFERENCES → PostgreSQL's <table>_<col>_fkey).
  (t) => [
    primaryKey({ name: "activity_days_pk", columns: [t.userId, t.day, t.app, t.area] }),
    foreignKey({ name: "activity_days_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete("cascade"),
    index("activity_days_day_idx").on(t.day),
    check("activity_days_app_check", sql`"app" IN ('home', 'interview', 'labs', 'reasoning')`),
    check("activity_days_seconds_check", sql`"seconds" >= 0`),
  ],
);

/** Where a user uses the platform from, per UTC day: country (offline IP lookup, never the IP) and browser time zone. */
export const userLocations = pgTable(
  "user_locations",
  {
    userId: text("user_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    /** ISO 3166-1 alpha-2; "LO" local/private network; "ZZ" unknown. */
    country: text("country").notNull(),
    /** IANA time zone reported by the browser, e.g. "Asia/Kolkata"; "" when not reported. */
    timeZone: text("time_zone").notNull().default(""),
    seconds: integer("seconds").notNull().default(0),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "user_locations_pk", columns: [t.userId, t.day, t.country, t.timeZone] }),
    foreignKey({ name: "user_locations_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete("cascade"),
    index("user_locations_day_idx").on(t.day),
    check("user_locations_country_check", sql`"country" ~ '^[A-Z]{2}$'`),
  ],
);

/** When the user last pinged, from any tab or area: time is credited once per user (migration 0007). */
export const activityLastPing = pgTable(
  "activity_last_ping",
  {
    userId: text("user_id").primaryKey(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
  },
  // FK name as migration 0007 created it (inline REFERENCES → PostgreSQL's <table>_<col>_fkey).
  (t) => [foreignKey({ name: "activity_last_ping_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete("cascade")],
);

/**
 * Failed sign-ins per submitted username (migration 0006), keyed by a hash so the table never holds
 * the name and a lock looks the same whether or not the account exists. Not in rate_limits: Better
 * Auth prunes that table after its longest window (one hour), and a lock can last a day.
 */
export const signinFailures = pgTable(
  "signin_failures",
  {
    key: text("key").primaryKey(),
    failures: integer("failures").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("signin_failures_failures_check", sql`"failures" >= 0`)],
);

/** Keys must equal Better Auth model names for the drizzle adapter. */
export const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  rateLimit: rateLimits,
};

/** Append-only record of platform-role changes made from the admin console (migration 0004). */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    action: text("action").notNull(),
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    targetId: text("target_id"),
    targetEmail: text("target_email"),
    detail: jsonb("detail").notNull().default({}),
    ip: text("ip"),
  },
  (t) => [
    foreignKey({ name: "admin_audit_log_actor_id_fkey", columns: [t.actorId], foreignColumns: [users.id] }).onDelete("set null"),
    foreignKey({ name: "admin_audit_log_target_id_fkey", columns: [t.targetId], foreignColumns: [users.id] }).onDelete("set null"),
    index("admin_audit_log_at_idx").on(t.at),
    index("admin_audit_log_target_idx").on(t.targetId),
    // org.plan / org.status: a platform admin's changes to an organisation (migration 0013).
    check("admin_audit_log_action_check", sql`"action" IN ('role.promote', 'role.demote', 'users.export', 'user.view', 'org.view', 'org.plan', 'org.status')`),
  ],
);
