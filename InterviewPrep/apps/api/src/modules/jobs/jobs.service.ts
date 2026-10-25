import { Inject, Injectable } from '@nestjs/common';
import type { DocumentKind } from '@threatready/contracts';
import { interviewSessions, jobDescriptions, llmCallLog, reasoningAttempts, resumes } from '@threatready/db';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Database } from '../../platform/db/database.js';
import { queuePolicy, stageDeadlineSec } from '../../platform/adapters/pgboss-queue.adapter.js';
import { emitMetric, logger } from '../../platform/logging/logger.js';
import { JOBS, QUEUE_PORT, type JobContext, type QueuePort } from '../../platform/ports/queue.port.js';
import { LlmService } from '../ai/llm.service.js';
import { DocumentsService, FILE_RETENTION_DAYS } from '../documents/documents.service.js';
import { AnalysisService } from '../interview/analysis.service.js';
import { InterviewService } from '../interview/interview.service.js';
import { EVALUATING_LEASE_MS, evaluationStalled, recoverStalledEvaluation } from '../interview/recovery.js';
import { startPause } from '../interview/session.repo.js';
import { IDLE_PAUSE_MS, stopClock } from '../interview/timing.js';
import { EvaluationService } from '../reasoning/evaluation.service.js';
import { registeredDomains } from '../reasoning/domains/index.js';
import { GenerationService } from '../reasoning/generation.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { SCORING_VERSION } from '../scoring/scoring.js';
import { SkillsService } from '../skills/skills.service.js';

const ANALYSE_RETRY_LIMIT = 1;
/** An upload link lives five minutes; a document still waiting for its file after this was abandoned. */
const ABANDONED_UPLOAD_MS = 3600_000;

/**
 * Worker role (ADD L13): the same image, started with `worker`. Registers handlers, the sweeper
 * schedule and the dead-letter handler. The worker accepts no inbound connection.
 */
