import { idempotentUuid } from '@threatready/shared';
import { PgBoss } from 'pg-boss';
import type { SqlExecutor } from '../db/database.js';
import { logger } from '../logging/logger.js';
import { JOBS, type JobContext, type JobName, type QueuePort } from '../ports/queue.port.js';

/** Retry policy per job (L13): five retries, 30 s to 30 min backoff, then the dead-letter queue. */
const QUEUE_POLICY: Record<JobName, { retryLimit: number; expireInSeconds: number }> = {
  [JOBS.documentExtract]: { retryLimit: 2, expireInSeconds: 120 },
  // ADD LLD-3: parsing fails after two attempts.
  [JOBS.interviewAnalyse]: { retryLimit: 1, expireInSeconds: 300 },
  [JOBS.interviewFinalScoring]: { retryLimit: 5, expireInSeconds: 600 },
  [JOBS.reportPdf]: { retryLimit: 5, expireInSeconds: 120 },
  [JOBS.skillsRecalculate]: { retryLimit: 5, expireInSeconds: 120 },
  [JOBS.emailSend]: { retryLimit: 5, expireInSeconds: 60 },
  [JOBS.interviewSweep]: { retryLimit: 0, expireInSeconds: 120 },
  // Attack Reasoning (L17b): generation may regenerate internally; the job retries cover provider outages.
  [JOBS.reasoningGenerate]: { retryLimit: 3, expireInSeconds: 600 },
  [JOBS.reasoningEvaluate]: { retryLimit: 3, expireInSeconds: 600 },
  [JOBS.deadLetter]: { retryLimit: 3, expireInSeconds: 60 },
};

export class PgBossQueueAdapter implements QueuePort {
  private readonly boss: PgBoss;
  private started: Promise<void> | null = null;

  constructor(connectionString: string, private readonly role: 'api' | 'worker') {
    this.boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: `threatready-${role}-queue`, max: 4 });
    this.boss.on('error', (err) => logger.error({ err: { message: err.message } }, 'pg-boss error'));
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start();
      // The dead-letter queue must exist before the queues that reference it.
      const names = [JOBS.deadLetter, ...Object.keys(QUEUE_POLICY).filter((n) => n !== JOBS.deadLetter)] as JobName[];
      for (const name of names) {
        const policy = QUEUE_POLICY[name];
        const existing = await this.boss.getQueue(name);
        const options = {
          retryLimit: policy.retryLimit,
          retryDelay: 30,
          retryBackoff: true,
          retryDelayMax: 1800,
          expireInSeconds: policy.expireInSeconds,
          ...(name === JOBS.deadLetter ? {} : { deadLetter: JOBS.deadLetter }),
        };
        if (!existing) await this.boss.createQueue(name, options);
      }
    })().catch((err: unknown) => {
      this.started = null;
      throw err;
    });
    return this.started;
  }

  async enqueue<T extends object>(job: JobName, data: T, opts: { key: string; runAt?: Date }, tx?: { queueSql: SqlExecutor }): Promise<void> {
    await this.start();
    // The id is derived from the idempotency key, so a second enqueue of the same key is a no-op.
    await this.boss.send(job, data, {
      id: idempotentUuid(`${job}:${opts.key}`),
      startAfter: opts.runAt,
      db: tx?.queueSql,
    });
  }

  async schedule(job: JobName, cron: string): Promise<void> {
    await this.start();
    await this.boss.schedule(job, cron, {});
  }

  async work<T>(job: JobName, handler: (data: T, ctx: JobContext) => Promise<void>): Promise<void> {
    await this.start();
    await this.boss.work<T>(job, { batchSize: 1 }, async (jobs) => {
      for (const j of jobs) {
        const started = Date.now();
        try {
          await handler(j.data, { jobId: j.id, retryCount: j.retryCount });
          logger.info({ job, job_id: j.id, retry: j.retryCount, ms: Date.now() - started }, 'job completed');
        } catch (err) {
          logger.warn({ job, job_id: j.id, retry: j.retryCount, err: { name: (err as Error).name, message: (err as Error).message } }, 'job failed');
          throw err;
        }
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined);
  }
}
