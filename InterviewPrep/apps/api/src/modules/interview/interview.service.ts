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
import { DomainError } from '@threatready/shared';
import { and, count, desc, eq, gte, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import { countsTowardQuota } from './quota.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { Principal } from '../../platform/authz/principal.js';
import { ContentService } from '../../platform/content/content.service.js';
import { Database, type Tx } from '../../platform/db/database.js';
import { JOBS, QUEUE_PORT, type QueuePort } from '../../platform/ports/queue.port.js';
import { PARSER_VERSION } from '../ai/prompts/documents.prompts.js';
import { SCORING_VERSION } from '../scoring/scoring.js';
import { analysisOf, type SessionAnalysis } from './analysis.service.js';
import { emptyProgress } from './plan.types.js';
import { applyCorrections, buildPlan } from './planner.js';
import { buildSessionView, configOf, loadOwnedSession, progressOf, transition, type SessionRow } from './session.repo.js';
import { IDLE_PAUSE_MS, stopClock, startClock } from './timing.js';

@Injectable()
export class InterviewService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  view(tx: Tx, s: SessionRow): Promise<SessionView> {
    return buildSessionView(tx, s, this.content, analysisOf(s)?.roleTitle ?? null);
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
        const clock = stopClock({ activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince }, new Date(s.lastActivityAt.getTime() + IDLE_PAUSE_MS));
        s = await transition(tx, s, ['awaiting_answer'], { state: 'paused', ...clock }).catch(() => s);
      }
      return this.view(tx, s);
    });
  }

  async list(p: Principal, cursor: string | undefined, limit = 20): Promise<SessionList> {
    return this.db.user(p, async (tx) => {
      const before = cursor ? new Date(Buffer.from(cursor, 'base64url').toString()) : null;
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
      return { items, nextCursor: rows.length > limit && last ? Buffer.from(last.s.createdAt.toISOString()).toString('base64url') : null };
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

  async pause(p: Principal, id: string): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state === 'paused') return this.view(tx, s);
      if (s.state !== 'awaiting_answer') throw new DomainError(s.state === 'evaluating' || s.state === 'asking' ? 'INTERVIEW_TURN_IN_PROGRESS' : 'INTERVIEW_INVALID_STATE');
      const clock = stopClock({ activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince });
      return this.view(tx, await transition(tx, s, ['awaiting_answer'], { state: 'paused', ...clock, lastActivityAt: new Date() }));
    });
  }

  async resume(p: Principal, id: string): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state === 'awaiting_answer') return this.view(tx, s);
      if (s.state !== 'paused') throw new DomainError('INTERVIEW_INVALID_STATE');
      if (!s.currentTurnId) throw new DomainError('INTERVIEW_INVALID_STATE');
      const clock = startClock({ activeElapsedMs: s.activeElapsedMs, runningSince: null });
      return this.view(tx, await transition(tx, s, ['paused'], { state: 'awaiting_answer', ...clock, lastActivityAt: new Date() }));
    });
  }

  async end(p: Principal, id: string): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (['completed', 'scoring', 'report_ready'].includes(s.state)) return this.view(tx, s);
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
  async complete(tx: Tx, s: SessionRow, reason: string, extra: Partial<typeof interviewSessions.$inferInsert> = {}): Promise<SessionRow> {
    const clock = stopClock({ activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince });
    const [{ n } = { n: 0 }] = await tx.db
      .select({ n: count() })
      .from(interviewTurns)
      .where(and(eq(interviewTurns.sessionId, s.id), isNotNull(interviewTurns.answer)));
    if (n === 0) {
      return transition(tx, s, [s.state], { ...extra, state: 'expired', ...clock, completedAt: new Date(), endReason: `${reason}_no_answers` });
    }
    const next = await transition(tx, s, [s.state], { ...extra, state: 'scoring', ...clock, completedAt: new Date(), endReason: reason });
    await this.queue.enqueue(JOBS.interviewFinalScoring, { kind: 'final_scoring', sessionId: s.id }, { key: `${s.id}:${SCORING_VERSION}` }, tx);
    return next;
  }

  async retryReport(p: Principal, id: string): Promise<SessionView> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state === 'scoring' || s.state === 'report_ready') return this.view(tx, s);
      if (!(s.state === 'failed' && s.failureStage === 'scoring')) throw new DomainError('INTERVIEW_INVALID_STATE');
      const progress = progressOf(s);
      const attempt = (progress.retryReportCount ?? 0) + 1;
      const next = await transition(tx, s, ['failed'], { state: 'scoring', failureCode: null, failureStage: null, progress: { ...progress, retryReportCount: attempt } });
      // A new key per manual retry; the handler itself is idempotent on (session, scoring version).
      await this.queue.enqueue(JOBS.interviewFinalScoring, { kind: 'final_scoring', sessionId: s.id }, { key: `${s.id}:${SCORING_VERSION}:retry:${attempt}` }, tx);
      return this.view(tx, next);
    });
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