@Injectable()
export class JobsService {
  constructor(
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(Database) private readonly db: Database,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(AnalysisService) private readonly analysis: AnalysisService,
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(InterviewService) private readonly interviews: InterviewService,
    @Inject(GenerationService) private readonly generation: GenerationService,
    @Inject(EvaluationService) private readonly evaluation: EvaluationService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  /** The queue's retry windows for this configuration: the sweeper's deadlines must not undercut them. */
  private deadlineMs(job: 'analyse' | 'generate' | 'evaluate'): number {
    const policy = queuePolicy({
      llmTimeoutMsLarge: this.cfg.LLM_TIMEOUT_MS_LARGE,
      llmTimeoutMsSmall: this.cfg.LLM_TIMEOUT_MS_SMALL,
      llmMaxRetries: this.cfg.LLM_MAX_RETRIES,
      reasoningMaxGenerationTries: this.cfg.REASONING_MAX_GENERATION_TRIES,
    });
    const name = { analyse: JOBS.interviewAnalyse, generate: JOBS.reasoningGenerate, evaluate: JOBS.reasoningEvaluate }[job];
    return stageDeadlineSec(policy[name]) * 1000;
  }

  async startWorker(): Promise<void> {
    await this.queue.work<{ documentId: string; kind: DocumentKind }>(JOBS.documentExtract, (d) => this.documents.runExtraction(d.documentId, d.kind));
    await this.queue.work<{ sessionId: string }>(JOBS.interviewAnalyse, (d, ctx: JobContext) => this.analysis.run(d.sessionId, ctx.retryCount >= ANALYSE_RETRY_LIMIT));
    await this.queue.work<{ sessionId: string }>(JOBS.interviewFinalScoring, (d) => this.reports.runFinalScoring(d.sessionId));
    await this.queue.work<{ evaluationId: string }>(JOBS.reportPdf, (d) => this.reports.runPdf(d.evaluationId));
    await this.queue.work<{ evaluationId: string }>(JOBS.emailSend, (d) => this.reports.runEmail(d.evaluationId));
    await this.queue.work<{ userId: string }>(JOBS.skillsRecalculate, (d) => this.skills.recalculate(d.userId));
    await this.queue.work<{ attemptId: string }>(JOBS.reasoningGenerate, (d) => this.generation.runGeneration(d.attemptId));
    await this.queue.work<{ attemptId: string }>(JOBS.reasoningEvaluate, (d) => this.evaluation.runEvaluation(d.attemptId));
    // Registered even when the pool is off, so jobs a persisted schedule still enqueues complete as no-ops.
    await this.queue.work<{ domain?: string; difficulty?: string; userId?: string }>(JOBS.reasoningPoolRefill, (d) => (d?.domain && d?.difficulty ? this.generation.refillPool(d) : this.fanOutRefill()));
    await this.queue.work<Record<string, unknown>>(JOBS.deadLetter, (d) => this.onDeadLetter(d));
    await this.queue.work(JOBS.interviewSweep, () => this.sweep());
    await this.queue.schedule(JOBS.interviewSweep, '*/5 * * * *');
    if (this.cfg.REASONING_POOL_ENABLED) {
      // Keep the buckets learners use stocked (demand-driven targets); a start only fills what is short.
      await this.queue.schedule(JOBS.reasoningPoolRefill, '*/15 * * * *');
      await this.queue.enqueue(JOBS.reasoningPoolRefill, { kind: 'reasoning_pool_refill' }, { key: `startup:${Math.floor(Date.now() / 60_000)}` });
    } else {
      // Schedules are persisted in the queue's tables: switching the pool off must remove the one an
      // earlier start created, or it keeps firing (audit TR-10).
      await this.queue.unschedule(JOBS.reasoningPoolRefill);
    }
    logger.info('worker started');
  }

  /**
   * The schedule's refill: one short job per domain and difficulty that is short of its demand-driven
   * target (GenerationService.needed), so no single job outlives its expiry as domains are added and
   * an idle platform queues nothing. Intermediate buckets first, then beginner, then advanced, so
   * every domain gets questions early when the daily pool budget is the limit.
   */
  async fanOutRefill(): Promise<void> {
    if (!this.cfg.REASONING_POOL_ENABLED) return;
    const minute = Math.floor(Date.now() / 60_000);
    for (const difficulty of ['intermediate', 'beginner', 'advanced'] as const) {
      for (const d of registeredDomains()) {
        if ((await this.generation.needed(d.key, difficulty)) <= 0) continue;
        await this.queue.enqueue(JOBS.reasoningPoolRefill, { kind: 'reasoning_pool_refill', domain: d.key, difficulty }, { key: `fanout:${d.key}:${difficulty}:${minute}` });
      }
    }
  }

  /** The owning row moves to failed with a code, so the user sees a state, not a spinner (LLD-19). */
  async onDeadLetter(d: Record<string, unknown>): Promise<void> {
    emitMetric('DeadLetterJobs', 1, 'Count', { Kind: String(d.kind ?? 'unknown') });
    logger.error({ kind: d.kind }, 'job dead-lettered');
    if (d.kind === 'final_scoring' && typeof d.sessionId === 'string') await this.reports.markScoringFailed(d.sessionId, 'LLM_PROVIDER_UNAVAILABLE');
    if (d.kind === 'analyse' && typeof d.sessionId === 'string') await this.analysis.markFailed(d.sessionId, 'PARSE_FAILED');
    // Attack Reasoning: the learner sees a failed state with a retry, never a lost attempt (spec §9).
    if (d.kind === 'reasoning_generate' && typeof d.attemptId === 'string') await this.generation.markFailed(d.attemptId, 'REASONING_GENERATION_FAILED');
    if (d.kind === 'reasoning_evaluate' && typeof d.attemptId === 'string') await this.evaluation.markFailed(d.attemptId, 'REASONING_EVALUATION_FAILED');
    if (typeof d.documentId === 'string') {
      for (const table of [resumes, jobDescriptions]) {
        await this.db.system(({ db }) =>
          db.update(table).set({ status: 'failed', failureCode: 'RESUME_UNREADABLE' }).where(and(eq(table.id, d.documentId as string), eq(table.status, 'extracting'))),
        );
      }
    }
  }

  /** Timeouts from the state machine (LLD-3), ledger reconciliation and file retention. */
  async sweep(): Promise<void> {
    const now = Date.now();
    const at = (ms: number) => new Date(now - ms);
    await this.db.system(async (tx) => {
      const { db } = tx;
      // awaiting_answer, 10 minutes idle -> paused
      const idle = await db.select().from(interviewSessions).where(and(eq(interviewSessions.state, 'awaiting_answer'), lt(interviewSessions.lastActivityAt, at(IDLE_PAUSE_MS))));
      for (const s of idle) {
        const pausedAt = new Date(s.lastActivityAt.getTime() + IDLE_PAUSE_MS);
        const clock = stopClock({ activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince }, pausedAt);
        await db
          .update(interviewSessions)
          .set({ state: 'paused', ...clock, integrity: startPause('idlePauseCount', pausedAt), version: sql`${interviewSessions.version} + 1` })
          .where(and(eq(interviewSessions.id, s.id), eq(interviewSessions.state, 'awaiting_answer')));
      }
      // evaluating past its lease (the evaluation was lost mid-call) -> continue as after a failed evaluation (TR-23)
      const stalled = await db.select().from(interviewSessions).where(and(eq(interviewSessions.state, 'evaluating'), lt(interviewSessions.lastActivityAt, at(EVALUATING_LEASE_MS))));
      for (const s of stalled) {
        if (evaluationStalled(s, now)) await recoverStalledEvaluation(tx, s, (t, row, reason, extra) => this.interviews.complete(t, row, reason, extra)).catch(() => undefined);
      }
      // paused 24 hours, or a question stream abandoned for 24 hours -> completed with what exists
      const stale = await db
        .select()
        .from(interviewSessions)
        .where(and(inArray(interviewSessions.state, ['paused', 'asking', 'evaluating']), lt(interviewSessions.lastActivityAt, at(24 * 3600_000))));
      for (const s of stale) await this.interviews.complete(tx, s, 'inactive_24h').catch(() => undefined);
      // planned or profiled for 7 days -> expired
      await db
        .update(interviewSessions)
        .set({ state: 'expired', endReason: 'unused_7d' })
        .where(and(inArray(interviewSessions.state, ['planned', 'profiled']), lt(interviewSessions.updatedAt, at(7 * 24 * 3600_000))));
      // a parse job that never finished (past every attempt and backoff the queue may still run) -> failed
      await db
        .update(interviewSessions)
        .set({ state: 'failed', failureCode: 'PARSE_FAILED', failureStage: 'analysis' })
        .where(and(eq(interviewSessions.state, 'parsing'), lt(interviewSessions.updatedAt, at(this.deadlineMs('analyse')))));
      // budget reservations never settled (process died mid-call) -> failed
      await db.update(llmCallLog).set({ status: 'failed', errorKind: 'abandoned' }).where(and(eq(llmCallLog.status, 'reserved'), lt(llmCallLog.createdAt, at(3600_000))));
      // Attack Reasoning: a stage left running past its queue window (every attempt, expiry and backoff) -> failed with a retry.
      await db
        .update(reasoningAttempts)
        .set({ state: 'generation_failed', failureCode: 'REASONING_GENERATION_FAILED', failureStage: 'generation', updatedAt: new Date() })
        .where(and(eq(reasoningAttempts.state, 'generating'), lt(reasoningAttempts.updatedAt, at(this.deadlineMs('generate')))));
      await db
        .update(reasoningAttempts)
        .set({ state: 'evaluation_failed', failureCode: 'REASONING_EVALUATION_FAILED', failureStage: 'evaluation', updatedAt: new Date() })
        .where(and(eq(reasoningAttempts.state, 'evaluating'), lt(reasoningAttempts.updatedAt, at(this.deadlineMs('evaluate')))));
      // Attack Reasoning: a question left unanswered for REASONING_READY_TTL_HOURS is skipped, so a shared
      // question cannot stay open indefinitely while its answer key circulates (audit TR-42). The skip
      // counts as 0 only for questions opened under that rule (skip_counts, audit BIZ-09); the view's
      // expiresAt told the learner when. After a submission the daily quota or an AI budget refused, not
      // before the TTL has also passed since the next 00:00 UTC (readyDeadline, audit final review BIZ-07):
      // next midnight after submit_refused_at + TTL <= now exactly when submit_refused_at < the UTC day of now - TTL.
      if (this.cfg.REASONING_READY_TTL_HOURS > 0) {
        const ttlAgo = at(this.cfg.REASONING_READY_TTL_HOURS * 3600_000);
        const ttlAgoDay = new Date(ttlAgo);
        ttlAgoDay.setUTCHours(0, 0, 0, 0);
        await db
          .update(reasoningAttempts)
          .set({ state: 'abandoned', updatedAt: new Date(), version: sql`${reasoningAttempts.version} + 1` })
          .where(
            and(
              eq(reasoningAttempts.state, 'ready'),
              lt(reasoningAttempts.openedAt, ttlAgo),
              or(isNull(reasoningAttempts.submitRefusedAt), lt(reasoningAttempts.submitRefusedAt, ttlAgoDay)),
            ),
          );
      }
    });
    const purged = await this.documents.purgeOldFiles(new Date(now - FILE_RETENTION_DAYS * 24 * 3600_000));
    if (purged) logger.info({ purged }, 'retention: uploaded files deleted');
    const abandoned = await this.documents.sweepAbandonedUploads(new Date(now - ABANDONED_UPLOAD_MS));
    if (abandoned) logger.info({ abandoned }, 'abandoned uploads deleted');
    const resumed = await this.resumePausedScoring();
    if (resumed) logger.info({ resumed }, 'paused report generation resumed');
  }

  /**
   * Reports the daily AI breaker refused (failure code AI_SERVICE_PAUSED) are generated once it closes,
   * normally at 00:00 UTC, without the learner having to come back and retry (audit IP-REG0).
   */
  async resumePausedScoring(): Promise<number> {
    const paused = await this.db.system(({ db }) =>
      db
        .select()
        .from(interviewSessions)
        .where(and(eq(interviewSessions.state, 'failed'), eq(interviewSessions.failureStage, 'scoring'), eq(interviewSessions.failureCode, 'AI_SERVICE_PAUSED')))
        .limit(50),
    );
    if (!paused.length) return 0;
    const first = paused[0]!;
    try {
      // The breaker is global: one check answers for every session (no source, so one session's own
      // ceiling cannot hold the others back; each run meets its ceiling itself).
      await this.llm.check({ feature: 'interview.final_scoring', owner: { userId: first.userId, orgId: first.orgId }, budget: 'finalize' }, 0);
    } catch {
      return 0;
    }
    let resumed = 0;
    for (const s of paused) {
      await this.db.system(async (tx) => {
        const [row] = await tx.db
          .update(interviewSessions)
          .set({ state: 'scoring', failureCode: null, failureStage: null, version: sql`${interviewSessions.version} + 1`, updatedAt: new Date() })
          .where(and(eq(interviewSessions.id, s.id), eq(interviewSessions.state, 'failed'), eq(interviewSessions.failureCode, 'AI_SERVICE_PAUSED')))
          .returning({ id: interviewSessions.id });
        if (!row) return;
        await this.queue.enqueue(JOBS.interviewFinalScoring, { kind: 'final_scoring', sessionId: s.id }, { key: `${s.id}:${SCORING_VERSION}:resume:${s.version}` }, tx);
        resumed++;
      });
    }
    return resumed;
  }
}
