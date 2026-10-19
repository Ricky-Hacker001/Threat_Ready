import { Inject, Injectable } from '@nestjs/common';
import type { OptionId, ReasoningResult } from '@threatready/contracts';
import { reasoningAttempts, reasoningEvaluations, reasoningItems, skillEvidence } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, eq } from 'drizzle-orm';
import { Database } from '../../platform/db/database.js';
import { emitMetric, logger } from '../../platform/logging/logger.js';
import { JOBS, QUEUE_PORT, type QueuePort } from '../../platform/ports/queue.port.js';
import { ContentService } from '../../platform/content/content.service.js';
import { LlmService, type CallMeta } from '../ai/llm.service.js';
import { getDomain } from './domains/index.js';
import type { ReasoningDomain, Weights } from './domain.types.js';
import type { GeneratedItem, ReasoningItemPrivate } from './item.types.js';
import { diagramText } from './prompts/diagram-text.js';
import {
  challengerRequest,
  challengerSchema,
  EVALUATION_PROMPT_VERSION,
  evaluatorRequest,
  evaluatorSchema,
  reconcilerRequest,
  reconcilerSchema,
  type ChallengerOutput,
  type EvaluationItem,
  type EvaluatorOutput,
  type ReconcilerOutput,
} from './prompts/evaluation.prompts.js';
import { scoreAttempt, type PointJudgement, type ScoreOutcome } from './scoring.js';

const TERMINAL_CODES = new Set(['LLM_BUDGET_EXCEEDED', 'AI_SERVICE_PAUSED']);

export interface StoredStages {
  evaluator: EvaluatorOutput;
  challenger: ChallengerOutput | null;
  reconciler: ReconcilerOutput | null;
}

/** What the evaluations.feedback column holds: the learner-facing result minus the dimension scores. */
export interface StoredFeedback {
  feedback: ReasoningResult['feedback'];
  options: ReasoningResult['options'];
  notices: string[];
  scoringNotes: string[];
}

/**
 * Worker: the three-stage evaluation (spec §5): evaluator, adversarial challenger, reconciler; then
 * deterministic scoring and skill evidence. Degrades honestly when a later stage fails: the result
 * carries `degraded`, a low confidence and a review flag, never a fabricated score. A failure of the
 * first stage leaves the attempt in `evaluating` for the queue to retry; the dead-letter handler
 * marks it `evaluation_failed` so the learner sees a state and a retry button.
 */
@Injectable()
export class EvaluationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  async runEvaluation(attemptId: string): Promise<void> {
    const [a] = await this.db.system(({ db }) => db.select().from(reasoningAttempts).where(eq(reasoningAttempts.id, attemptId)));
    if (!a || a.state !== 'evaluating' || !a.itemId || !a.selectedOption || !a.justification) return;
    const [existing] = await this.db.system(({ db }) => db.select({ id: reasoningEvaluations.id }).from(reasoningEvaluations).where(eq(reasoningEvaluations.attemptId, attemptId)));
    if (existing) {
      await this.db.system(({ db }) => db.update(reasoningAttempts).set({ state: 'evaluated', updatedAt: new Date() }).where(eq(reasoningAttempts.id, attemptId)));
      return;
    }
    const [row] = await this.db.system(({ db }) => db.select().from(reasoningItems).where(eq(reasoningItems.id, a.itemId!)));
    const domain = getDomain(a.domain);
    if (!row || !domain) return this.markFailed(attemptId, 'REASONING_EVALUATION_FAILED');
    const item: EvaluationItem = { public: { ...(row.public as GeneratedItem['public']), weights: row.weights as Weights }, private: row.private as ReasoningItemPrivate };
    const selected = a.selectedOption as OptionId;
    const justification = a.justification;
    const owner = { userId: a.userId, orgId: a.orgId };
    const metaFor = (stage: string): CallMeta => ({ feature: `reasoning.${stage}`, owner, sourceId: a.id, budget: 'finalize' });
    const started = Date.now();
    const notices: string[] = [];
    let degraded = false;

    let evaluator: EvaluatorOutput;
    let model: string;
    try {
      const r = await this.llm.structured(metaFor('evaluator'), evaluatorRequest(domain, item, selected, justification), evaluatorSchema(item));
      evaluator = r.value;
      model = r.usage.model;
    } catch (err) {
      if (err instanceof DomainError && TERMINAL_CODES.has(err.code)) return this.markFailed(attemptId, err.code);
      throw err; // retried by the queue; dead-lettered after the policy's attempts
    }

