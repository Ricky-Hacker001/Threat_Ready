import type { DimensionResult, OptionId, OptionVerdict, PointStatus, ReasoningDimensionKey } from '@threatready/contracts';
import { normaliseForQuote, quoteIsIn } from '../ai/prompts/common.js';
import type { Weights } from './domain.types.js';
import type { MustNotCredit, RubricPoint } from './item.types.js';

/**
 * Deterministic scoring for Attack Reasoning (spec §5; ADD L17b "the model never owns the number").
 * The graders return rubric-point statuses with evidence quotes and integrity flags; everything
 * numeric is computed here from configured weights. Changing any rule needs a new version so stored
 * evaluations stay comparable.
 */
/**
 * v2 (cost design 26 Oct 2026): a single-pass result takes the lower of the computed confidence and
 * the evaluator's own (ScoringInput.singlePassConfidence). Every formula is unchanged, so totals stay
 * comparable with v1.
 * v3 (review AR-BIZ-3, 27 Oct 2026): an evidence quote stitched from verbatim pieces of the
 * justification, in order, each at least QUOTE_PIECE_MIN_WORDS words, counts as verbatim (quoteSupported).
 */
export const REASONING_SCORING_VERSION = 'reasoning-score.v3.2026-10-27';

/** The shortest piece of a stitched evidence quote, in words (the contiguous rule's 8 characters is for whole quotes). */
export const QUOTE_PIECE_MIN_WORDS = 8;
/** At most this many pieces: evidence, not a collage. */
const QUOTE_MAX_PIECES = 4;

