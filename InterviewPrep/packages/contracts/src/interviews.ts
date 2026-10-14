import {
  Difficulty,
  DurationMin,
  InterviewerStatus,
  InterviewMode,
  InterviewType,
  LIMITS,
  SessionState,
  Track,
} from './enums.js';
import { CandidateProfile, JobProfile, ProfileCorrections } from './profiles.js';
import { z } from './zod.js';

/** Current wording version of the AI-processing notice shown before analysis (DPDP, ADD §9). */
export const AI_CONSENT_VERSION = 'ai-processing.v1.2026-10-12';

export const CreateInterviewRequest = z
  .object({
    resumeDocumentId: z.uuid(),
    jdDocumentId: z.uuid(),
    /** Explicit, itemised consent to send document and answer text to the AI provider. */
    aiProcessingConsent: z.object({ accepted: z.literal(true), version: z.literal(AI_CONSENT_VERSION) }),
  })
  .openapi('CreateInterviewRequest');
export type CreateInterviewRequest = z.infer<typeof CreateInterviewRequest>;

export const InterviewConfig = z
  .object({
    interviewType: InterviewType,
    difficulty: Difficulty,
    durationMin: DurationMin,
    mode: InterviewMode,
    track: Track,
    /** Skill ids from the framework the candidate wants emphasised. */
    focusSkillIds: z.array(z.string().max(80)).max(5).default([]),
    /** Ask questions aloud with the browser's speech synthesis. Text always stays visible. */
    speakQuestions: z.boolean().default(false),
    /** Answer by speaking (browser speech recognition fills the answer box; it stays editable). */
    voiceAnswers: z.boolean().default(false),
  })
  .openapi('InterviewConfig');
export type InterviewConfig = z.infer<typeof InterviewConfig>;

export const PlanInterviewRequest = z
  .object({ config: InterviewConfig, corrections: ProfileCorrections.optional() })
  .openapi('PlanInterviewRequest');
export type PlanInterviewRequest = z.infer<typeof PlanInterviewRequest>;

export const Recommendation = z
  .object({
    interviewType: InterviewType,
    difficulty: Difficulty,
    durationMin: DurationMin,
    track: Track,
    rationale: z.array(z.string()),
  })
  .openapi('Recommendation');
export type Recommendation = z.infer<typeof Recommendation>;

export const SkillRef = z.object({ id: z.string(), label: z.string(), category: z.string() }).openapi('SkillRef');
export type SkillRef = z.infer<typeof SkillRef>;

export const Briefing = z
  .object({
    sessionId: z.uuid(),
    candidateProfile: CandidateProfile,
    jobProfile: JobProfile,
    recommendation: Recommendation,
    /** Labels for every skill id referenced by the two profiles. */
    skills: z.array(SkillRef),
    /** Up to 12 claims and gaps the interview will focus on, from the gap analysis. */
    focusPreview: z.array(z.object({ skillId: z.string(), label: z.string(), reason: z.enum(['verify_claim', 'probe_gap']) })),
    roleLabel: z.string(),
  })
  .openapi('Briefing');
export type Briefing = z.infer<typeof Briefing>;

export const TurnKind = z.enum(['question', 'follow_up']).openapi('TurnKind');

export const PracticeFeedback = z
  .object({
    demonstrated: z.array(z.string()).max(5),
    missing: z.array(z.string()).max(5),
    tip: z.string().nullable(),
  })
  .openapi('PracticeFeedback');
export type PracticeFeedback = z.infer<typeof PracticeFeedback>;

export const TranscriptEntry = z
  .object({
    turnId: z.uuid(),
    seq: z.number().int(),
    kind: TurnKind,
    questionNumber: z.number().int(),
    topic: z.string(),
    question: z.string(),
    answer: z.string().nullable(),
    askedAt: z.iso.datetime(),
    answeredAt: z.iso.datetime().nullable(),
    practiceFeedback: PracticeFeedback.nullable(),
    /** Clarifying questions the candidate asked about this question, with the interviewer's replies. */
    clarifications: z.array(z.object({ question: z.string(), answer: z.string(), at: z.iso.datetime() })),
  })
  .openapi('TranscriptEntry');
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

