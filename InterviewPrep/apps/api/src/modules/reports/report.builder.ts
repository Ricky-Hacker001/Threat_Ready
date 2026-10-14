import type { InterviewConfig, InterviewReport, JobProfile, QuestionReview, SkillOutcome } from '@threatready/contracts';
import type { ContentService } from '../../platform/content/content.service.js';
import type { FinalScoring } from '../ai/prompts/interview.prompts.js';
import type { InterviewPlan } from '../interview/plan.types.js';
import type { TurnRow } from '../interview/session.repo.js';
import { CATEGORY_WEIGHTS, FOLLOW_UP_WEIGHT, LEVEL_POINTS, SCORING_VERSION, type ScoreResult } from '../scoring/scoring.js';

export const REPORT_DISCLAIMER =
  'This is a simulated interview assessment produced with AI assistance for practice. It reflects the answers given in this session only and is not a prediction of hiring success or an employment recommendation.';

const DEMONSTRATED_THRESHOLD = 70;
const IMPROVE_THRESHOLD = 55;

/** Builds the report from stored numbers. The model writes text only; every number comes from code. */
export function buildReport(args: {
  reportId: string;
  sessionId: string;
  content: ContentService;
  config: InterviewConfig;
  job: JobProfile;
  plan: InterviewPlan;
  turns: TurnRow[];
  scoring: FinalScoring | null;
  scores: ScoreResult;
  integrityFlags: number;
  pdfEnabled: boolean;
}): InterviewReport {
  const { content, job, plan, turns, scoring, scores } = args;
  const byTurn = new Map(scoring?.turns.map((t) => [t.turn_id, t]) ?? []);
  const scoreByTurn = new Map(scores.turns.map((t) => [t.turnId, t]));
  const label = (id: string) => content.skillLabel(id);

  const questions: QuestionReview[] = turns.map((t) => {
    const item = plan.items.find((i) => i.id === t.planItemId);
    const m = byTurn.get(t.id);
    const s = scoreByTurn.get(t.id);
    return {
      turnId: t.id,
      questionNumber: t.questionNumber,
      kind: t.kind,
      topic: item?.kind === 'closing' ? 'Wrap-up' : item?.kind === 'introduction' ? 'Introduction' : label(item?.skillId ?? ''),
      question: t.question,
      answer: t.answer,
      score: s?.scored ? s.score : null,
      dimensions: {
        technicalCorrectness: s?.dimensions.technical_correctness ?? null,
        completeness: s?.dimensions.completeness ?? null,
        reasoning: s?.dimensions.reasoning ?? null,
        communication: s?.dimensions.communication ?? null,
        skillEvidence: s?.dimensions.skill_evidence ?? null,
      },
      correctConcepts: m?.correct_concepts ?? [],
      missingConcepts: m?.missing_concepts ?? [],
      inaccuracies: m?.inaccuracies ?? [],
      improvements: m?.improvements ?? [],
      strongAnswerExample: t.answer ? (m?.strong_answer_example ?? null) : null,
      explanation: t.answer ? (m?.explanation ?? null) : 'Not answered before the interview ended.',
    };
  });

  const skillScore = new Map(scores.skills.map((s) => [s.skillId, s.score]));
  const required = new Map(job.required_skills.map((r) => [r.skill_id, r]));
  const outcome = (id: string): SkillOutcome => ({
    skillId: id,
    label: label(id),
    score: skillScore.get(id) ?? null,
    required: required.has(id),
    covered: skillScore.has(id),
  });
  const tested = scores.skills.map((s) => s.skillId);
  const demonstrated = tested.filter((id) => (skillScore.get(id) ?? 0) >= DEMONSTRATED_THRESHOLD).map(outcome);
  const needsImprovement = tested.filter((id) => (skillScore.get(id) ?? 0) < IMPROVE_THRESHOLD).map(outcome);
  const jdGaps = [...required.keys()].filter((id) => !skillScore.has(id) || (skillScore.get(id) ?? 0) < IMPROVE_THRESHOLD).map(outcome);

  const nextFocus = scoring?.next_focus_skill_ids.length ? scoring.next_focus_skill_ids : needsImprovement.map((s) => s.skillId).slice(0, 3);
  const nextDifficulty =
    scores.overall >= 80 && args.config.difficulty !== 'advanced'
      ? args.config.difficulty === 'beginner'
        ? 'intermediate'
        : 'advanced'
      : scores.overall < 45 && args.config.difficulty !== 'beginner'
        ? args.config.difficulty === 'advanced'
          ? 'intermediate'
          : 'beginner'
        : args.config.difficulty;

  return {
    id: args.reportId,
    sessionId: args.sessionId,
    generatedAt: new Date().toISOString(),
    disclaimer: REPORT_DISCLAIMER,
    roleTitle: job.title,
    config: { interviewType: args.config.interviewType, difficulty: args.config.difficulty, durationMin: args.config.durationMin, track: args.config.track },
    overall: {
      score: scores.overall,
      technicalKnowledge: scores.categories.technicalKnowledge,
      problemSolving: scores.categories.problemSolving,
      communication: scores.categories.communication,
      roleSkillCoverage: scores.categories.roleSkillCoverage,
      summary: scoring?.summary ?? 'No answers were assessed in this session.',
    },
    scoringMethod: {
      version: SCORING_VERSION,
      weights: { ...CATEGORY_WEIGHTS },
      notes: [
        `Each criterion is assessed on a 0-4 level that maps to ${LEVEL_POINTS.join('/')} points; a level counts only with a verbatim quote from your answer.`,
        'Question scores are weighted by the rubric for that question type; follow-up questions count half.',
        'Role skill coverage weights the job description’s required skills: must 3, should 2, nice-to-have 1. Untested required skills count as 0.',
        `Follow-up weight ${FOLLOW_UP_WEIGHT}. Categories that do not apply are excluded and the remaining weights renormalised.`,
      ],
    },
    questions,
    skills: {
      demonstrated,
      needsImprovement,
      jdGaps,
      practiceAreas: [...new Set([...needsImprovement.map((s) => s.label), ...(scoring?.secondary.map((s) => s.topic) ?? [])])].slice(0, 8),
    },
    improvementPlan: {
      highPriority: scoring?.high_priority ?? [],
      secondary: scoring?.secondary ?? [],
      practiceQuestions: scoring?.practice_questions ?? [],
      suggestedNextInterview: {
        interviewType: args.config.interviewType,
        difficulty: nextDifficulty,
        durationMin: args.config.durationMin,
        focus: nextFocus.map(label),
      },
    },
    integrityNotes:
      args.integrityFlags > 0 || scoring?.turns.some((t) => t.instructs_grader)
        ? ['Some answers contained instructions aimed at the assessor. They were ignored, and only the substance of the answers was assessed.']
        : [],
    pdf: { available: args.pdfEnabled },
  };
}
