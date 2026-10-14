import { sql } from 'drizzle-orm';
import { pgPolicy, pgRole } from 'drizzle-orm/pg-core';

/**
 * The role the API assumes inside every user-scoped transaction (`SET LOCAL ROLE tr_app_user`).
 * It has no BYPASSRLS, so a missed WHERE returns nothing (ADD L7 backstop). The worker connects
 * with its own role, which owns the tables and is not subject to these policies.
 * Created by migration 0000_roles.
 */
export const appUserRole = pgRole('tr_app_user').existing();

const owned = sql`user_id = current_setting('app.user_id', true)`;

/** Owner-isolation policy for a table with a `user_id` column. */
export const ownerPolicy = (table: string) =>
  pgPolicy(`${table}_owner_isolation`, { as: 'permissive', for: 'all', to: appUserRole, using: owned, withCheck: owned });
