import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const DB = Symbol("DB");
export const PG_POOL = Symbol("PG_POOL");

export function createPool(url: string): pg.Pool {
  // Small pool per long-lived task (ADD L8): no transaction pooler, so the
  // per-transaction RLS setting and prepared statements behave.
  const pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
  // An idle client dropped by the server (RDS failover, restart, network blip)
  // emits 'error' on the pool. Unhandled, that kills the process.
  pool.on("error", (err) => {
    console.error(`[db] idle client error: ${err.message}`);
  });
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/**
 * Runs `fn` in a transaction scoped to one user. Every query inside sees only
 * that user's rows in RLS-protected tables. The setting is transaction-local
 * (third argument `true`), so it cannot leak to the next request on the same
 * pooled connection.
 */
export async function withUserTx<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