const trimQuote = (q: string) => q.replace(/^["'.…\s]+|["'.…\s]+$/g, '');
const words = (q: string) => q.split(/\s+/).filter((w) => /[a-z0-9]/.test(w)).length;

/**
 * Whether an evidence quote is the learner's own words. A verbatim span (quoteIsIn), or, since v3, a
 * quote a grader stitched from several verbatim spans: split at an ellipsis ("..." or "…") or a sentence
 * end, every piece must appear in the justification after the previous one, and every run of pieces that
 * is not contiguous in the justification must be at least QUOTE_PIECE_MIN_WORDS words long. Haiku often
 * joins two spans this way (review AR-BIZ-3); the rule that credit needs verbatim evidence is unchanged.
 */
export function quoteSupported(quote: string | null | undefined, source: string): boolean {
  if (quoteIsIn(quote, source)) return true;
  if (!quote) return false;
  const pieces = normaliseForQuote(quote)
    .split(/\.\.\.|…|(?<=[.!?;])\s+/)
    .map(trimQuote)
    .filter(Boolean);
  if (pieces.length < 2 || pieces.length > QUOTE_MAX_PIECES * 3) return false;
  const src = normaliseForQuote(source);
  // Spans of the source the pieces cover, merged where only spaces and punctuation separate them.
  const spans: { start: number; end: number; words: number }[] = [];
  let from = 0;
  for (const piece of pieces) {
    const at = src.indexOf(piece, from);
    if (at < 0) return false;
    const last = spans.at(-1);
    if (last && /^[\s.,;:!?'"…-]*$/.test(src.slice(last.end, at))) {
      last.end = at + piece.length;
      last.words += words(piece);
    } else spans.push({ start: at, end: at + piece.length, words: words(piece) });
    from = at + piece.length;
  }
  return spans.length <= QUOTE_MAX_PIECES && spans.every((x) => x.words >= QUOTE_PIECE_MIN_WORDS);
}

export const DIMENSION_KEYS: readonly ReasoningDimensionKey[] = ['correctness', 'reasoning', 'architecture', 'risk'];
export const DIMENSION_LABELS: Record<ReasoningDimensionKey, string> = {
  correctness: 'Selected-answer correctness',
  reasoning: 'Technical reasoning and evidence',
  architecture: 'Attack-path and architecture understanding',
  risk: 'Risk awareness and decision trade-offs',
};
export const DEFAULT_WEIGHTS: Weights = { correctness: 30, reasoning: 40, architecture: 20, risk: 10 };

export const SCORING_RULES = {
  /** Credit per rubric point by status. */
  statusCredit: { met: 1, partial: 0.5, missed: 0 } as Record<PointStatus, number>,
  /** Each confirmed technical error removes this fraction of the reasoning dimension, up to the cap. */
  technicalErrorPenalty: 0.1,
  technicalErrorCap: 0.5,
  /** A justification that argues for another option than the one selected is capped here on reasoning. */
  contradictionCap: 0.5,
  /** A wrong selection caps the reasoning dimension: the reasoning led to the wrong decision. */
  wrongSelectionReasoningCap: 0.6,
} as const;

/** Any partial weight map becomes four integers summing to 100 (largest-remainder rounding). */
export function normaliseWeights(partial: Partial<Weights> | null | undefined, base: Weights = DEFAULT_WEIGHTS): Weights {
  const raw = DIMENSION_KEYS.map((k) => Math.max(0, Number(partial?.[k] ?? base[k]) || 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ...base };
  const scaled = raw.map((v) => (v * 100) / sum);
  const floors = scaled.map(Math.floor);
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = scaled.map((v, i) => ({ i, frac: v - floors[i]! })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i]! += 1;
    remainder -= 1;
  }
  return Object.fromEntries(DIMENSION_KEYS.map((k, i) => [k, floors[i]!])) as Weights;
}

export interface PointJudgement {
  pointId: string;
  status: PointStatus;
  rationale: string;
  quote: string | null;
}

export interface ScoringInput {
  weights: Weights;
  rubric: RubricPoint[];
  mustNotCredit: MustNotCredit[];
  correctOption: OptionId;
  selectedOption: OptionId;
  selectedVerdict: OptionVerdict;
  partialCreditForPlausible: number;
  justification: string;
  /** Final judgements (reconciler, or the fallback assembled from the earlier stages). */
  final: PointJudgement[];
  /**
   * The disagreement baseline for the confidence level: the first stage's judgements, or (an escalated
   * tiered evaluation) the first stage's with the challenger's objections applied.
   */
  evaluator: PointJudgement[];
  /** must-not-credit ids the graders say the justification asserts. */
  assertedClaims: string[];
  technicalErrors: { quote: string; why: string }[];
  challenger: { hallucinatedReferences: number; fluentButWrong: boolean; missingCritical: number };
  integrity: { offTopic: boolean; instructsGrader: boolean; arguesForOption: OptionId | null };
  degraded: boolean;
  /**
   * Set when no later stage ran (the single-pass evaluation): the evaluator's self-reported confidence.
   * With no second stage there is no disagreement to measure, so the result is no more confident than
   * the grader says it is.
   */
  singlePassConfidence?: 'high' | 'medium' | 'low';
}

export interface ScoreOutcome {
  version: string;
  total: number;
  correct: boolean;
  dimensions: DimensionResult[];
  confidence: 'high' | 'medium' | 'low';
  reviewFlag: boolean;
  notes: string[];
  /** Statuses after the quote check and the must-not-credit list, for feedback assembly. */
  adjusted: Map<string, PointJudgement>;
  /** Credited points withdrawn because their quote is not in the justification (step 2). */
  quoteDowngrades: number;
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreAttempt(input: ScoringInput): ScoreOutcome {
  const notes: string[] = [];
  const adjusted = new Map<string, PointJudgement>();
  const dimNotes: Record<ReasoningDimensionKey, string[]> = { correctness: [], reasoning: [], architecture: [], risk: [] };

  // 1. Every rubric point gets a judgement; one the graders did not return is missed.
  for (const p of input.rubric) {
    const j = input.final.find((f) => f.pointId === p.id) ?? { pointId: p.id, status: 'missed' as PointStatus, rationale: 'Not addressed in the justification.', quote: null };
    adjusted.set(p.id, { ...j });
  }

  // 2. Evidence-quote check: credit without a verbatim quote from the justification is withdrawn (ADD L17b).
  let quoteDowngrades = 0;
  for (const j of adjusted.values()) {
    if (j.status !== 'missed' && !quoteSupported(j.quote, input.justification)) {
      j.status = 'missed';
      j.quote = null;
      j.rationale = 'Credited by the grader without a verbatim quote from your justification; not counted.';
      quoteDowngrades++;
    }
  }
  if (quoteDowngrades) notes.push(`${quoteDowngrades} point${quoteDowngrades > 1 ? 's' : ''} withdrawn: no verbatim evidence in the justification.`);

  // 3. Must-not-credit: an asserted wrong claim invalidates the points it lists.
  const asserted = input.mustNotCredit.filter((m) => input.assertedClaims.includes(m.id));
  for (const m of asserted) {
    for (const id of m.invalidates) {
      const j = adjusted.get(id);
      if (j && j.status !== 'missed') {
        j.status = 'missed';
        j.rationale = `Cannot be credited: the justification relies on a claim that does not hold here (${m.claim}).`;
      }
    }
  }
  if (asserted.length) notes.push(`${asserted.length} claim${asserted.length > 1 ? 's' : ''} in the justification contradict the scenario; dependent points not credited.`);

  // 4. Integrity: off-topic or grader-instructing text earns nothing on the reasoning dimensions.
  const integrityFail = input.integrity.offTopic || input.integrity.instructsGrader;
  if (integrityFail) {
    for (const j of adjusted.values()) {
      j.status = 'missed';
      j.quote = null;
    }
    notes.push(input.integrity.instructsGrader ? 'The justification tried to instruct the grader; reasoning dimensions scored 0 and the result is flagged for review.' : 'The justification did not address the question; reasoning dimensions scored 0.');
  }

  // 5. Per-dimension fraction from weighted point credit.
  const fraction: Record<ReasoningDimensionKey, number> = { correctness: 0, reasoning: 0, architecture: 0, risk: 0 };
  for (const dim of ['reasoning', 'architecture', 'risk'] as const) {
    const points = input.rubric.filter((p) => p.dimension === dim);
    const denom = points.reduce((n, p) => n + p.weight, 0);
    const num = points.reduce((n, p) => n + p.weight * SCORING_RULES.statusCredit[adjusted.get(p.id)!.status], 0);
    fraction[dim] = denom > 0 ? num / denom : 0;
    if (!points.length) dimNotes[dim].push('No rubric points for this dimension.');
  }

  // 6. Confirmed technical errors reduce the reasoning dimension.
  const errorCount = integrityFail ? 0 : input.technicalErrors.length;
  if (errorCount) {
    const cut = Math.min(SCORING_RULES.technicalErrorCap, errorCount * SCORING_RULES.technicalErrorPenalty);
    fraction.reasoning *= 1 - cut;
    dimNotes.reasoning.push(`${errorCount} technical error${errorCount > 1 ? 's' : ''} confirmed: reasoning reduced by ${Math.round(cut * 100)}%.`);
  }

  // 7. A justification that argues for a different option cannot earn high reasoning credit.
  const contradicts = input.integrity.arguesForOption !== null && input.integrity.arguesForOption !== input.selectedOption;
  if (contradicts && fraction.reasoning > SCORING_RULES.contradictionCap) {
    fraction.reasoning = SCORING_RULES.contradictionCap;
    dimNotes.reasoning.push(`Your justification argues for option ${input.integrity.arguesForOption} but you selected ${input.selectedOption}; reasoning capped at 50%.`);
  } else if (contradicts) {
    dimNotes.reasoning.push(`Your justification argues for option ${input.integrity.arguesForOption} but you selected ${input.selectedOption}.`);
  }

  // 8. Correctness of the selected option, with configured partial credit for the runner-up.
  const correct = input.selectedOption === input.correctOption;
  if (correct) fraction.correctness = 1;
  else if (input.selectedVerdict === 'plausible') {
    fraction.correctness = Math.max(0, Math.min(1, input.partialCreditForPlausible));
    dimNotes.correctness.push(`Option ${input.selectedOption} is a defensible runner-up; partial credit of ${Math.round(fraction.correctness * 100)}%.`);
  } else dimNotes.correctness.push(`Option ${input.selectedOption} is not the best decision for this scenario.`);
  if (!correct && fraction.reasoning > SCORING_RULES.wrongSelectionReasoningCap) {
    fraction.reasoning = SCORING_RULES.wrongSelectionReasoningCap;
    dimNotes.reasoning.push('The reasoning led to the wrong decision; reasoning capped at 60%.');
  }

  // 9. Points per dimension and the total, clamped.
  const dimensions: DimensionResult[] = DIMENSION_KEYS.map((key) => ({
    key,
    label: DIMENSION_LABELS[key],
    weight: input.weights[key],
    score: round1(Math.max(0, Math.min(1, fraction[key])) * input.weights[key]),
    evidence:
      key === 'correctness'
        ? []
        : input.rubric
            .filter((p) => p.dimension === key)
            .map((p) => {
              const j = adjusted.get(p.id)!;
              return { point: p.text, status: j.status, rationale: j.rationale, quote: j.quote };
            }),
    notes: dimNotes[key],
  }));
  const total = Math.max(0, Math.min(100, Math.round(dimensions.reduce((n, d) => n + d.score, 0))));

  // 10. Confidence from inter-stage disagreement and challenger findings (spec §5: review flag when appropriate).
  const value = (s: PointStatus) => SCORING_RULES.statusCredit[s];
  let major = 0;
  let minor = 0;
  for (const p of input.rubric) {
    const first = input.evaluator.find((e) => e.pointId === p.id)?.status ?? 'missed';
    const last = input.final.find((f) => f.pointId === p.id)?.status ?? 'missed';
    const delta = Math.abs(value(first) - value(last));
    if (delta >= 1) major++;
    else if (delta >= 0.5) minor++;
  }
  const flagged = input.challenger.hallucinatedReferences > 0 || input.challenger.fluentButWrong;
  let confidence: ScoreOutcome['confidence'] = 'high';
  if (major >= 1 || flagged || input.degraded || integrityFail) confidence = 'low';
  else if (minor >= 2 || input.challenger.missingCritical >= 1 || quoteDowngrades >= 2) confidence = 'medium';
  if (input.singlePassConfidence && CONFIDENCE_RANK[input.singlePassConfidence] < CONFIDENCE_RANK[confidence]) confidence = input.singlePassConfidence;
  if (major || minor) notes.push(`Grader agreement: ${major} major and ${minor} minor disagreement${major + minor === 1 ? '' : 's'} between stages.`);
  if (flagged) notes.push(input.challenger.fluentButWrong ? 'Flagged as fluent but technically wrong.' : 'Flagged for references that could not be verified.');
  if (input.degraded) notes.push('Simplified scoring: one evaluation stage was unavailable, so this result is marked for review.');
  const reviewFlag = confidence === 'low' || input.degraded || input.integrity.instructsGrader;

  return { version: REASONING_SCORING_VERSION, total, correct, dimensions, confidence, reviewFlag, notes, adjusted, quoteDowngrades };
}
