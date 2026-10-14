import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
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

/** Keys must equal Better Auth model names for the drizzle adapter. */
export const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  rateLimit: rateLimits,
};
