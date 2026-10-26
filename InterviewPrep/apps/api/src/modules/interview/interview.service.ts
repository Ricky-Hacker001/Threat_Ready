import { Inject, Injectable } from '@nestjs/common';
import {
  RESUMABLE_STATES,
  TERMINAL_STATES,
  type Briefing,
  type CreateInterviewRequest,
  type PlanInterviewRequest,
  type SessionList,
  type SessionView,
} from '@threatready/contracts';
import { evaluations, interviewSessions, interviewTurns, jobDescriptions, resumes } from '@threatready/db';
import { DomainError, secondsUntilUtcMidnight } from '@threatready/shared';
import { and, count, desc, eq, gte, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import { countsTowardQuota } from './quota.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { Principal } from '../../platform/authz/principal.js';
import { ContentService } from '../../platform/content/content.service.js';
import { Database, type Tx } from '../../platform/db/database.js';
import { cursorBefore, cursorOf } from '../../platform/http/cursor.js';
import { JOBS, QUEUE_PORT, type QueuePort } from '../../platform/ports/queue.port.js';
import { LlmService } from '../ai/llm.service.js';
import { PARSER_VERSION } from '../ai/prompts/documents.prompts.js';
import { SCORING_VERSION } from '../scoring/scoring.js';
import { analysisOf, type SessionAnalysis } from './analysis.service.js';
import { emptyProgress } from './plan.types.js';
import { applyCorrections, buildPlan } from './planner.js';
import { evaluationStalled, recoverStalledEvaluation } from './recovery.js';
import {
  buildSessionView,
  configOf,
  endPause,
  integrityOf,
  loadOwnedSession,
  MAX_REPORT_RETRIES,
  progressOf,
  SCORING_CEILING_CODE,
  scoringBilledSince,
  startPause,
  tabHidden,
  transition,
  type SessionPatch,
  type SessionRow,
} from './session.repo.js';
import { IDLE_PAUSE_MS, stopClock, startClock } from './timing.js';

@Injectable()
export class InterviewService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  view(tx: Tx, s: SessionRow): Promise<SessionView> {
    return buildSessionView(tx, s, this.content, analysisOf(s)?.roleTitle ?? null, this.cfg.INTERVIEW_MAX_PAUSES);
  }

  async create(p: Principal, req: CreateInterviewRequest): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const [resume] = await tx.db.select().from(resumes).where(and(eq(resumes.id, req.resumeDocumentId), eq(resumes.userId, p.userId)));
      if (!resume) throw new DomainError('RESUME_NOT_FOUND');
      const [jd] = await tx.db.select().from(jobDescriptions).where(and(eq(jobDescriptions.id, req.jdDocumentId), eq(jobDescriptions.userId, p.userId)));
      if (!jd) throw new DomainError('JD_NOT_FOUND');
      if (resume.status !== 'extracted' || jd.status !== 'extracted') throw new DomainError('DOCUMENT_NOT_READY');

      // Entitlement (L7 step 5) and session quotas, read from PostgreSQL.
      await tx.sql.executeSql('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [p.userId]);
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const [{ n: thisMonth } = { n: 0 }] = await tx.db
        .select({ n: count() })
        .from(interviewSessions)
        .where(and(eq(interviewSessions.userId, p.userId), gte(interviewSessions.createdAt, monthStart), countsTowardQuota));
      if (thisMonth >= this.cfg.INTERVIEW_MONTHLY_QUOTA_FREE) throw new DomainError('ENTITLEMENT_QUOTA_EXCEEDED');
      const [{ n: open } = { n: 0 }] = await tx.db
        .select({ n: count() })
        .from(interviewSessions)
        .where(and(eq(interviewSessions.userId, p.userId), notInArray(interviewSessions.state, [...TERMINAL_STATES, 'scoring', 'completed'])));
      if (open >= this.cfg.INTERVIEW_MAX_OPEN_SESSIONS) throw new DomainError('INTERVIEW_LIMIT_REACHED', { message: 'Finish or cancel an open interview before starting another' });
      const { rows } = await tx.sql.executeSql('SELECT ai_spend_today_usd() AS total');
      if (Number((rows[0] as { total: string }).total) >= this.cfg.AI_GLOBAL_DAILY_CAP_USD) throw new DomainError('AI_SERVICE_PAUSED');

      const [s] = await tx.db
        .insert(interviewSessions)
        .values({
          orgId: p.orgId,
          userId: p.userId,
          resumeId: resume.id,
          jobDescriptionId: jd.id,
          state: 'parsing',
          progress: emptyProgress(),
          aiConsentVersion: req.aiProcessingConsent.version,
          aiConsentAt: new Date(),
        })
        .returning();
      await this.queue.enqueue(JOBS.interviewAnalyse, { kind: 'analyse', sessionId: s!.id }, { key: `${s!.id}:${PARSER_VERSION}` }, tx);
      return this.view(tx, s!);
    });
  }

  async get(p: Principal, id: string): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      let s = await loadOwnedSession(tx, p.userId, id);
      // Lazy idle pause (LLD-3: 10 minutes idle while awaiting an answer).
      if (s.state === 'awaiting_answer' && Date.now() - s.lastActivityAt.getTime() > IDLE_PAUSE_MS) {
        const pausedAt = new Date(s.lastActivityAt.getTime() + IDLE_PAUSE_MS);
        const clock = stopClock({ activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince }, pausedAt);
        s = await transition(tx, s, ['awaiting_answer'], { state: 'paused', ...clock, integrity: startPause('idlePauseCount', pausedAt) }).catch(() => s);
      }
      // An evaluation lost mid-call: move on as after a failed evaluation (TR-23).
      if (evaluationStalled(s)) s = await recoverStalledEvaluation(tx, s, (t, row, reason, extra) => this.complete(t, row, reason, extra)).catch(() => s);
      return this.view(tx, s);
    });
  }

  async list(p: Principal, cursor: string | undefined, limit = 20): Promise<SessionList> {
    return this.db.user(p, async (tx) => {
      const before = cursorBefore(cursor);
      const rows = await tx.db
        .select({
          s: interviewSessions,
          score: evaluations.overallScore,
          answered: sql<number>`(select count(*)::int from ${interviewTurns} t where t.session_id = ${interviewSessions.id} and t.answer is not null)`,
        })
        .from(interviewSessions)
        .leftJoin(evaluations, eq(evaluations.sessionId, interviewSessions.id))
        .where(and(eq(interviewSessions.userId, p.userId), before ? lt(interviewSessions.createdAt, before) : undefined))
        .orderBy(desc(interviewSessions.createdAt))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map(({ s, score, answered }) => {
        const cfg = configOf(s);
        return {
          id: s.id,
          state: s.state,
          roleTitle: analysisOf(s)?.roleTitle ?? null,
          interviewType: cfg?.interviewType ?? null,
          difficulty: cfg?.difficulty ?? null,
          durationMin: cfg?.durationMin ?? null,
          overallScore: score ?? null,
          questionsAnswered: Number(answered),
          createdAt: s.createdAt.toISOString(),
          completedAt: s.completedAt?.toISOString() ?? null,
        };
      });
      const last = rows[limit - 1];
      return { items, nextCursor: rows.length > limit && last ? cursorOf(last.s.createdAt) : null };
    });
  }

  async briefing(p: Principal, id: string): Promise<Briefing> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state === 'parsing') throw new DomainError('PARSE_IN_PROGRESS');
      const a = analysisOf(s);
      if (!a) throw new DomainError('INTERVIEW_INVALID_STATE');
      const c = this.content.interview;
      const role = c.roles.get(a.job.role_id);
      const ids = new Set([...a.candidate.skills.map((x) => x.skill_id), ...a.job.required_skills.map((x) => x.skill_id), ...(role ? Object.keys(role.skills) : [])]);
      const focusPreview = [
        ...a.gaps.claims_to_verify.map((cl) => ({ skillId: cl.skill_id, label: this.content.skillLabel(cl.skill_id), reason: 'verify_claim' as const })),
        ...a.gaps.gaps.map((g) => ({ skillId: g.skill_id, label: this.content.skillLabel(g.skill_id), reason: 'probe_gap' as const })),
      ].slice(0, 12);
      return {
        sessionId: s.id,
        candidateProfile: a.candidate,
        jobProfile: a.job,
        recommendation: a.recommendation,
        skills: [...ids].filter((x) => c.skills.has(x)).map((x) => ({ id: x, label: c.skills.get(x)!.label, category: c.skills.get(x)!.category })),
        focusPreview,
        roleLabel: role?.label ?? 'Technical role',
      };
    });
  }

  /** The candidate confirms (and may correct) the extracted details; the plan is built in code. */
  async plan(p: Principal, id: string, req: PlanInterviewRequest): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id, true);
      if (s.state !== 'profiled' && s.state !== 'planned') throw new DomainError('INTERVIEW_INVALID_STATE');
      const a = analysisOf(s)!;
      const { candidate, job } = applyCorrections(a.candidate, a.job, req.corrections);
      const plan = buildPlan({ c: this.content.interview, candidate, job, gaps: a.gaps, config: req.config });
      const analysis: SessionAnalysis = { ...a, candidate, job, confirmedAt: new Date().toISOString() };
      const next = await transition(tx, s, ['profiled', 'planned'], { state: 'planned', config: req.config, plan, analysis, progress: emptyProgress(), lastActivityAt: new Date() });
      return this.view(tx, next);
    });
  }

  /**
   * Pausing stops the clock and withholds the question until resume; every pause and the time spent
   * paused are recorded for the report (TR-24). INTERVIEW_MAX_PAUSES (0 = unlimited) caps the count.
   */
  async pause(p: Principal, id: string): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state === 'paused') return this.view(tx, s);
      if (s.state !== 'awaiting_answer') throw new DomainError(s.state === 'evaluating' || s.state === 'asking' ? 'INTERVIEW_TURN_IN_PROGRESS' : 'INTERVIEW_INVALID_STATE');
      const max = this.cfg.INTERVIEW_MAX_PAUSES;
      if (max > 0 && (integrityOf(s).pauseCount ?? 0) >= max) throw new DomainError('INTERVIEW_PAUSE_LIMIT_REACHED', { details: { maxPauses: max } });
      const now = new Date();
      const clock = stopClock({ activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince }, now);
      return this.view(tx, await transition(tx, s, ['awaiting_answer'], { state: 'paused', ...clock, lastActivityAt: now, integrity: startPause('pauseCount', now) }));
    });
  }

  async resume(p: Principal, id: string): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state === 'awaiting_answer') return this.view(tx, s);
      if (s.state !== 'paused') throw new DomainError('INTERVIEW_INVALID_STATE');
      if (!s.currentTurnId) throw new DomainError('INTERVIEW_INVALID_STATE');
      const clock = startClock({ activeElapsedMs: s.activeElapsedMs, runningSince: null });
      return this.view(tx, await transition(tx, s, ['paused'], { state: 'awaiting_answer', ...clock, lastActivityAt: new Date(), integrity: endPause() }));
    });
  }

  /**
   * The browser reports that the interview tab was hidden (sent when it is visible again). Counted for
   * the report only; never part of the score. Ignored once the interview is over.
   */
  async recordTabHidden(p: Principal, id: string, hiddenMs = 0): Promise<void> {
    await this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (!['asking', 'awaiting_answer', 'evaluating', 'paused'].includes(s.state)) return;
      await tx.db
        .update(interviewSessions)
        .set({ integrity: tabHidden(hiddenMs) })
        .where(eq(interviewSessions.id, s.id));
    });
  }

  async end(p: Principal, id: string): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (['completed', 'scoring', 'report_ready'].includes(s.state)) return this.view(tx, s);
      // A turn whose evaluation or question stream was lost (lease expired) does not block ending.
      const askingLease = progressOf(s).askingLeaseUntil;
      const askingStalled = s.state === 'asking' && (!askingLease || new Date(askingLease).getTime() < Date.now());
      if (evaluationStalled(s) || askingStalled) return this.view(tx, await this.complete(tx, s, 'candidate_ended'));
      if (s.state === 'evaluating' || s.state === 'asking') throw new DomainError('INTERVIEW_TURN_IN_PROGRESS');
      if (!['awaiting_answer', 'paused', 'planned'].includes(s.state)) throw new DomainError('INTERVIEW_INVALID_STATE');
      return this.view(tx, await this.complete(tx, s, 'candidate_ended'));
    });
  }

  async cancel(p: Principal, id: string): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state === 'cancelled') return this.view(tx, s);
      if (!['parsing', 'profiled', 'planned'].includes(s.state)) throw new DomainError('INTERVIEW_INVALID_STATE');
      return this.view(tx, await transition(tx, s, ['parsing', 'profiled', 'planned'], { state: 'cancelled', endReason: 'cancelled' }));
    });
  }

  /**
   * completed -> scoring: the final-scoring job is enqueued in the same transaction (LLD-6).
   * A session with no answers has nothing to score and ends as expired.
   */
  async complete(tx: Tx, s: SessionRow, reason: string, extra: SessionPatch = {}): Promise<SessionRow> {
    const clock = stopClock({ activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince });
    // Ending while paused closes the pause, so the report shows the real paused time.
    if (s.state === 'paused' && !extra.integrity) extra = { ...extra, integrity: endPause() };
    const [{ n } = { n: 0 }] = await tx.db
      .select({ n: count() })
      .from(interviewTurns)
      .where(and(eq(interviewTurns.sessionId, s.id), isNotNull(interviewTurns.answer)));
    if (n === 0) {
      return transition(tx, s, [s.state], { evaluatingLeaseUntil: null, ...extra, state: 'expired', ...clock, completedAt: new Date(), endReason: `${reason}_no_answers` });
    }
    // An ended interview holds no evaluating lease (security patch 2, A2), whichever path ended it.
    const next = await transition(tx, s, [s.state], { evaluatingLeaseUntil: null, ...extra, state: 'scoring', ...clock, completedAt: new Date(), endReason: reason });
    await this.queue.enqueue(JOBS.interviewFinalScoring, { kind: 'final_scoring', sessionId: s.id }, { key: `${s.id}:${SCORING_VERSION}` }, tx);
    return next;
  }

  /**
   * Manual "generate again" for a failed report (audit 2026-10-23 IP-REG0). Every billed attempt re-runs
   * the LARGE scoring batches, so attempts are capped at MAX_REPORT_RETRIES; but an attempt that never
   * reached the provider (an outage, AI paused for the day) costs nothing and does not count, and while
   * AI is paused the retry is refused with the time it resumes instead of being used up.
   */
  async retryReport(p: Principal, id: string): Promise<SessionView> {
    const first = await this.db.user(p, (tx) => loadOwnedSession(tx, p.userId, id));
    if (first.state === 'failed' && first.failureStage === 'scoring') {
      // Final scoring already spent this session's whole ceiling (AI_FINALIZE_SOURCE_CAP_USD): another
      // attempt would only bill again (TR-08 IP-07).
      if (first.failureCode === SCORING_CEILING_CODE) throw new DomainError('REPORT_RETRY_LIMIT_REACHED');
      const blocked = await this.scoringBlocked(first);
      if (blocked === 'ceiling') throw new DomainError('REPORT_RETRY_LIMIT_REACHED');
      if (blocked === 'paused') {
        // Recorded as paused, so the sweeper generates it once the breaker closes (whatever failed first).
        await this.db.user(p, (tx) =>
          tx.db
            .update(interviewSessions)
            .set({ failureCode: 'AI_SERVICE_PAUSED', version: sql`${interviewSessions.version} + 1`, updatedAt: new Date() })
            .where(and(eq(interviewSessions.id, first.id), eq(interviewSessions.state, 'failed'), eq(interviewSessions.failureStage, 'scoring'))),
        );
        throw new DomainError('AI_SERVICE_PAUSED', {
          message: 'Report generation is paused until 00:00 UTC; your answers are saved and the report will be generated then',
          retryAfterSec: secondsUntilUtcMidnight(),
          retryable: false,
        });
      }
    }
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state === 'scoring' || s.state === 'report_ready') return this.view(tx, s);
      if (!(s.state === 'failed' && s.failureStage === 'scoring')) throw new DomainError('INTERVIEW_INVALID_STATE');
      const progress = progressOf(s);
      const billed = await scoringBilledSince(tx, s.id, progress.lastReportRetryAt);
      const count = (progress.retryReportCount ?? 0) + (billed ? 1 : 0);
      if (count > MAX_REPORT_RETRIES) throw new DomainError('REPORT_RETRY_LIMIT_REACHED');
      const next = await transition(tx, s, ['failed'], {
        state: 'scoring',
        failureCode: null,
        failureStage: null,
        progress: { ...progress, retryReportCount: count, lastReportRetryAt: new Date().toISOString() },
      });
      // A new key per manual retry (the version moves on every transition); the handler is idempotent on (session, scoring version).
      await this.queue.enqueue(JOBS.interviewFinalScoring, { kind: 'final_scoring', sessionId: s.id }, { key: `${s.id}:${SCORING_VERSION}:retry:${s.version}` }, tx);
      return this.view(tx, next);
    });
  }

  /**
   * Support's recovery for a report the learner can no longer retry (scripts/retry-report.ts --reset):
   * clears the retry count and, when final scoring stopped at its per-session ceiling, adds `extraUsd`
   * (one more AI_FINALIZE_SOURCE_CAP_USD by default) to that session's ceiling, so the next attempt
   * may bill that much again. Returns the extra spend the session's final scoring is now allowed.
   */
  async resetReportRetries(sessionId: string, extraUsd = this.cfg.AI_FINALIZE_SOURCE_CAP_USD): Promise<{ extraSourceCapUsd: number }> {
    return this.db.system(async ({ db }) => {
      const [s] = await db.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)).for('update');
      if (!s) throw new DomainError('INTERVIEW_SESSION_NOT_FOUND');
      const ceiling = s.state === 'failed' && s.failureStage === 'scoring' && s.failureCode === SCORING_CEILING_CODE;
      const extraSourceCapUsd = (progressOf(s).finalizeExtraUsd ?? 0) + (ceiling ? extraUsd : 0);
      const cleared = sql`(${interviewSessions.progress} - 'retryReportCount') - 'lastReportRetryAt'`;
      await db
        .update(interviewSessions)
        .set({
          progress: ceiling ? sql`${cleared} || jsonb_build_object('finalizeExtraUsd', ${extraSourceCapUsd}::numeric)` : cleared,
          ...(ceiling ? { failureCode: null } : {}),
          version: sql`${interviewSessions.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(interviewSessions.id, sessionId));
      return { extraSourceCapUsd };
    });
  }

  /**
   * Whether final scoring can run now: 'paused' while the daily AI breaker is open for it (refused
   * without using an attempt), 'ceiling' once this session's final scoring spent its ceiling.
   */
  private async scoringBlocked(s: SessionRow): Promise<'paused' | 'ceiling' | null> {
    try {
      const extraSourceCapUsd = progressOf(s).finalizeExtraUsd;
      await this.llm.check({ feature: 'interview.final_scoring', owner: { userId: s.userId, orgId: s.orgId }, sourceId: s.id, budget: 'finalize', extraSourceCapUsd }, 0);
      return null;
    } catch (err) {
      if (err instanceof DomainError && err.code === 'LLM_BUDGET_EXCEEDED' && (err.details as { scope?: string } | undefined)?.scope === 'finalize_source') return 'ceiling';
      if (err instanceof DomainError && (err.code === 'LLM_BUDGET_EXCEEDED' || err.code === 'AI_SERVICE_PAUSED')) return 'paused';
      throw err;
    }
  }

  /** Lightweight state probe for the SSE events stream. */
  async stateOf(p: Principal, id: string): Promise<{ state: string; version: number }> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      return { state: s.state, version: s.version };
    });
  }

  resumableStates = RESUMABLE_STATES;
}

