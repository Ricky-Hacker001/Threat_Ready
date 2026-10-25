import { Difficulty, DurationMin, InterviewType, Track } from './enums.js';
import { z } from './zod.js';

const Score = z.number().int().min(0).max(100);

/** Dimension scores on the 0-100 scale. null when the dimension did not apply to the answer. */
export const DimensionScores = z
  .object({
    technicalCorrectness: Score.nullable(),
    completeness: Score.nullable(),
    reasoning: Score.nullable(),
    communication: Score.nullable(),
    skillEvidence: Score.nullable(),
  })
  .openapi('DimensionScores');
export type DimensionScores = z.infer<typeof DimensionScores>;

export const QuestionReview = z
  .object({
    turnId: z.uuid(),
    questionNumber: z.number().int(),
    kind: z.enum(['question', 'follow_up']),
    topic: z.string(),
    question: z.string(),
    answer: z.string().nullable(),
    score: Score.nullable(),
    dimensions: DimensionScores,
    correctConcepts: z.array(z.string()),
    missingConcepts: z.array(z.string()),
    inaccuracies: z.array(z.string()),
    improvements: z.array(z.string()),
    strongAnswerExample: z.string().nullable(),
    /** Short, evidence-based explanation of the score. Never a chain of thought. */
    explanation: z.string().nullable(),
  })
  .openapi('QuestionReview');
export type QuestionReview = z.infer<typeof QuestionReview>;

export const SkillOutcome = z
  .object({ skillId: z.string(), label: z.string(), score: Score.nullable(), required: z.boolean(), covered: z.boolean() })
  .openapi('SkillOutcome');
export type SkillOutcome = z.infer<typeof SkillOutcome>;

export const InterviewReport = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    generatedAt: z.iso.datetime(),
    disclaimer: z.string(),
    roleTitle: z.string(),
    config: z.object({ interviewType: InterviewType, difficulty: Difficulty, durationMin: DurationMin, track: Track }),
    overall: z.object({
      score: Score,
      technicalKnowledge: Score.nullable(),
      problemSolving: Score.nullable(),
      communication: Score.nullable(),
      roleSkillCoverage: Score.nullable(),
      summary: z.string(),
    }),
    scoringMethod: z.object({ version: z.string(), weights: z.record(z.string(), z.number()), notes: z.array(z.string()) }),
    questions: z.array(QuestionReview),
    skills: z.object({
      demonstrated: z.array(SkillOutcome),
      needsImprovement: z.array(SkillOutcome),
      jdGaps: z.array(SkillOutcome),
      practiceAreas: z.array(z.string()),
    }),
    improvementPlan: z.object({
      highPriority: z.array(z.object({ topic: z.string(), why: z.string() })),
      secondary: z.array(z.object({ topic: z.string(), why: z.string() })),
      practiceQuestions: z.array(z.string()),
      suggestedNextInterview: z.object({
        interviewType: InterviewType,
        difficulty: Difficulty,
        durationMin: DurationMin,
        focus: z.array(z.string()),
      }),
    }),
    integrityNotes: z.array(z.string()),
    /** Pauses and tab switches during the interview, for the candidate's information. Absent on older reports. */
    integrity: z.object({ pauseCount: z.number().int(), pausedSec: z.number().int(), tabHiddenCount: z.number().int() }).optional(),
    pdf: z.object({ available: z.boolean() }),
  })
  .openapi('InterviewReport');
export type InterviewReport = z.infer<typeof InterviewReport>;

export const SignedDownload = z.object({ url: z.string(), expiresAt: z.iso.datetime() }).openapi('SignedDownload');
export type SignedDownload = z.infer<typeof SignedDownload>;

export const SkillProgress = z
  .object({
    skillId: z.string(),
    label: z.string(),
    category: z.string(),
    score: Score,
    evidenceCount: z.number().int(),
    lastEvidenceAt: z.iso.datetime(),
  })
  .openapi('SkillProgress');
export type SkillProgress = z.infer<typeof SkillProgress>;

export const InterviewDashboard = z
  .object({
    completedCount: z.number().int(),
    averageScore: Score.nullable(),
    skillsDemonstrated: z.array(SkillProgress),
    skillsToImprove: z.array(SkillProgress),
    resumable: z.array(
      z.object({ id: z.uuid(), roleTitle: z.string().nullable(), state: z.string(), updatedAt: z.iso.datetime() }),
    ),
    recent: z.array(
      z.object({
        id: z.uuid(),
        roleTitle: z.string().nullable(),
        state: z.string(),
        overallScore: Score.nullable(),
        createdAt: z.iso.datetime(),
      }),
    ),
    scoreHistory: z.array(z.object({ sessionId: z.uuid(), score: Score, completedAt: z.iso.datetime() })),
    usage: z.object({ interviewsThisMonth: z.number().int(), monthlyQuota: z.number().int() }),
  })
  .openapi('InterviewDashboard');
export type InterviewDashboard = z.infer<typeof InterviewDashboard>;