    let challenger: ChallengerOutput | null = null;
    try {
      challenger = (await this.llm.structured(metaFor('challenger'), challengerRequest(domain, item, selected, justification, evaluator), challengerSchema(item))).value;
    } catch (err) {
      degraded = true;
      notices.push('The adversarial review stage was unavailable, so simplified scoring was applied and this result is flagged for review.');
      logger.warn({ attempt_id: attemptId, err: errInfo(err) }, 'reasoning challenger unavailable; degrading');
      emitMetric('ReasoningEvaluationDegraded', 1, 'Count', { Stage: 'challenger' });
    }

    let reconciler: ReconcilerOutput | null = null;
    try {
      reconciler = (await this.llm.structured(metaFor('reconciler'), reconcilerRequest(domain, item, selected, justification, evaluator, challenger), reconcilerSchema(item))).value;
    } catch (err) {
      degraded = true;
      notices.push('The final reconciliation stage was unavailable; the score was computed from the earlier stages and this result is flagged for review.');
      logger.warn({ attempt_id: attemptId, err: errInfo(err) }, 'reasoning reconciler unavailable; degrading');
      emitMetric('ReasoningEvaluationDegraded', 1, 'Count', { Stage: 'reconciler' });
    }

    const final: PointJudgement[] = reconciler
      ? reconciler.final_points.map((p) => ({ pointId: p.point_id, status: p.status, rationale: p.rationale, quote: p.evidence_quote }))
      : applyChallenges(evaluator, challenger);
    const evaluatorPoints: PointJudgement[] = evaluator.points.map((p) => ({ pointId: p.point_id, status: p.status, rationale: p.rationale, quote: p.evidence_quote }));
    const assertedClaims = reconciler ? reconciler.asserted_claims : [...new Set([...evaluator.asserted_claims, ...(challenger?.asserted_claims ?? [])])];
    const technicalErrors = reconciler ? reconciler.confirmed_technical_errors : challenger ? challenger.technical_errors : evaluator.incorrect_claims;
    const integrity = reconciler ? reconciler.integrity : evaluator.integrity;
    const selectedVerdict = item.private.optionAnalysis.find((o) => o.id === selected)?.verdict ?? 'wrong';

    const outcome = scoreAttempt({
      weights: item.public.weights as Weights,
      rubric: item.private.rubric,
      mustNotCredit: item.private.mustNotCredit,
      correctOption: item.private.correctOption,
      selectedOption: selected,
      selectedVerdict,
      partialCreditForPlausible: domain.scoring.partialCreditForPlausible,
      justification,
      final,
      evaluator: evaluatorPoints,
      assertedClaims,
      technicalErrors,
      challenger: { hallucinatedReferences: challenger?.hallucinated_references.length ?? 0, fluentButWrong: challenger?.fluent_but_wrong ?? false, missingCritical: challenger?.missing_critical.length ?? 0 },
      integrity: { offTopic: integrity.off_topic, instructsGrader: integrity.instructs_grader, arguesForOption: integrity.argues_for_option },
      degraded,
    });
    const stored: StoredFeedback = {
      feedback: assembleFeedback(item, outcome, { evaluator, challenger, reconciler }, selected, technicalErrors),
      options: item.public.options.map((o) => {
        const an = item.private.optionAnalysis.find((x) => x.id === o.id)!;
        return { id: o.id, text: o.text, verdict: an.verdict, why: an.why };
      }),
      notices,
      scoringNotes: outcome.notes,
    };
    const latencyMs = Date.now() - started;

    await this.db.system(async (tx) => {
      const [ev] = await tx.db
        .insert(reasoningEvaluations)
        .values({
          orgId: a.orgId,
          userId: a.userId,
          attemptId,
          scoringVersion: outcome.version,
          totalScore: outcome.total,
          correct: outcome.correct,
          dimensions: outcome.dimensions,
          feedback: stored,
          stages: { evaluator, challenger, reconciler } satisfies StoredStages,
          confidence: outcome.confidence,
          reviewFlag: outcome.reviewFlag,
          degraded,
          promptVersion: EVALUATION_PROMPT_VERSION,
          rubricVersion: row.generatorVersion,
          model,
          tier: 'LARGE',
          latencyMs,
        })
        .onConflictDoNothing()
        .returning({ id: reasoningEvaluations.id });
      if (!ev) return; // a concurrent run stored it first and owns the remaining writes
      const skills = domain.skillIds.filter((id) => this.content.skill(id));
      if (skills.length) {
        await tx.db
          .insert(skillEvidence)
          .values(
            skills.map((skillId) => ({
              orgId: a.orgId,
              userId: a.userId,
              skillId,
              source: 'reasoning' as const,
              sourceId: attemptId,
              score: outcome.total,
              weight: '1.00',
              scoringVersion: outcome.version,
              promptVersion: EVALUATION_PROMPT_VERSION,
              rubricVersion: row.generatorVersion,
              model,
              tier: 'LARGE',
            })),
          )
          .onConflictDoNothing();
      }
      await tx.db.update(reasoningAttempts).set({ state: 'evaluated', failureCode: null, failureStage: null, updatedAt: new Date() }).where(eq(reasoningAttempts.id, attemptId));
      await this.queue.enqueue(JOBS.skillsRecalculate, { kind: 'skills', userId: a.userId }, { key: `${a.userId}:${ev.id}` }, tx);
    });
    emitMetric('ReasoningEvaluationMs', latencyMs, 'Milliseconds', { Domain: domain.key });
    emitMetric('ReasoningReviewFlag', outcome.reviewFlag ? 1 : 0, 'Count', { Domain: domain.key });
    logger.info({ attempt_id: attemptId, total: outcome.total, correct: outcome.correct, confidence: outcome.confidence, degraded, ms: latencyMs }, 'reasoning attempt evaluated');
  }

  async markFailed(attemptId: string, code: string): Promise<void> {
    await this.db.system(({ db }) =>
      db
        .update(reasoningAttempts)
        .set({ state: 'evaluation_failed', failureCode: code, failureStage: 'evaluation', updatedAt: new Date() })
        .where(and(eq(reasoningAttempts.id, attemptId), eq(reasoningAttempts.state, 'evaluating'))),
    );
  }
}

