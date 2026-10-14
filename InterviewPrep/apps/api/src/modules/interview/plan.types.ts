import type { SkillLevel } from '@threatready/contracts';

export type PlanItemKind =
  | 'introduction'
  | 'claim_verification'
  | 'jd_technical'
  | 'gap_probe'
  | 'problem_solving'
  | 'scenario'
  | 'system_design'
  | 'coding_discussion'
  | 'behavioral'
  | 'closing';

/** Real interviews move through sections; the interviewer signposts each change. */
export type InterviewSection = 'opening' | 'background' | 'technical' | 'scenario' | 'behavioral' | 'closing';

export function sectionOf(kind: PlanItemKind): InterviewSection {
  switch (kind) {
    case 'introduction':
      return 'opening';
    case 'claim_verification':
      return 'background';
    case 'scenario':
    case 'problem_solving':
      return 'scenario';
    case 'behavioral':
      return 'behavioral';
    case 'closing':
      return 'closing';
    default:
      return 'technical';
  }
}

export interface PlanItem {
  id: string;
  seq: number;
  kind: PlanItemKind;
  section: InterviewSection;
  skillId: string;
  targetLevel: SkillLevel;
  /** Why this question is in the plan, in the interviewer's terms. Shown in the report. */
  intent: string;
  claim?: string;
  evidenceQuote?: string;
  scenarioSeed?: string;
  rubricId: string;
  followUpLimit: number;
  estMinutes: number;
}

/** Built in code from the gap analysis (ADD §7 step 3). The model never decides the structure. */
export interface InterviewPlan {
  planVersion: string;
  contentVersion: string;
  rubricVersion: string;
  objectives: string[];
  items: PlanItem[];
  maxTurns: number;
  maxFollowUps: number;
  topicDistribution: Record<string, number>;
  followUpStrategy: string;
}

export type Directive = 'standard' | 'deepen' | 'clarify' | 'probe';

export interface PendingTurn {
  /** Pre-allocated so a recovered stream stores the question under the same id. */
  turnId: string;
  planItemId: string;
  kind: 'question' | 'follow_up';
  seq: number;
  questionNumber: number;
  directive: Directive;
  followUpFocus?: string;
  missingConcepts?: string[];
}

/** Held by the application, not the model (ADD L14: "running summary held by the application"). */
export interface SessionProgress {
  itemIndex: number;
  questionNumber: number;
  turnsUsed: number;
  followUpsUsed: number;
  perItemFollowUps: Record<string, number>;
  runningSummary: string[];
  /** Mean criterion level of recent answers, newest last. Drives adaptive difficulty. */
  recentLevels: number[];
  directive: Directive;
  pendingTurn?: PendingTurn;
  askingLeaseUntil?: string;
  integrityFlags: number;
  retryReportCount?: number;
}

export const emptyProgress = (): SessionProgress => ({
  itemIndex: 0,
  questionNumber: 0,
  turnsUsed: 0,
  followUpsUsed: 0,
  perItemFollowUps: {},
  runningSummary: [],
  recentLevels: [],
  directive: 'standard',
  integrityFlags: 0,
});

/** Rubric key per plan item kind. */
export const RUBRIC_TYPE: Record<PlanItemKind, string> = {
  introduction: 'introduction',
  claim_verification: 'claim_verification',
  jd_technical: 'jd_technical',
  gap_probe: 'gap_probe',
  problem_solving: 'problem_solving',
  scenario: 'scenario',
  system_design: 'system_design',
  coding_discussion: 'coding_discussion',
  behavioral: 'behavioral',
  closing: 'closing',
};

/**
 * The rubric a turn is assessed with. A follow-up to the introduction asks about a specific project
 * or role the candidate mentioned, so it is assessed (and scored) like an experience question; the
 * introduction itself stays unscored.
 */
export function rubricKindFor(item: PlanItem, turnKind: 'question' | 'follow_up'): PlanItemKind {
  return item.kind === 'introduction' && turnKind === 'follow_up' ? 'claim_verification' : item.kind;
}
