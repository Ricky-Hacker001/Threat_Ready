import { idempotentUuid } from '@threatready/shared';
import { PgBoss } from 'pg-boss';
import type { SqlExecutor } from '../db/database.js';
import { logger } from '../logging/logger.js';
import { JOBS, type JobContext, type JobName, type QueuePort } from '../ports/queue.port.js';

/** The LLM timing a job's expiry is derived from (config values; see queuePolicy). */
export interface QueueTiming {
  llmTimeoutMsLarge: number;
  /** LLM_TIMEOUT_MS_SMALL; 20 s when not given. */
  llmTimeoutMsSmall?: number;
  llmMaxRetries: number;
  reasoningMaxGenerationTries: number;
}

/**
 * Retry policy per job (L13): retries with 30 s to 30 min backoff, then the dead-letter queue.
 * A job's expiry must exceed the worst-case LLM time of its handler, or pg-boss hands the job to a
 * second worker while the first is still calling the model and the spend doubles. Worst case per
 * LARGE call: LLM_TIMEOUT_MS_LARGE x (1 + LLM_MAX_RETRIES SDK retries) x 2 (LlmService retries an
 * invalid structured output once); per job: that x the number of sequential calls, plus 60 s.
 */
export function queuePolicy(t: QueueTiming): Record<JobName, { retryLimit: number; expireInSeconds: number }> {
  const perCallSec = Math.ceil((t.llmTimeoutMsLarge * (1 + t.llmMaxRetries) * 2) / 1000);
  const perSmallCallSec = Math.ceil(((t.llmTimeoutMsSmall ?? 20_000) * (1 + t.llmMaxRetries) * 2) / 1000);
  const forCalls = (n: number) => n * perCallSec + 60;
  return {
    [JOBS.documentExtract]: { retryLimit: 2, expireInSeconds: 120 },
    // ADD LLD-3: parsing fails after two attempts. Three sequential calls: the resume and the JD
    // profiles (SMALL), then the gap analysis (LARGE).
    [JOBS.interviewAnalyse]: { retryLimit: 1, expireInSeconds: Math.max(300, 2 * perSmallCallSec + forCalls(1)) },
    // Final scoring: assessment batches in parallel, then the summary. Two retries: every retry re-runs
    // every LARGE batch, so a persistent failure must not keep billing (audit 2026-10-15 §3.5).
    [JOBS.interviewFinalScoring]: { retryLimit: 2, expireInSeconds: Math.max(600, forCalls(2)) },
    [JOBS.reportPdf]: { retryLimit: 5, expireInSeconds: 120 },
    [JOBS.skillsRecalculate]: { retryLimit: 5, expireInSeconds: 120 },
    [JOBS.emailSend]: { retryLimit: 5, expireInSeconds: 60 },
    [JOBS.interviewSweep]: { retryLimit: 0, expireInSeconds: 120 },
    // Attack Reasoning (L17b): generation may regenerate internally (one call per try); the job retries cover provider outages.
    [JOBS.reasoningGenerate]: { retryLimit: 3, expireInSeconds: Math.max(600, forCalls(t.reasoningMaxGenerationTries)) },
    // Evaluation: three sequential LARGE stages.
    [JOBS.reasoningEvaluate]: { retryLimit: 3, expireInSeconds: Math.max(600, forCalls(3)) },
    // A batch is generated in parallel (each item up to the generation tries); one retry covers a provider blip, the schedule covers the rest.
    [JOBS.reasoningPoolRefill]: { retryLimit: 1, expireInSeconds: Math.max(1800, forCalls(t.reasoningMaxGenerationTries)) },
    [JOBS.deadLetter]: { retryLimit: 3, expireInSeconds: 60 },
  };
}

/**
 * How long a job can legitimately be in flight across all its attempts: each attempt up to its expiry,
 * plus the longest backoff before each retry (retryDelay 30 s doubling with jitter, capped at 30 min),
 * plus five minutes of queue polling slack. The sweeper must not fail a session or an attempt before
 * this, or it marks work failed that pg-boss is still running or about to retry (audit IP-REG3).
 */
export function stageDeadlineSec(policy: { retryLimit: number; expireInSeconds: number }): number {
  let backoff = 0;
  for (let r = 1; r <= policy.retryLimit; r++) backoff += Math.min(RETRY_DELAY_MAX_SEC, RETRY_DELAY_SEC * 2 ** r);
  return policy.expireInSeconds * (policy.retryLimit + 1) + backoff + 300;
}

const RETRY_DELAY_SEC = 30;
const RETRY_DELAY_MAX_SEC = 1800;

/** Defaults matching the configuration defaults (LLM_TIMEOUT_MS_LARGE=120000, LLM_TIMEOUT_MS_SMALL=20000, LLM_MAX_RETRIES=2, 3 generation tries). */
export const DEFAULT_TIMING: QueueTiming = { llmTimeoutMsLarge: 120_000, llmTimeoutMsSmall: 20_000, llmMaxRetries: 2, reasoningMaxGenerationTries: 3 };

export class PgBossQueueAdapter implements QueuePort {
  private readonly boss: PgBoss;
  private readonly policy: Record<JobName, { retryLimit: number; expireInSeconds: number }>;
  private started: Promise<void> | null = null;

  constructor(connectionString: string, private readonly role: 'api' | 'worker', timing: QueueTiming = DEFAULT_TIMING) {
    this.boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: `threatready-${role}-queue`, max: 4 });
    this.boss.on('error', (err) => logger.error({ err: { message: err.message } }, 'pg-boss error'));
    this.policy = queuePolicy(timing);
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start();
      // The dead-letter queue must exist before the queues that reference it.
      const names = [JOBS.deadLetter, ...Object.keys(this.policy).filter((n) => n !== JOBS.deadLetter)] as JobName[];
      for (const name of names) {
        const policy = this.policy[name];
        const existing = await this.boss.getQueue(name);
        const options = {
          retryLimit: policy.retryLimit,
          retryDelay: RETRY_DELAY_SEC,
          retryBackoff: true,
          retryDelayMax: RETRY_DELAY_MAX_SEC,
          expireInSeconds: policy.expireInSeconds,
          ...(name === JOBS.deadLetter ? {} : { deadLetter: JOBS.deadLetter }),
        };
        if (!existing) await this.boss.createQueue(name, options);
        // Queues outlive deploys: bring the retry limit and expiry of an existing queue up to date.
        else if (existing.retryLimit !== options.retryLimit || existing.expireInSeconds !== options.expireInSeconds) {
          await this.boss.updateQueue(name, { retryLimit: options.retryLimit, expireInSeconds: options.expireInSeconds });
        }
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

  async unschedule(job: JobName): Promise<void> {
    await this.start();
    await this.boss.unschedule(job);
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
