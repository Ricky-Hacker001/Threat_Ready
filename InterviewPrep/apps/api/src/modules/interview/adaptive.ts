import type { Difficulty } from '@threatready/contracts';
import type { TurnEvaluation } from '../ai/prompts/interview.prompts.js';
import type { Directive, InterviewPlan, PlanItem, SessionProgress } from './plan.types.js';

export type NextStep =
  | { action: 'follow_up'; item: PlanItem; directive: Directive; focus: string; missingConcepts: string[] }
  | { action: 'next'; item: PlanItem; itemIndex: number; directive: Directive }
  | { action: 'complete'; reason: 'plan_complete' | 'turn_limit' | 'time_up' };

const MIN_SECONDS_FOR_FOLLOW_UP = 180;
const CLOSING_RESERVE_SECONDS = 150;

/** Mean level (0-4) over the criteria the model returned. */
export function meanLevel(ev: TurnEvaluation | null): number | null {
  if (!ev || !ev.criteria.length) return null;
  return ev.criteria.reduce((n, c) => n + Number(c.level), 0) / ev.criteria.length;
}

/** Below this many words an answer is treated as "I don't know": the interviewer moves on kindly. */
const LOW_EFFORT_WORDS = 8;

/**
 * The follow-up decision is made in code (ADD LLD-5), the way a real interviewer probes: any
 * substantive answer can get one follow-up that picks up what the candidate said (thin answers are
 * clarified, solid ones probed for specifics, strong ones deepened). "I don't know" is never chased.
 * Limits: the item's follow-up limit, the session total spread evenly across the plan, three
 * minutes of time left and room in the turn cap. Otherwise the next plan item is chosen, with
 * difficulty adapted to the recent trend.
 */
export function decideNext(args: {
  plan: InterviewPlan;
  progress: SessionProgress;
  currentItem: PlanItem;
  evaluation: TurnEvaluation | null;
  remainingSec: number;
  difficulty: Difficulty;
  /** The answer just given; used to spot "I don't know" answers. */
  answer?: string;
}): NextStep {
  const { plan, progress, currentItem, evaluation, remainingSec } = args;
  const turnsAfterThis = progress.turnsUsed; // already counts the answered turn
  if (turnsAfterThis >= plan.maxTurns) return { action: 'complete', reason: 'turn_limit' };
  if (remainingSec <= 30) return { action: 'complete', reason: 'time_up' };

  const avg = meanLevel(evaluation);
  const words = args.answer === undefined ? Infinity : args.answer.trim().split(/\s+/).filter(Boolean).length;
  if (evaluation && avg !== null && words >= LOW_EFFORT_WORDS && (avg >= 1 || currentItem.kind === 'introduction')) {
    const usedForItem = progress.perItemFollowUps[currentItem.id] ?? 0;
    const itemPos = Math.max(0, plan.items.findIndex((i) => i.id === currentItem.id));
    // Spread the session's follow-ups over the plan instead of spending them all early.
    const paced = progress.followUpsUsed < Math.ceil((plan.maxFollowUps * (itemPos + 1)) / plan.items.length);
    const integrityProblem = evaluation.answer_integrity.instructs_grader || evaluation.answer_integrity.off_topic;
    const directive: Directive =
      currentItem.kind === 'introduction' ? 'probe' : avg < 2.25 ? 'clarify' : avg >= 3.25 && args.difficulty !== 'beginner' ? 'deepen' : 'probe';
    const allowed =
      (evaluation.follow_up_suggested || directive === 'clarify') &&
      !integrityProblem &&
      usedForItem < currentItem.followUpLimit &&
      progress.followUpsUsed < plan.maxFollowUps &&
      paced &&
      remainingSec >= MIN_SECONDS_FOR_FOLLOW_UP &&
      turnsAfterThis + 1 < plan.maxTurns;
    if (allowed) {
      return {
        action: 'follow_up',
        item: currentItem,
        directive,
        focus: evaluation.follow_up_focus ?? evaluation.concepts_missing[0]?.replace(/_/g, ' ') ?? 'the last answer',
        missingConcepts: evaluation.concepts_missing.slice(0, 4),
      };
    }
  }

  let nextIndex = progress.itemIndex + 1;
  const closingIndex = plan.items.findIndex((i) => i.kind === 'closing');
  // Keep time for the closing question rather than running out mid-plan.
  if (closingIndex > nextIndex && remainingSec < CLOSING_RESERVE_SECONDS) nextIndex = closingIndex;
  // Leave a turn for closing when the turn cap is near.
  if (closingIndex > nextIndex && turnsAfterThis + 1 >= plan.maxTurns) nextIndex = closingIndex;
  const item = plan.items[nextIndex];
  if (!item) return { action: 'complete', reason: 'plan_complete' };
  return { action: 'next', item, itemIndex: nextIndex, directive: trendDirective([...progress.recentLevels]) };
}

/** Adapt the next question to the last two answers: deepen when strong, simplify when struggling. */
export function trendDirective(levels: number[]): Directive {
  const recent = levels.slice(-2);
  if (!recent.length) return 'standard';
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (avg >= 3.4) return 'deepen';
  if (avg <= 1.5) return 'clarify';
  return 'standard';
}
