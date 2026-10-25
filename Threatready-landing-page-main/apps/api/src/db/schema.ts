import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
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

/* ------------------------------------------------------------------ */
/* Better Auth tables (fields match better-auth 1.7.7 + username,      */
/* emailOTP, anonymous plugins and database rate limiting).            */
/* Not RLS-protected: Better Auth must look users up across accounts.  */
/* ------------------------------------------------------------------ */

export const users = pgTable("users", {
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
});

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

export const orgKind = pgEnum("org_kind", ["personal", "institute"]);
export const memberRole = pgEnum("member_role", ["learner", "trial", "student", "instructor", "org_admin"]);
export const planKind = pgEnum("plan_kind", ["trial", "free"]);
export const featureKey = pgEnum("feature_key", ["interview", "simulations", "reasoning"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: orgKind("kind").notNull().default("personal"),
  ...timestamps,
});

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
    ...timestamps,
  },
  (t) => [
    uniqueIndex("memberships_org_user_uidx").on(t.orgId, t.userId),
    index("memberships_user_id_idx").on(t.userId),
    // One personal workspace per user (migration 0008); institute roles may repeat.
    uniqueIndex("memberships_personal_user_uidx").on(t.userId).where(sql`${t.role} in ('learner', 'trial')`),
  ],
);

export const entitlements = pgTable("entitlements", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  plan: planKind("plan").notNull(),
  ...timestamps,
});

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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    /** home | interview | labs | reasoning */
    app: text("app").notNull(),
    /** Where in the app: a lab slug, an Attack Reasoning domain, or "" for the app's main pages. */
    area: text("area").notNull().default(""),
    seconds: integer("seconds").notNull().default(0),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day, t.app, t.area] }), index("activity_days_day_idx").on(t.day)],
);

/** Where a user uses the platform from, per UTC day: country (offline IP lookup, never the IP) and browser time zone. */
export const userLocations = pgTable(
  "user_locations",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    /** ISO 3166-1 alpha-2; "LO" local/private network; "ZZ" unknown. */
    country: text("country").notNull(),
    /** IANA time zone reported by the browser, e.g. "Asia/Kolkata"; "" when not reported. */
    timeZone: text("time_zone").notNull().default(""),
    seconds: integer("seconds").notNull().default(0),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day, t.country, t.timeZone] }), index("user_locations_day_idx").on(t.day)],
);

/** When the user last pinged, from any tab or area: time is credited once per user (migration 0007). */
export const activityLastPing = pgTable("activity_last_ping", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
});

/**
 * Failed sign-ins per submitted username (migration 0006), keyed by a hash so the table never holds
 * the name and a lock looks the same whether or not the account exists. Not in rate_limits: Better
 * Auth prunes that table after its longest window (one hour), and a lock can last a day.
 */
export const signinFailures = pgTable("signin_failures", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    targetId: text("target_id").references(() => users.id, { onDelete: "set null" }),
    targetEmail: text("target_email"),
    detail: jsonb("detail").notNull().default({}),
    ip: text("ip"),
  },
  (t) => [index("admin_audit_log_at_idx").on(t.at), index("admin_audit_log_target_idx").on(t.targetId)],
);