/** Without a reconciler, the challenger's suggested statuses override the evaluator's (lean toward the challenger). */
export function applyChallenges(evaluator: EvaluatorOutput, challenger: ChallengerOutput | null): PointJudgement[] {
  return evaluator.points.map((p) => {
    const c = challenger?.challenges.find((x) => x.point_id === p.point_id);
    return c
      ? { pointId: p.point_id, status: c.suggested_status, rationale: c.reason, quote: c.suggested_status === 'missed' ? null : p.evidence_quote }
      : { pointId: p.point_id, status: p.status, rationale: p.rationale, quote: p.evidence_quote };
  });
}

/**
 * Feedback is assembled in code from the authored rubric (ADD L17b) and enriched by the reconciler
 * when it ran: the learner always gets the authored hint for every missed point, the rationale for
 * every credited one, the option analysis and the reference explanation.
 */
export function assembleFeedback(item: EvaluationItem, outcome: ScoreOutcome, stages: StoredStages, selected: OptionId, technicalErrors: { quote: string; why: string }[]): ReasoningResult['feedback'] {
  const r = stages.reconciler?.feedback;
  const correct = item.private.correctOption;
  const analysis = (id: OptionId) => item.private.optionAnalysis.find((o) => o.id === id)!;
  const missedPoints = item.private.rubric.filter((p) => outcome.adjusted.get(p.id)?.status === 'missed');
  const creditedPoints = item.private.rubric.filter((p) => outcome.adjusted.get(p.id)?.status !== 'missed');
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const hints = missedPoints.map((p) => p.hint);
  const gotRight = uniq([...(r?.got_right ?? []), ...(r ? [] : creditedPoints.map((p) => `${p.text}: ${outcome.adjusted.get(p.id)!.rationale}`)), ...(r ? [] : stages.evaluator.strengths)]).slice(0, 8);
  const missed = uniq([...(r?.missed ?? []), ...hints]).slice(0, 10);
  const whyAlternatives = (r?.why_alternatives?.length ? r.why_alternatives : item.private.optionAnalysis.filter((o) => o.id !== correct).map((o) => ({ option: o.id, why: o.why }))).filter((x) => x.option !== correct);
  const architectureAnalysis = r?.architecture_analysis || `Attack path and components:\n${diagramText(item.public.diagram)}`;
  const decision =
    r?.decision ||
    `You selected option ${selected}. ${selected === correct ? 'That is the best decision for this scenario.' : `The best decision here is option ${correct}.`} ${analysis(selected).why}`;
  const reasoning = r?.reasoning || (stages.evaluator.gaps.length ? `Strengths: ${stages.evaluator.strengths.join('; ') || 'none recorded'}. Gaps: ${stages.evaluator.gaps.join('; ')}.` : `Strengths: ${stages.evaluator.strengths.join('; ') || 'none recorded'}.`);
  return {
    decision,
    reasoning,
    gotRight,
    missed,
    whyBest: r?.why_best || analysis(correct).why,
    whyAlternatives: whyAlternatives.slice(0, 3),
    architectureAnalysis,
    expertExplanation: r?.expert_explanation || item.private.referenceAnswer,
    improve: uniq([...(r?.improve ?? []), ...hints.slice(0, 3)]).slice(0, 6),
    incorrectClaims: technicalErrors.map((e) => ({ claim: e.quote, why: e.why })).slice(0, 6),
  };
}

const errInfo = (e: unknown) => ({ name: (e as Error)?.name, message: (e as Error)?.message?.slice(0, 200) });

export type { ReasoningDomain };
