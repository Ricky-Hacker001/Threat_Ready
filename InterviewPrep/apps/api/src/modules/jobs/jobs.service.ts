import { Inject, Injectable } from '@nestjs/common';
import type { DocumentKind } from '@threatready/contracts';
import { interviewSessions, jobDescriptions, llmCallLog, resumes } from '@threatready/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { Database } from '../../platform/db/database.js';
import { emitMetric, logger } from '../../platform/logging/logger.js';
import { JOBS, QUEUE_PORT, type JobContext, type QueuePort } from '../../platform/ports/queue.port.js';
import { DocumentsService } from '../documents/documents.service.js';
import { AnalysisService } from '../interview/analysis.service.js';
import { InterviewService } from '../interview/interview.service.js';
import { IDLE_PAUSE_MS, stopClock } from '../interview/timing.js';
import { ReportsService } from '../reports/reports.service.js';
import { SkillsService } from '../skills/skills.service.js';

const ANALYSE_RETRY_LIMIT = 1;

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
  ) {}

  async startWorker(): Promise<void> {
    await this.queue.work<{ documentId: string; kind: DocumentKind }>(JOBS.documentExtract, (d) => this.documents.runExtraction(d.documentId, d.kind));
    await this.queue.work<{ sessionId: string }>(JOBS.interviewAnalyse, (d, ctx: JobContext) => this.analysis.run(d.sessionId, ctx.retryCount >= ANALYSE_RETRY_LIMIT));
    await this.queue.work<{ sessionId: string }>(JOBS.interviewFinalScoring, (d) => this.reports.runFinalScoring(d.sessionId));
    await this.queue.work<{ evaluationId: string }>(JOBS.reportPdf, (d) => this.reports.runPdf(d.evaluationId));
    await this.queue.work<{ evaluationId: string }>(JOBS.emailSend, (d) => this.reports.runEmail(d.evaluationId));
    await this.queue.work<{ userId: string }>(JOBS.skillsRecalculate, (d) => this.skills.recalculate(d.userId));
    await this.queue.work<Record<string, unknown>>(JOBS.deadLetter, (d) => this.onDeadLetter(d));
    await this.queue.work(JOBS.interviewSweep, () => this.sweep());
    await this.queue.schedule(JOBS.interviewSweep, '*/5 * * * *');
    logger.info('worker started');
  }

  /** The owning row moves to failed with a code, so the user sees a state, not a spinner (LLD-19). */
  async onDeadLetter(d: Record<string, unknown>): Promise<void> {
    emitMetric('DeadLetterJobs', 1, 'Count', { Kind: String(d.kind ?? 'unknown') });
    logger.error({ kind: d.kind }, 'job dead-lettered');
    if (d.kind === 'final_scoring' && typeof d.sessionId === 'string') await this.reports.markScoringFailed(d.sessionId, 'LLM_PROVIDER_UNAVAILABLE');
    if (d.kind === 'analyse' && typeof d.sessionId === 'string') await this.analysis.markFailed(d.sessionId, 'PARSE_FAILED');
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
        const clock = stopClock({ activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince }, new Date(s.lastActivityAt.getTime() + IDLE_PAUSE_MS));
        await db.update(interviewSessions).set({ state: 'paused', ...clock, version: sql`${interviewSessions.version} + 1` }).where(and(eq(interviewSessions.id, s.id), eq(interviewSessions.state, 'awaiting_answer')));
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
      // a parse job that never finished -> failed
      await db
        .update(interviewSessions)
        .set({ state: 'failed', failureCode: 'PARSE_FAILED', failureStage: 'analysis' })
        .where(and(eq(interviewSessions.state, 'parsing'), lt(interviewSessions.updatedAt, at(20 * 60_000))));
      // budget reservations never settled (process died mid-call) -> failed
      await db.update(llmCallLog).set({ status: 'failed', errorKind: 'abandoned' }).where(and(eq(llmCallLog.status, 'reserved'), lt(llmCallLog.createdAt, at(3600_000))));
    });
    const purged = await this.documents.purgeOldFiles(new Date(now - 30 * 24 * 3600_000));
    if (purged) logger.info({ purged }, 'retention: uploaded files deleted');
  }
}
