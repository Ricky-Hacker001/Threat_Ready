import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { InterviewReport, SignedDownload } from '@threatready/contracts';
import { evaluations, interviewSessions, reports, skillEvidence, users } from '@threatready/db';
import { DomainError, opaqueObjectKey } from '@threatready/shared';
import { and, eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { Principal } from '../../platform/authz/principal.js';
import { CRITERIA, ContentService, type CriterionId } from '../../platform/content/content.service.js';
import { Database } from '../../platform/db/database.js';
import { logger } from '../../platform/logging/logger.js';
import { EMAIL_PORT, type EmailPort } from '../../platform/ports/email.port.js';
import { JOBS, QUEUE_PORT, type QueuePort } from '../../platform/ports/queue.port.js';
import { REPORTS_PREFIX, STORAGE_PORT, type StoragePort } from '../../platform/ports/storage.port.js';
import { LlmService } from '../ai/llm.service.js';
import { quoteIsIn } from '../ai/prompts/common.js';
import {
  ASSESSMENT_BATCH_SIZE,
  FINAL_SCORING_PROMPT_VERSION,
  reportSummaryRequest,
  reportSummarySchema,
  turnAssessmentRequest,
  turnAssessmentSchema,
  type FinalScoring,
  type ScoringTurnInput,
  type TurnAssessment,
} from '../ai/prompts/interview.prompts.js';
import { analysisOf } from '../interview/analysis.service.js';
import { rubricKindFor } from '../interview/plan.types.js';
import { configOf, loadOwnedSession, loadTurns, planOf, progressOf } from '../interview/session.repo.js';
import { stripOpening } from '../interview/turn.service.js';
import { computeScores, SCORING_VERSION, type ScoredTurnInput } from '../scoring/scoring.js';
import { buildReport } from './report.builder.js';
import { renderReportPdf } from './report.pdf.js';

@Injectable()
export class ReportsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Worker: final scoring, skill evidence and report (ADD LLD-6). Idempotent on
   * (session, scoring version): a retry after a partial failure never duplicates rows.
   */
  async runFinalScoring(sessionId: string): Promise<void> {
    const [s] = await this.db.system(({ db }) => db.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)));
    if (!s || !['scoring', 'completed'].includes(s.state)) return;
    const [existing] = await this.db.system(({ db }) =>
      db.select({ id: evaluations.id }).from(evaluations).where(and(eq(evaluations.sessionId, sessionId), eq(evaluations.scoringVersion, SCORING_VERSION))),
    );
    if (existing) {
      // A previous attempt stored the evaluation; finish the remaining steps only.
      await this.db.system(async (tx) => {
        await tx.db.update(interviewSessions).set({ state: 'report_ready', updatedAt: new Date() }).where(eq(interviewSessions.id, sessionId));
        await this.enqueueFollowOn(tx, s.userId, existing.id);
      });
      return;
    }

    const plan = planOf(s)!;
    const config = configOf(s)!;
    const analysis = analysisOf(s)!;
    const turns = await this.db.system((tx) => loadTurns(tx, sessionId));
    const answered = turns.filter((t) => t.answer);
    const c = this.content.interview;
    const itemOf = (planItemId: string) => plan.items.find((i) => i.id === planItemId)!;
    const criteriaFor = (kind: string): CriterionId[] => {
      const r = this.content.rubricFor(kind);
      return CRITERIA.filter((k) => r.weights[k] > 0);
    };

    let scoring: FinalScoring | null = null;
    if (answered.length) {
      const meta = { feature: 'interview.final_scoring', owner: { userId: s.userId, orgId: s.orgId }, sourceId: s.id, budget: 'finalize' as const };
      const inputsFor: ScoringTurnInput[] = answered.map((t) => {
        const item = { ...itemOf(t.planItemId), kind: rubricKindFor(itemOf(t.planItemId), t.kind) };
        const parent = t.kind === 'follow_up' ? turns.find((p) => p.planItemId === t.planItemId && p.kind === 'question') : undefined;
        return { turnId: t.id, item, criteria: criteriaFor(item.kind), question: stripOpening(t.question), answer: t.answer!, parentQuestion: parent ? stripOpening(parent.question) : undefined };
      });
      // Step 1: assess the answers in small batches, in parallel, so no single response is long.
      const batches: ScoringTurnInput[][] = [];
      for (let i = 0; i < inputsFor.length; i += ASSESSMENT_BATCH_SIZE) batches.push(inputsFor.slice(i, i + ASSESSMENT_BATCH_SIZE));
      const assessed: TurnAssessment[] = (
        await Promise.all(
          batches.map(async (batch) => {
            const { value } = await this.llm.structured(
              meta,
              turnAssessmentRequest({ c, job: analysis.job, difficulty: config.difficulty, turns: batch }),
              turnAssessmentSchema(batch.map((t) => t.turnId)),
            );
            return value.turns;
          }),
        )
      ).flat();
      // Step 2: the summary and improvement plan, written from those assessments.
      const byId = new Map(assessed.map((a) => [a.turn_id, a]));
      const { value: summary } = await this.llm.structured(
        meta,
        reportSummaryRequest({
          c,
          job: analysis.job,
          difficulty: config.difficulty,
          skillIds: [...new Set([...analysis.job.required_skills.map((r) => r.skill_id), ...plan.items.map((i) => i.skillId)])].filter((id) => c.skills.has(id)),
          turns: inputsFor.map((t) => {
            const a = byId.get(t.turnId);
            return {
              skill: c.skills.get(t.item.skillId)?.label ?? t.item.skillId,
              kind: t.item.kind.replace(/_/g, ' '),
              question: stripOpening(t.question),
              answerExcerpt: t.answer.slice(0, 600),
              levels: a?.criteria.map((cr) => `${cr.criterion_id} ${cr.level}`).join(', ') ?? 'not assessed',
              missing: a?.missing_concepts.slice(0, 4) ?? [],
              inaccuracies: a?.inaccuracies.slice(0, 3) ?? [],
            };
          }),
        }),
        reportSummarySchema([...c.skills.keys()]),
      );
      scoring = { ...summary, turns: assessed };
    }

    // Quote check (ADD §7 step 3): a criterion without a verbatim quote from that answer drops to 0.
    const byTurn = new Map(scoring?.turns.map((t) => [t.turn_id, t]) ?? []);
    const inputs: ScoredTurnInput[] = turns.map((t) => {
      const item = itemOf(t.planItemId);
      const m = byTurn.get(t.id);
      const levels: Partial<Record<CriterionId, number>> = {};
      for (const cr of m?.criteria ?? []) {
        const lvl = Number(cr.level);
        levels[cr.criterion_id] = lvl > 0 && !quoteIsIn(cr.evidence_quote, t.answer ?? '') ? 0 : lvl;
      }
      const kind = rubricKindFor(item, t.kind);
      return { turnId: t.id, kind: t.kind, itemKind: kind, skillId: item.skillId, rubric: this.content.rubricFor(kind), answered: Boolean(t.answer), levels };
    });
    const scores = computeScores(
      inputs,
      analysis.job.required_skills.map((r) => ({ skillId: r.skill_id, weight: r.weight })),
    );
    const reportId = randomUUID();
    const content = buildReport({
      reportId,
      sessionId,
      content: this.content,
      config,
      job: analysis.job,
      plan,
      turns,
      scoring,
      scores,
      integrityFlags: progressOf(s).integrityFlags,
      pdfEnabled: this.cfg.REPORT_PDF_ENABLED,
    });
    const model = this.llm.modelFor('LARGE');

    await this.db.system(async (tx) => {
      const [ev] = await tx.db
        .insert(evaluations)
        .values({
          orgId: s.orgId,
          userId: s.userId,
          sessionId,
          scoringVersion: SCORING_VERSION,
          criteria: Object.fromEntries(inputs.map((i) => [i.turnId, i.levels])),
          scores,
          overallScore: scores.overall,
          promptVersion: FINAL_SCORING_PROMPT_VERSION,
          rubricVersion: plan.rubricVersion,
          model,
          tier: 'LARGE',
        })
        .onConflictDoNothing()
        .returning({ id: evaluations.id });
      if (!ev) return; // a concurrent attempt won; it owns the remaining writes
      if (scores.skills.length) {
        await tx.db
          .insert(skillEvidence)
          .values(
            scores.skills
              .filter((sk) => this.content.skill(sk.skillId))
              .map((sk) => ({
                orgId: s.orgId,
                userId: s.userId,
                skillId: sk.skillId,
                source: 'interview' as const,
                sourceId: sessionId,
                score: sk.score,
                weight: Math.min(sk.weight, 9.99).toFixed(2),
                scoringVersion: SCORING_VERSION,
                promptVersion: FINAL_SCORING_PROMPT_VERSION,
                rubricVersion: plan.rubricVersion,
                model,
                tier: 'LARGE',
              })),
          )
          .onConflictDoNothing();
      }
      await tx.db
        .insert(reports)
        .values({
          id: reportId,
          orgId: s.orgId,
          userId: s.userId,
          evaluationId: ev.id,
          sessionId,
          content,
          pdfStatus: this.cfg.REPORT_PDF_ENABLED ? 'pending' : 'disabled',
        })
        .onConflictDoNothing();
      await tx.db.update(interviewSessions).set({ state: 'report_ready', updatedAt: new Date() }).where(eq(interviewSessions.id, sessionId));
      await this.enqueueFollowOn(tx, s.userId, ev.id);
    });
    logger.info({ session_id: sessionId, overall: scores.overall, turns: turns.length }, 'interview scored');
  }

  private async enqueueFollowOn(tx: Parameters<Parameters<Database['system']>[0]>[0], userId: string, evaluationId: string): Promise<void> {
    await this.queue.enqueue(JOBS.skillsRecalculate, { kind: 'skills', userId }, { key: `${userId}:${evaluationId}` }, tx);
    if (this.cfg.REPORT_PDF_ENABLED) await this.queue.enqueue(JOBS.reportPdf, { kind: 'report_pdf', evaluationId }, { key: evaluationId }, tx);
    if (this.cfg.REPORT_EMAIL_ENABLED) {
      await this.queue.enqueue(JOBS.emailSend, { kind: 'email', template: 'interview-report-ready', evaluationId }, { key: `report-ready:${evaluationId}` }, tx);
    }
  }

  /** Worker: optional PDF into private S3 (idempotent on the evaluation id). */
  async runPdf(evaluationId: string): Promise<void> {
    const [r] = await this.db.system(({ db }) => db.select().from(reports).where(eq(reports.evaluationId, evaluationId)));
    if (!r || r.pdfStatus === 'ready') return;
    const key = r.objectKey ?? `${opaqueObjectKey(REPORTS_PREFIX, r.orgId)}.pdf`;
    const pdf = await renderReportPdf(r.content as InterviewReport);
    await this.storage.put(key, pdf, 'application/pdf');
    await this.db.system(({ db }) => db.update(reports).set({ objectKey: key, pdfStatus: 'ready' }).where(eq(reports.id, r.id)));
  }

  /** Worker: report-ready email via EmailPort, sent at most once per report. */
  async runEmail(evaluationId: string): Promise<void> {
    const [r] = await this.db.system(({ db }) => db.select().from(reports).where(eq(reports.evaluationId, evaluationId)));
    if (!r || r.emailedAt) return;
    const [u] = await this.db.system(({ db }) => db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, r.userId)));
    if (!u) return;
    const report = r.content as InterviewReport;
    await this.email.send(
      'interview-report-ready',
      u.email,
      { name: u.name.split(' ')[0], roleTitle: report.roleTitle, url: `${this.cfg.APP_ORIGIN}/interview-prep/sessions/${r.sessionId}/report` },
      `report-ready:${evaluationId}`,
    );
    await this.db.system(({ db }) => db.update(reports).set({ emailedAt: new Date() }).where(eq(reports.id, r.id)));
  }

  async markScoringFailed(sessionId: string, code: string): Promise<void> {
    await this.db.system(({ db }) =>
      db
        .update(interviewSessions)
        .set({ state: 'failed', failureCode: code, failureStage: 'scoring', updatedAt: new Date() })
        .where(and(eq(interviewSessions.id, sessionId), eq(interviewSessions.state, 'scoring'))),
    );
  }

  async getReport(p: Principal, sessionId: string): Promise<InterviewReport> {
    return this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, sessionId);
      const [r] = await tx.db.select().from(reports).where(and(eq(reports.sessionId, s.id), eq(reports.userId, p.userId)));
      if (!r) throw new DomainError('REPORT_NOT_READY');
      const content = r.content as InterviewReport;
      return { ...content, pdf: { available: r.pdfStatus === 'ready' } };
    });
  }

  async getPdfUrl(p: Principal, sessionId: string): Promise<SignedDownload> {
    const key = await this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, sessionId);
      const [r] = await tx.db.select().from(reports).where(and(eq(reports.sessionId, s.id), eq(reports.userId, p.userId)));
      if (!r || r.pdfStatus !== 'ready' || !r.objectKey) throw new DomainError('REPORT_NOT_READY');
      return r.objectKey;
    });
    const ttl = 120;
    return { url: await this.storage.getUrl(key, ttl, 'threatready-interview-report.pdf'), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }
}
