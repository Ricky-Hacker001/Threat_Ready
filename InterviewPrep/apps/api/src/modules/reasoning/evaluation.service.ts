import { Inject, Injectable } from '@nestjs/common';
import type { OptionId, ReasoningResult } from '@threatready/contracts';
import { reasoningAttempts, reasoningEvaluations, reasoningItems, skillEvidence } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Database } from '../../platform/db/database.js';
import { emitMetric, logger } from '../../platform/logging/logger.js';
import { JOBS, QUEUE_PORT, type QueuePort } from '../../platform/ports/queue.port.js';
import { ContentService } from '../../platform/content/content.service.js';
import { LlmService, refusalOf, type CallMeta } from '../ai/llm.service.js';
import { getDomain } from './domains/index.js';
import type { ReasoningDomain, Weights } from './domain.types.js';
import { drawnForAudit, escalationReasons, type EscalationReason } from './evaluation-policy.js';
import type { GeneratedItem, ReasoningItemPrivate } from './item.types.js';
import { attackPathSummary } from './prompts/diagram-text.js';
import {
  challengerRequest,
  challengerSchema,
  EVALUATION_PROMPT_VERSION,
  evaluatorRequest,
  evaluatorSchema,
  evaluatorTier,
  reconcilerRequest,
  reconcilerSchema,
  type ChallengerOutput,
  type EvaluationItem,
  type EvaluationMode,
  type EvaluatorOutput,
  type ReconcilerOutput,
} from './prompts/evaluation.prompts.js';
import { scoreAttempt, type PointJudgement, type ScoreOutcome, type ScoringInput } from './scoring.js';
import { smallTierParams } from './small-tier.js';
import type { LlmObject, LlmTier } from '../../platform/ports/llm.port.js';

const TERMINAL_CODES = new Set(['LLM_BUDGET_EXCEEDED', 'AI_SERVICE_PAUSED']);

export interface StoredStages {
  evaluator: EvaluatorOutput;
  challenger: ChallengerOutput | null;
  reconciler: ReconcilerOutput | null;
  /** Whether the later stages ran and why (absent on evaluations stored before the tiered evaluation). */
  escalation?: { mode: EvaluationMode; escalated: boolean; reasons: EscalationReason[] };
}

/** What the evaluations.feedback column holds: the learner-facing result minus the dimension scores. */
export interface StoredFeedback {
  feedback: ReasoningResult['feedback'];
  options: ReasoningResult['options'];
  notices: string[];
  scoringNotes: string[];
}

/**
 * Worker: the evaluation (spec §5; tiered by the cost design of 26 Oct 2026). The selected option is
 * scored in code; stage 1 (the evaluator, SMALL in tiered mode) judges the justification; the
 * adversarial challenger and the reconciler (LARGE) run only when an escalation rule fires
 * (evaluation-policy.ts), or on every answer in full mode (REASONING_EVALUATION_MODE=full, the old
 * pipeline). Every number comes from deterministic scoring; then skill evidence. Degrades honestly
 * when a later stage fails: the result carries `degraded`, a low confidence and a review flag, never a
 * fabricated score. A failure of the first stage leaves the attempt in `evaluating` for the queue to
 * retry; the dead-letter handler marks it `evaluation_failed` so the learner sees a state and a retry
 * button. That manual retry runs under the normal escalation rules (no stage-1 grade existed to
 * dispute, review COST-6); `escalate` remains for an operator's forced second review. When the SMALL
 * model declines stage 1 (stop_reason refusal, billed and recorded), stage 1 runs again on LARGE and the
 * answer escalates (`small_refused`): the learner's evaluation neither fails nor degrades.
 */