export const SessionView = z
  .object({
    id: z.uuid(),
    state: SessionState,
    interviewerStatus: InterviewerStatus,
    roleTitle: z.string().nullable(),
    config: InterviewConfig.nullable(),
    progress: z.object({
      questionNumber: z.number().int(),
      plannedQuestions: z.number().int(),
      turnsUsed: z.number().int(),
      maxTurns: z.number().int(),
    }),
    timing: z.object({
      durationSec: z.number().int(),
      activeElapsedSec: z.number().int(),
      remainingSec: z.number().int(),
      /** Server clock, so the client timer cannot drift from the authoritative one. */
      serverNow: z.iso.datetime(),
      runningSince: z.iso.datetime().nullable(),
    }),
    currentTurn: TranscriptEntry.nullable(),
    transcript: z.array(TranscriptEntry),
    report: z.object({ status: z.enum(['none', 'pending', 'ready', 'failed']), overallScore: z.number().int().nullable() }),
    failure: z.object({ code: z.string(), stage: z.string() }).nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    endReason: z.string().nullable(),
  })
  .openapi('SessionView');
export type SessionView = z.infer<typeof SessionView>;

export const SubmitAnswerRequest = z
  .object({
    turnId: z.uuid(),
    answer: z.string().trim().min(1).max(LIMITS.answerMaxChars),
    /** Idempotency key generated by the client for this submission. */
    clientSubmissionId: z.uuid(),
  })
  .openapi('SubmitAnswerRequest');
export type SubmitAnswerRequest = z.infer<typeof SubmitAnswerRequest>;

export const ClarifyRequest = z
  .object({
    turnId: z.uuid(),
    /** What the candidate asked, e.g. "Could you repeat that?" or "Do I have admin access in this scenario?" */
    message: z.string().trim().min(2).max(500),
  })
  .openapi('ClarifyRequest');
export type ClarifyRequest = z.infer<typeof ClarifyRequest>;

export const EndInterviewRequest = z.object({ reason: z.enum(['candidate_ended']).default('candidate_ended') }).openapi('EndInterviewRequest');

/**
 * Server-Sent Events emitted by POST /start, /question and /turns. The answer is a POST and
 * the response streams (ADD L5). Every stream ends with exactly one `done` or `error`.
 */
export const TurnStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('evaluating') }),
  z.object({ type: z.literal('feedback'), turnId: z.uuid(), feedback: PracticeFeedback }),
  z.object({
    type: z.literal('question.start'),
    turnId: z.uuid(),
    kind: TurnKind,
    questionNumber: z.number().int(),
    topic: z.string(),
  }),
  z.object({ type: z.literal('question.delta'), text: z.string() }),
  /** The streamed text is discarded and replaced (template fallback after a failed stream). */
  z.object({ type: z.literal('question.reset') }),
  /** The interviewer's reply to a clarifying question, streamed. */
  z.object({ type: z.literal('reply.delta'), text: z.string() }),
  z.object({ type: z.literal('done'), session: SessionView }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    request_id: z.string(),
  }),
]);
export type TurnStreamEvent = z.infer<typeof TurnStreamEvent>;

export const SessionSummary = z
  .object({
    id: z.uuid(),
    state: SessionState,
    roleTitle: z.string().nullable(),
    interviewType: InterviewType.nullable(),
    difficulty: Difficulty.nullable(),
    durationMin: z.number().int().nullable(),
    overallScore: z.number().int().nullable(),
    questionsAnswered: z.number().int(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .openapi('SessionSummary');
export type SessionSummary = z.infer<typeof SessionSummary>;

export const SessionList = z
  .object({ items: z.array(SessionSummary), nextCursor: z.string().nullable() })
  .openapi('SessionList');
export type SessionList = z.infer<typeof SessionList>;
