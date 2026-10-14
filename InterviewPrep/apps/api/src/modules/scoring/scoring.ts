import type { RequirementWeight } from '@threatready/contracts';
import { CRITERIA, type CriterionId, type RubricDef } from '../../platform/content/content.service.js';
import type { PlanItemKind } from '../interview/plan.types.js';

/**
 * Deterministic scoring (ADD §7 scoring pipeline). The model returns criterion levels with
 * evidence quotes; this module turns validated levels into every number in the report.
 * Changing anything here requires a new SCORING_VERSION so stored evaluations stay comparable.
 */
export const SCORING_VERSION = 'score.v1.2026-10-12';

/** Level 0-4 -> points on the 0-100 scale. */
export const LEVEL_POINTS = [0, 25, 50, 75, 100] as const;

/** Category weights for the overall score; renormalised over the categories that apply. */
export const CATEGORY_WEIGHTS = {
  technicalKnowledge: 0.35,
  problemSolving: 0.25,
  communication: 0.15,
  roleSkillCoverage: 0.25,
} as const;

/** Weight of a follow-up turn relative to a main question when aggregating per skill. */
export const FOLLOW_UP_WEIGHT = 0.5;
const PROBLEM_SOLVING_KINDS: PlanItemKind[] = ['scenario', 'problem_solving', 'system_design', 'coding_discussion'];
const REQUIREMENT_WEIGHT: Record<RequirementWeight, number> = { must: 3, should: 2, nice: 1 };

export interface ScoredTurnInput {
  turnId: string;
  kind: 'question' | 'follow_up';
  itemKind: PlanItemKind;
  skillId: string;
  rubric: RubricDef;
  answered: boolean;
  /** Validated levels after the quote check; criteria missing from the map are treated as 0. */
  levels: Partial<Record<CriterionId, number>>;
}

export interface TurnScore {
  turnId: string;
  score: number | null;
  dimensions: Record<CriterionId, number | null>;
  scored: boolean;
}

export interface ScoreResult {
  version: string;
  turns: TurnScore[];
  skills: { skillId: string; score: number; weight: number }[];
  categories: {
    technicalKnowledge: number | null;
    problemSolving: number | null;
    communication: number | null;
    roleSkillCoverage: number | null;
  };
  overall: number;
}

const round = (n: number) => Math.round(n);
const mean = (xs: { v: number; w: number }[]): number | null => {
  const w = xs.reduce((n, x) => n + x.w, 0);
  return w > 0 ? xs.reduce((n, x) => n + x.v * x.w, 0) / w : null;
};

export function scoreTurn(t: ScoredTurnInput): TurnScore {
  const dimensions = Object.fromEntries(
    CRITERIA.map((c) => [c, t.rubric.weights[c] > 0 && t.answered ? LEVEL_POINTS[clampLevel(t.levels[c] ?? 0)] : null]),
  ) as Record<CriterionId, number | null>;
  if (!t.answered) return { turnId: t.turnId, score: null, dimensions, scored: false };
  const parts = CRITERIA.filter((c) => t.rubric.weights[c] > 0).map((c) => ({ v: dimensions[c]!, w: t.rubric.weights[c] }));
  const s = mean(parts);
  return { turnId: t.turnId, score: s === null ? null : round(s), dimensions, scored: t.rubric.scored !== false };
}

const clampLevel = (n: number): 0 | 1 | 2 | 3 | 4 => Math.max(0, Math.min(4, Math.round(n))) as 0 | 1 | 2 | 3 | 4;

export function computeScores(
  turns: ScoredTurnInput[],
  requiredSkills: { skillId: string; weight: RequirementWeight }[],
): ScoreResult {
  const scored = turns.map(scoreTurn);
  const byId = new Map(scored.map((s) => [s.turnId, s]));
  const turnWeight = (t: ScoredTurnInput) => (t.kind === 'follow_up' ? FOLLOW_UP_WEIGHT : 1);

  // Per-skill score: weighted mean of scored turns targeting the skill.
  const skillParts = new Map<string, { v: number; w: number }[]>();
  for (const t of turns) {
    const s = byId.get(t.turnId)!;
    if (!s.scored || s.score === null) continue;
    const list = skillParts.get(t.skillId) ?? [];
    list.push({ v: s.score, w: turnWeight(t) });
    skillParts.set(t.skillId, list);
  }
  const skills = [...skillParts.entries()].map(([skillId, parts]) => ({
    skillId,
    score: round(mean(parts)!),
    weight: parts.reduce((n, p) => n + p.w, 0),
  }));
  const skillScore = new Map(skills.map((s) => [s.skillId, s.score]));

  const technical: { v: number; w: number }[] = [];
  const problem: { v: number; w: number }[] = [];
  const communication: { v: number; w: number }[] = [];
  for (const t of turns) {
    const s = byId.get(t.turnId)!;
    if (!t.answered) continue;
    const w = turnWeight(t);
    if (s.scored && s.dimensions.technical_correctness !== null) technical.push({ v: s.dimensions.technical_correctness, w });
    if (s.scored && s.dimensions.reasoning !== null) {
      problem.push({ v: s.dimensions.reasoning, w: PROBLEM_SOLVING_KINDS.includes(t.itemKind) ? 2 * w : w });
    }
    if (s.dimensions.communication !== null) communication.push({ v: s.dimensions.communication, w });
  }

  // Role coverage: JD-required skills weighted must 3 / should 2 / nice 1; an untested skill counts 0.
  const coverageParts = requiredSkills.map((r) => ({ v: skillScore.get(r.skillId) ?? 0, w: REQUIREMENT_WEIGHT[r.weight] }));

  const categories = {
    technicalKnowledge: nullableRound(mean(technical)),
    problemSolving: nullableRound(mean(problem)),
    communication: nullableRound(mean(communication)),
    roleSkillCoverage: nullableRound(mean(coverageParts)),
  };
  const overallParts = (Object.keys(CATEGORY_WEIGHTS) as (keyof typeof CATEGORY_WEIGHTS)[])
    .filter((k) => categories[k] !== null)
    .map((k) => ({ v: categories[k]!, w: CATEGORY_WEIGHTS[k] }));
  return { version: SCORING_VERSION, turns: scored, skills, categories, overall: round(mean(overallParts) ?? 0) };
}

const nullableRound = (n: number | null) => (n === null ? null : round(n));