@Injectable()
export class EvaluationService {
  /** Injectable for tests; Math.random in production (the random audit, REASONING_ESCALATION_AUDIT_RATE). */
  rng: () => number = Math.random;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async runEvaluation(attemptId: string, opts: { escalate?: boolean } = {}): Promise<void> {
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
    const item = evaluationItemOf(row);
    const selected = a.selectedOption as OptionId;
    const justification = a.justification;
    const owner = { userId: a.userId, orgId: a.orgId };
    // Stage 1 is checked against the learner's daily cap and the global breaker ('reasoning'); once an
    // evaluation has started, stages 2 and 3 run as 'finalize' so a paid-for evaluation completes
    // (still subject to the breaker's grace band). Together with REASONING_USER_DAILY_EVALUATIONS this
    // bounds what one learner can spend (audit 2026-10-15 §3.5).
    const metaFor = (stage: string, budget: CallMeta['budget']): CallMeta => ({ feature: `reasoning.${stage}`, owner, sourceId: a.id, budget });
    const mode: EvaluationMode = this.cfg.REASONING_EVALUATION_MODE;
    // Prompt caching only when REASONING_PROMPT_CACHE: each stage's own output format invalidates the
    // cache, so the item prefix was written per stage and never read across stages (review COST-2).
    const cache = this.cfg.REASONING_PROMPT_CACHE;
    const started = Date.now();
    const notices: string[] = [];
    let degraded = false;

    // Stage 1: always. Its tier is the mode's (SMALL tiered, LARGE full).
    let evaluator: EvaluatorOutput;
    let last: { model: string; tier: LlmTier };
    let stage1Tier = evaluatorTier(mode);
    let smallRefused = false;
    const stage1 = (tier: LlmTier, budget: CallMeta['budget']): Promise<LlmObject<EvaluatorOutput>> =>
      this.llm.structured(metaFor('evaluator', budget), { ...evaluatorRequest(domain, item, selected, justification, tier, smallTierParams(this.cfg, 'evaluation')), cache }, evaluatorSchema(item));
    try {
      let r: LlmObject<EvaluatorOutput>;
      try {
        r = await stage1(stage1Tier, 'reasoning');
      } catch (err) {
        const refusal = stage1Tier === 'SMALL' ? refusalOf(err) : null;
        if (!refusal) throw err;
        // The SMALL model declined (Haiku 5.5's safety classifiers can stop an attack scenario; billed and
        // recorded by LlmService). Not the learner's doing: stage 1 runs on LARGE, as 'finalize' since the
        // evaluation has started, and the challenger and reconciler review it (escalation `small_refused`).
        smallRefused = true;
        stage1Tier = 'LARGE';
        emitMetric('ReasoningRefusal', 1, 'Count', { Stage: 'evaluator', Model: this.llm.modelFor('SMALL', 'reasoning'), Category: refusal.category ?? 'unknown' });
        logger.warn({ attempt_id: attemptId, model: this.llm.modelFor('SMALL', 'reasoning'), category: refusal.category }, 'reasoning evaluator declined on SMALL; stage 1 runs on LARGE');
        r = await stage1('LARGE', 'finalize');
      }
      evaluator = r.value;
      last = { model: r.usage.model, tier: stage1Tier };
    } catch (err) {
      if (err instanceof DomainError && TERMINAL_CODES.has(err.code)) return this.markFailed(attemptId, err.code);
      throw err; // retried by the queue; dead-lettered after the policy's attempts
    }

    // Everything code can decide without a model: the option's correctness and its partial credit,
    // the quote check, must-not-credit, integrity and caps (scoring.ts). The provisional score is the
    // single-pass result unless an escalation rule fires.
    const selectedVerdict = item.private.optionAnalysis.find((o) => o.id === selected)?.verdict ?? 'wrong';
    const fixed: Pick<ScoringInput, 'weights' | 'rubric' | 'mustNotCredit' | 'correctOption' | 'selectedOption' | 'selectedVerdict' | 'partialCreditForPlausible' | 'justification'> = {
      weights: item.public.weights as Weights,
      rubric: item.private.rubric,
      mustNotCredit: item.private.mustNotCredit,
      correctOption: item.private.correctOption,
      selectedOption: selected,
      selectedVerdict,
      partialCreditForPlausible: domain.scoring.partialCreditForPlausible,
      justification,
    };
    const evaluatorPoints = judgementsOf(evaluator.points);
    const provisional = scoreAttempt({
      ...fixed,
      final: evaluatorPoints,
      evaluator: evaluatorPoints,
      assertedClaims: evaluator.asserted_claims,
      technicalErrors: evaluator.incorrect_claims,
      challenger: NO_CHALLENGER,
      integrity: { offTopic: evaluator.integrity.off_topic, instructsGrader: evaluator.integrity.instructs_grader, arguesForOption: evaluator.integrity.argues_for_option },
      degraded: false,
      singlePassConfidence: evaluator.confidence,
    });
    // The same answer with stage 1's deductions left out: whether a second review could lift it into
    // the borderline band (review COST-3).
    const unpenalised = scoreAttempt({
      ...fixed,
      final: evaluatorPoints,
      evaluator: evaluatorPoints,
      assertedClaims: [],
      technicalErrors: [],
      challenger: NO_CHALLENGER,
      integrity: { offTopic: false, instructsGrader: false, arguesForOption: null },
      degraded: false,
    });
    const reasons = escalationReasons({
      mode,
      forced: opts.escalate === true,
      smallRefused,
      selected,
      selectedIsBest: selected === item.private.correctOption,
      provisional,
      unpenalisedTotal: unpenalised.total,
      evaluator,
      justification,
      center: this.cfg.REASONING_ESCALATION_CENTER,
      band: this.cfg.REASONING_ESCALATION_BAND,
      audit: drawnForAudit(this.cfg.REASONING_ESCALATION_AUDIT_RATE, this.rng),
    });
    const escalated = reasons.length > 0;
    for (const reason of reasons) emitMetric('ReasoningEvaluationEscalated', 1, 'Count', { Reason: reason });
    if (!escalated) emitMetric('ReasoningEvaluationSinglePass', 1, 'Count', { Domain: domain.key });

    let challenger: ChallengerOutput | null = null;
    let reconciler: ReconcilerOutput | null = null;
    let outcome: ScoreOutcome = provisional;
    let technicalErrors = evaluator.incorrect_claims;
    if (escalated) {
      // Stages 2 and 3 run as 'finalize' once an evaluation has started, so a paid-for evaluation
      // completes (still subject to the breaker's grace band and AI_FINALIZE_SOURCE_CAP_USD). Both carry
      // the item as the same system prefix (graderPrefix).
      try {
        const r = await this.llm.structured(metaFor('challenger', 'finalize'), { ...challengerRequest(domain, item, selected, justification, evaluator), cache }, challengerSchema(item));
        challenger = r.value;
        last = { model: r.usage.model, tier: 'LARGE' };
      } catch (err) {
        degraded = true;
        notices.push('The adversarial review stage was unavailable, so simplified scoring was applied and this result is flagged for review.');
        logger.warn({ attempt_id: attemptId, err: errInfo(err) }, 'reasoning challenger unavailable; degrading');
        emitMetric('ReasoningEvaluationDegraded', 1, 'Count', { Stage: 'challenger' });
      }

      try {
        const r = await this.llm.structured(metaFor('reconciler', 'finalize'), { ...reconcilerRequest(domain, item, selected, justification, evaluator, challenger), cache }, reconcilerSchema(item));
        reconciler = r.value;
        last = { model: r.usage.model, tier: 'LARGE' };
      } catch (err) {
        degraded = true;
        notices.push('The final reconciliation stage was unavailable; the score was computed from the earlier stages and this result is flagged for review.');
        logger.warn({ attempt_id: attemptId, err: errInfo(err) }, 'reasoning reconciler unavailable; degrading');
        emitMetric('ReasoningEvaluationDegraded', 1, 'Count', { Stage: 'reconciler' });
      }

      const final: PointJudgement[] = reconciler ? judgementsOf(reconciler.final_points) : applyChallenges(evaluator, challenger);
      const assertedClaims = reconciler ? reconciler.asserted_claims : [...new Set([...evaluator.asserted_claims, ...(challenger?.asserted_claims ?? [])])];
      technicalErrors = reconciler ? reconciler.confirmed_technical_errors : challenger ? challenger.technical_errors : evaluator.incorrect_claims;
      // An integrity flag raised by any stage stands: a later stage can be talked out of it by the very
      // text it is judging, so it may add flags but never clear one (audit TR-21). The option the
      // justification argues for is the reconciler's reading when it ran.
      const integrity = {
        off_topic: evaluator.integrity.off_topic || Boolean(reconciler?.integrity.off_topic),
        instructs_grader: evaluator.integrity.instructs_grader || Boolean(reconciler?.integrity.instructs_grader),
        argues_for_option: reconciler ? reconciler.integrity.argues_for_option : evaluator.integrity.argues_for_option,
      };
      outcome = scoreAttempt({
        ...fixed,
        final,
        // The disagreement baseline. A LARGE stage 1 (full mode, or after the SMALL model declined) keeps
        // the old rule (stage 1 as written). An escalated SMALL reading was sent on because it was
        // doubtful, so disagreement with it is expected and not by itself a sign the final grade is
        // uncertain: the baseline is stage 1 with the challenger's objections applied.
        evaluator: stage1Tier === 'LARGE' ? evaluatorPoints : applyChallenges(evaluator, challenger),
        assertedClaims,
        technicalErrors,
        challenger: { hallucinatedReferences: challenger?.hallucinated_references.length ?? 0, fluentButWrong: challenger?.fluent_but_wrong ?? false, missingCritical: challenger?.missing_critical.length ?? 0 },
        integrity: { offTopic: integrity.off_topic, instructsGrader: integrity.instructs_grader, arguesForOption: integrity.argues_for_option },
        degraded,
      });
      // No learner-facing note says that, or why, the answer had the second review (review AR-SEC-1).
    }
    const stages: StoredStages = { evaluator, challenger, reconciler, escalation: { mode, escalated, reasons } };
    const stored: StoredFeedback = {
      feedback: assembleFeedback(item, outcome, stages, selected, technicalErrors),
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
          stages,
          confidence: outcome.confidence,
          reviewFlag: outcome.reviewFlag,
          degraded,
          promptVersion: EVALUATION_PROMPT_VERSION,
          rubricVersion: row.generatorVersion,
          model: last.model,
          tier: last.tier,
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
              model: last.model,
              tier: last.tier,
            })),
          )
          .onConflictDoNothing();
      }
      await tx.db.update(reasoningAttempts).set({ state: 'evaluated', failureCode: null, failureStage: null, updatedAt: new Date() }).where(eq(reasoningAttempts.id, attemptId));
      await this.queue.enqueue(JOBS.skillsRecalculate, { kind: 'skills', userId: a.userId }, { key: `${a.userId}:${ev.id}` }, tx);
    });
    emitMetric('ReasoningEvaluationMs', latencyMs, 'Milliseconds', { Domain: domain.key });
    emitMetric('ReasoningReviewFlag', outcome.reviewFlag ? 1 : 0, 'Count', { Domain: domain.key });
    logger.info({ attempt_id: attemptId, total: outcome.total, correct: outcome.correct, confidence: outcome.confidence, degraded, mode, escalated, reasons, ms: latencyMs }, 'reasoning attempt evaluated');
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

