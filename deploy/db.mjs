// Database helpers for the launcher (deploy/start.mjs): connection-string handling, the migration
// lock and the record of releases that booted. Nothing here logs a connection string or a password.
import pg from 'pg';

/**
 * Neon strings say sslmode=require, which pg treats as verify-full today (and warns it will change).
 * State verify-full explicitly: same secure behaviour now and after pg v9.
 */
export const strictSsl = (url) => {
  const u = new URL(url);
  if (['require', 'prefer', 'verify-ca'].includes(u.searchParams.get('sslmode') ?? '')) u.searchParams.set('sslmode', 'verify-full');
  return u.toString();
};

/** Same database and host, different login: the API's least-privilege role (no BYPASSRLS). */
export function withUser(url, user, password) {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

/** pg_advisory_lock key for "schema migrations of this database" (any constant; same in every launcher). */
export const MIGRATION_LOCK_KEY = 7_263_614_001;

/**
 * Runs `fn` while holding a session-level advisory lock on that database, so two launchers (a deploy
 * overlapping the old instance, or a second instance) never prepare roles or migrate at the same time;
 * the second waits, then finds the work done. Needs a direct connection (not a transaction pooler,
 * which would drop the session lock). Waiting is bounded by `waitMs`; the error then fails the boot.
 */
export async function withAdvisoryLock(connectionString, key, fn, { waitMs = 10 * 60_000, log = () => {} } = {}) {
  const client = new pg.Client({ connectionString, application_name: 'threatready-launcher-migrate', connectionTimeoutMillis: 30_000 });
  await client.connect();
  try {
    const { rows: [{ locked }] } = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]);
    if (!locked) {
      log('another instance is migrating this database; waiting for it to finish');
      await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(waitMs))}`);
      await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
      await client.query('SET statement_timeout = 0');
    }
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Releases (code + settings) that have booted completely at least once; see releaseBooted(). */
export const BOOT_RECORD_TABLE = 'threatready_ops.launcher_boots';
const RELEASES_KEPT = 20;
const quoted = (name) => {
  const parts = String(name).split('.');
  if (parts.length > 2 || !parts.every((p) => /^[a-z_][a-z0-9_]{0,62}$/.test(p))) throw new Error(`invalid table name "${name}"`);
  return { schema: parts.length === 2 ? `"${parts[0]}"` : null, sql: parts.map((p) => `"${p}"`).join('.') };
};

/**
 * Has this release (an opaque fingerprint of the commit and the children's settings, see start.mjs)
 * booted completely before? A deploy of new code or new settings has not; a restart or a wake from
 * sleep of the same release has. Any error (no table yet, database unreachable) answers false: the
 * stricter boot rule then applies.
 */
export async function releaseBooted(connectionString, fingerprint, { table = BOOT_RECORD_TABLE, timeoutMs = 10_000 } = {}) {
  const t = quoted(table);
  const client = new pg.Client({ connectionString, application_name: 'threatready-launcher-boot', connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
  try {
    await client.connect();
    const { rows: [{ reg }] } = await client.query('SELECT to_regclass($1) AS reg', [t.sql]);
    if (!reg) return false;
    return (await client.query(`SELECT 1 FROM ${t.sql} WHERE fingerprint = $1`, [fingerprint])).rowCount > 0;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Notes that this release booted completely (table created if missing; the newest RELEASES_KEPT are kept). */
export async function recordBoot(connectionString, fingerprint, { table = BOOT_RECORD_TABLE } = {}) {
  const t = quoted(table);
  const client = new pg.Client({ connectionString, application_name: 'threatready-launcher-boot', connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
  await client.connect();
  try {
    if (t.schema) await client.query(`CREATE SCHEMA IF NOT EXISTS ${t.schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.sql} (fingerprint text PRIMARY KEY, first_booted_at timestamptz NOT NULL DEFAULT now(), last_booted_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`INSERT INTO ${t.sql} (fingerprint) VALUES ($1) ON CONFLICT (fingerprint) DO UPDATE SET last_booted_at = now()`, [fingerprint]);
    await client.query(`DELETE FROM ${t.sql} WHERE fingerprint IN (SELECT fingerprint FROM ${t.sql} ORDER BY last_booted_at DESC OFFSET ${RELEASES_KEPT})`);
  } finally {
    await client.end().catch(() => {});
  }
}
