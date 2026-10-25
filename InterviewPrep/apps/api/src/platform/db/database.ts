import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { schema } from '@threatready/db';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { Principal } from '../authz/principal.js';
import { logger } from '../logging/logger.js';

export type Db = NodePgDatabase<typeof schema>;

/** Minimal SQL surface pg-boss needs to enqueue inside our transaction (L13). */
export interface SqlExecutor {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface Tx {
  db: Db;
  sql: SqlExecutor;
  /**
   * Executor for pg-boss statements inside this transaction. In a user transaction it steps out
   * of tr_app_user for the queue's own tables only, then restores it, so the enqueue commits or
   * rolls back with the state change while user data stays behind RLS.
   */
  queueSql: SqlExecutor;
}

/**
 * Two kinds of transaction:
 *  - user(): the API path. Assumes tr_app_user and sets app.user_id, so RLS is the backstop
 *    under every scoped repository query (ADD L7). Tasks connect without a transaction pooler,
 *    so the per-transaction setting works.
 *  - system(): the worker path, with the worker's own role.
 */
@Injectable()
export class Database implements OnApplicationShutdown {
  readonly pool: pg.Pool;
  /** Pool-level handle for statements that need no user scope (auth adapter, health). */
  readonly db: Db;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    const url = process.env.APP_ROLE === 'worker' ? cfg.WORKER_DATABASE_URL ?? cfg.DATABASE_URL : cfg.DATABASE_URL;
    this.pool = new pg.Pool({
      connectionString: url,
      max: cfg.DATABASE_POOL_MAX,
      application_name: `threatready-${process.env.APP_ROLE ?? 'api'}`,
      statement_timeout: 15_000,
      // A saturated or unreachable database fails a request in 5 s instead of queueing it forever.
      connectionTimeoutMillis: 5_000,
    });
    // An idle client's connection dropping (database restart, network blip) must not crash the process.
    this.pool.on('error', (err) => logger.error({ err: { message: err.message } }, 'database pool client error'));
    this.db = drizzle({ client: this.pool, schema });
  }

  user<T>(principal: Pick<Principal, 'userId'>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(fn, async (c) => {
      await c.query('SET LOCAL ROLE tr_app_user');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [principal.userId]);
    });
  }

  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(fn);
  }

  private async run<T>(fn: (tx: Tx) => Promise<T>, setup?: (c: pg.PoolClient) => Promise<void>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (setup) await setup(client);
      const exec = (text: string, values?: unknown[]) => client.query(text, values as unknown[]);
      const tx: Tx = {
        db: drizzle({ client, schema }),
        sql: { executeSql: exec },
        queueSql: setup
          ? {
              executeSql: async (text, values) => {
                await client.query('SET LOCAL ROLE NONE');
                try {
                  return await exec(text, values);
                } finally {
                  await client.query('SET LOCAL ROLE tr_app_user');
                }
              },
            }
          : { executeSql: exec },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