/** An item row as the graders see it: the public half with its weights, and the private half. */
export function evaluationItemOf(row: typeof reasoningItems.$inferSelect): EvaluationItem {
  return { public: { ...(row.public as GeneratedItem['public']), weights: row.weights as Weights }, private: row.private as ReasoningItemPrivate };
}

const NO_CHALLENGER: ScoringInput['challenger'] = { hallucinatedReferences: 0, fluentButWrong: false, missingCritical: 0 };

const judgementsOf = (points: EvaluatorOutput['points']): PointJudgement[] => points.map((p) => ({ pointId: p.point_id, status: p.status, rationale: p.rationale, quote: p.evidence_quote }));

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
 * every credited one, the option analysis and the reference explanation. Without a reconciler (a
 * single-pass result, or a failed stage 3) the evaluator's summary and tips and the item's authored
 * architecture analysis fill the gaps (cost design §6.6); items written before the library carry no
 * authored analysis and fall back to a short account of the attack path (attackPathSummary).
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
  // Older questions carry no authored analysis: a readable account of the attack path, never the
  // machine listing the graders read (review AR-BIZ-10).
  const architectureAnalysis = r?.architecture_analysis || item.private.architectureAnalysis || attackPathSummary(item.public.diagram);
  const decision =
    r?.decision ||
    `You selected option ${selected}. ${selected === correct ? 'That is the best decision for this scenario.' : `The best decision here is option ${correct}.`} ${analysis(selected).why}`;
  const reasoning = r?.reasoning || stages.evaluator.reasoning_summary || (stages.evaluator.gaps.length ? `Strengths: ${stages.evaluator.strengths.join('; ') || 'none recorded'}. Gaps: ${stages.evaluator.gaps.join('; ')}.` : `Strengths: ${stages.evaluator.strengths.join('; ') || 'none recorded'}.`);
  return {
    decision,
    reasoning,
    gotRight,
    missed,
    whyBest: r?.why_best || analysis(correct).why,
    whyAlternatives: whyAlternatives.slice(0, 3),
    architectureAnalysis,
    expertExplanation: r?.expert_explanation || item.private.referenceAnswer,
    improve: uniq([...(r?.improve ?? stages.evaluator.improve ?? []), ...hints.slice(0, 3)]).slice(0, 6),
    incorrectClaims: technicalErrors.map((e) => ({ claim: e.quote, why: e.why })).slice(0, 6),
  };
}

const errInfo = (e: unknown) => ({ name: (e as Error)?.name, message: (e as Error)?.message?.slice(0, 200) });

export type { ReasoningDomain };
