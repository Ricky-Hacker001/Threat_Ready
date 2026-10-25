import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/db.js";

export interface RetentionPolicy {
  /** Sign-ups that never verified their email are removed after this many days. */
  unverifiedDays: number;
  /** Guest (anonymous) users with no live session are removed after this many days. */
  guestDays: number;
}

export interface RetentionResult {
  sessions: number;
  verifications: number;
  unverifiedUsers: number;
  guests: number;
  rateLimits: number;
  signinFailures: number;
  workspaces: number;
}

/**
 * One clean-up pass, run as the API's own role: everything here is data the platform no longer
 * needs and nobody can use. Deleting a user cascades to its sessions, accounts, memberships and
 * activity with the table owner's rights (migration 0005 keeps DELETE on those away from the role).
 * Returns null when another instance holds the pass (transaction-scoped advisory lock).
 */
export async function runRetention(db: Db, policy: RetentionPolicy): Promise<RetentionResult | null> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended('onboard-retention', 0)) as ok`);
    if (!rows[0]?.ok) return null;
    const removed = async (q: SQL) => (await tx.execute(q)).rowCount ?? 0;
    return {
      // A day of grace so a session that just expired can still be told apart from a forged one in logs.
      sessions: await removed(sql`delete from sessions where expires_at < now() - interval '1 day'`),
      verifications: await removed(sql`delete from verifications where expires_at < now()`),
      // Username/password sign-ups that never verified, so never signed in (requireEmailVerification):
      // nothing of theirs exists beyond the row. Only those: a Google or GitHub user can be stored with
      // email_verified = false (the provider's flag) and still uses the platform, session or not, so
      // any other sign-in method keeps the user, and so does any session row or activity. Admins stay.
      unverifiedUsers: await removed(sql`
        delete from users u
        where u.email_verified = false and coalesce(u.is_anonymous, false) = false and u.role <> 'admin'
          and u.created_at < now() - make_interval(days => ${policy.unverifiedDays})
          and exists (select 1 from accounts a where a.user_id = u.id and a.provider_id = 'credential')
          and not exists (select 1 from accounts a where a.user_id = u.id and a.provider_id <> 'credential')
          and not exists (select 1 from sessions s where s.user_id = u.id)
          and not exists (select 1 from activity_last_ping p where p.user_id = u.id)`),
      // Guests who are gone: old and without a session that is still valid.
      guests: await removed(sql`
        delete from users u
        where u.is_anonymous = true and u.created_at < now() - make_interval(days => ${policy.guestDays})
          and not exists (select 1 from sessions s where s.user_id = u.id and s.expires_at > now())`),
      // Better Auth prunes its own rows after an hour; this catches anything left by a quiet period.
      rateLimits: await removed(sql`
        delete from rate_limits where last_request < (extract(epoch from now()) * 1000)::bigint - 86400000`),
      // Rows the lockout has forgotten anyway: a day past the last failure and the end of the last lock (limits.ts).
      signinFailures: await removed(sql`
        delete from signin_failures
        where greatest(last_failure_at, coalesce(locked_until, last_failure_at)) < now() - interval '1 day'`),
      // Personal workspaces whose user is gone (guests replaced by an account, users removed above).
      workspaces: await removed(sql`
        delete from organizations o
        where o.kind = 'personal' and o.created_at < now() - interval '1 day'
          and not exists (select 1 from memberships m where m.org_id = o.id)`),
    };
  });
}
