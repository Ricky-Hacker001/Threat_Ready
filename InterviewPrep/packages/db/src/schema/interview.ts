import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organisations, users } from './auth.js';
import { ownerPolicy } from './rls.js';

const tenant = {
  orgId: uuid('org_id')
    .notNull()
    .references(() => organisations.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
};
const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Columns shared by RESUMES and JOB_DESCRIPTIONS (ERD). Files stay in S3; text is stored redacted. */
const documentColumns = () => ({
  id: uuid('id').primaryKey().defaultRandom(),
  ...tenant,
  status: text('status', { enum: ['awaiting_upload', 'extracting', 'extracted', 'failed'] }).notNull(),
  source: text('source', { enum: ['upload', 'pasted'] }).notNull(),
  /** Opaque key; never derived from the file name. Null for pasted text. */
  objectKey: text('object_key'),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  pageCount: integer('page_count'),
  extractedText: text('extracted_text'),
  /** sha256 of extracted_text: profiles are reused while the text is unchanged. */
  textHash: text('text_hash'),
  editedByUser: boolean('edited_by_user').notNull().default(false),
  redactions: jsonb('redactions').$type<Record<string, number>>().notNull().default({}),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  failureCode: text('failure_code'),
  parserVersion: text('parser_version'),
  uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }),
  fileDeletedAt: timestamp('file_deleted_at', { withTimezone: true }),
  createdAt: created(),
  updatedAt: updated(),
});

export const resumes = pgTable('resumes', documentColumns(), (t) => [
  index('resumes_user_idx').on(t.userId, t.createdAt),
  // Retention and abandoned-upload sweeps (migration 0011).
  index('resumes_status_updated_idx').on(t.status, t.updatedAt),
  ownerPolicy('resumes'),
]).enableRLS();

export const jobDescriptions = pgTable('job_descriptions', documentColumns(), (t) => [
  index('job_descriptions_user_idx').on(t.userId, t.createdAt),
  index('job_descriptions_status_updated_idx').on(t.status, t.updatedAt),
  ownerPolicy('job_descriptions'),
]).enableRLS();

export const candidateProfiles = pgTable(
  'candidate_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    resumeId: uuid('resume_id')
      .notNull()
      .references(() => resumes.id, { onDelete: 'cascade' }),
    textHash: text('text_hash').notNull(),
    profile: jsonb('profile').notNull(),
    parserVersion: text('parser_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('candidate_profiles_resume_hash_uq').on(t.resumeId, t.textHash, t.parserVersion),
    ownerPolicy('candidate_profiles'),
  ],
).enableRLS();

export const jobProfiles = pgTable(
  'job_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    jobDescriptionId: uuid('job_description_id')
      .notNull()
      .references(() => jobDescriptions.id, { onDelete: 'cascade' }),
    textHash: text('text_hash').notNull(),
    profile: jsonb('profile').notNull(),
    parserVersion: text('parser_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('job_profiles_jd_hash_uq').on(t.jobDescriptionId, t.textHash, t.parserVersion),
    ownerPolicy('job_profiles'),
  ],
).enableRLS();

export interface SessionIntegrity {
  pauseCount?: number;
  idlePauseCount?: number;
  pausedMs?: number;
  /** ISO time of the current pause, while paused. */
  pausedAt?: string;
  tabHiddenCount?: number;
  tabHiddenMs?: number;
}

export const SESSION_STATES = [
  'parsing',
  'profiled',
  'planned',
  'asking',
  'awaiting_answer',
  'evaluating',
  'paused',
  'completed',
  'scoring',
  'report_ready',
  'failed',
  'expired',
  'cancelled',
] as const;

export const interviewSessions = pgTable(
  'interview_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    resumeId: uuid('resume_id').references(() => resumes.id, { onDelete: 'set null' }),
    jobDescriptionId: uuid('job_description_id').references(() => jobDescriptions.id, { onDelete: 'set null' }),
    candidateProfileId: uuid('candidate_profile_id').references(() => candidateProfiles.id, { onDelete: 'set null' }),
    jobProfileId: uuid('job_profile_id').references(() => jobProfiles.id, { onDelete: 'set null' }),
    state: text('state', { enum: SESSION_STATES }).notNull(),
    /** InterviewConfig chosen by the candidate. */
    config: jsonb('config'),
    /** Corrected profiles and gap analysis captured at planning time. */
    analysis: jsonb('analysis'),
    /** Plan built in code (ADD §7 step 3). */
    plan: jsonb('plan'),
    /** Code-held progress: plan cursor, follow-up counters, running summary, performance trend. */
    progress: jsonb('progress').notNull().default({}),
    /**
     * Pauses and tab switches, for the report (migration 0011). Updated with atomic increments and
     * without a version bump, so a tab-switch report never conflicts with a turn's state transition.
     */
    integrity: jsonb('integrity').$type<SessionIntegrity>().notNull().default({}),
    currentTurnId: uuid('current_turn_id'),
    /**
     * While `state = 'evaluating'`: the moment after which the evaluation is presumed lost (the API
     * process died between storing the answer and asking the next question). The sweeper moves such
     * sessions on without the evaluation, as a failed evaluation would.
     */
    evaluatingLeaseUntil: timestamp('evaluating_lease_until', { withTimezone: true }),
    activeElapsedMs: integer('active_elapsed_ms').notNull().default(0),
    runningSince: timestamp('running_since', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    endReason: text('end_reason'),
    /** Versioned consent to AI processing, recorded before any text is sent to the provider. */
    aiConsentVersion: text('ai_consent_version'),
    aiConsentAt: timestamp('ai_consent_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureStage: text('failure_stage'),
    /** Optimistic concurrency for state transitions. */
    version: integer('version').notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('interview_sessions_user_idx').on(t.userId, t.createdAt),
    index('interview_sessions_state_idx').on(t.state, t.updatedAt),
    ownerPolicy('interview_sessions'),
  ],
).enableRLS();

export const interviewTurns = pgTable(
  'interview_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    sessionId: uuid('session_id')
      .notNull()
      .references(() => interviewSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    planItemId: text('plan_item_id').notNull(),
    kind: text('kind', { enum: ['question', 'follow_up'] }).notNull(),
    questionNumber: integer('question_number').notNull(),
    question: text('question').notNull(),
    questionSource: text('question_source', { enum: ['model', 'template'] }).notNull(),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    answer: text('answer'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    clientSubmissionId: uuid('client_submission_id'),
    /** Provisional SMALL-tier evaluation (ADD §7 scoring step 1). Drives follow-ups only. */
    turnEvaluation: jsonb('turn_evaluation'),
    evaluationStatus: text('evaluation_status', { enum: ['pending', 'done', 'skipped', 'failed'] }),
    practiceFeedback: jsonb('practice_feedback'),
    /** Clarifying questions asked about this question and the interviewer's replies (max 3). */
    clarifications: jsonb('clarifications').$type<{ question: string; answer: string; at: string }[]>().notNull().default([]),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('interview_turns_session_seq_uq').on(t.sessionId, t.seq),
    uniqueIndex('interview_turns_submission_uq').on(t.sessionId, t.clientSubmissionId),
    check('interview_turns_answer_len', sql`answer is null or char_length(answer) <= 4000`),
    ownerPolicy('interview_turns'),
  ],
).enableRLS();

/** Final LARGE-tier scoring. One row per session and scoring version, so retries cannot duplicate it. */
export const evaluations = pgTable(
  'evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    sessionId: uuid('session_id')
      .notNull()
      .references(() => interviewSessions.id, { onDelete: 'cascade' }),
    scoringVersion: text('scoring_version').notNull(),
    criteria: jsonb('criteria').notNull(),
    scores: jsonb('scores').notNull(),
    overallScore: integer('overall_score').notNull(),
    promptVersion: text('prompt_version').notNull(),
    rubricVersion: text('rubric_version').notNull(),
    model: text('model').notNull(),
    tier: text('tier', { enum: ['SMALL', 'LARGE'] }).notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('evaluations_session_version_uq').on(t.sessionId, t.scoringVersion),
    /** Every RLS policy and dashboard query filters by user_id; without this each is a sequential scan. */
    index('evaluations_user_idx').on(t.userId),
    check('evaluations_score_range', sql`overall_score between 0 and 100`),
    ownerPolicy('evaluations'),
  ],
).enableRLS();

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => evaluations.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => interviewSessions.id, { onDelete: 'cascade' }),
    content: jsonb('content').notNull(),
    objectKey: text('object_key'),
    pdfStatus: text('pdf_status', { enum: ['disabled', 'pending', 'ready', 'failed'] }).notNull(),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('reports_evaluation_uq').on(t.evaluationId),
    index('reports_session_idx').on(t.sessionId),
    ownerPolicy('reports'),
  ],
).enableRLS();

/** Content rows (L14 option C): versioned, written only by the content seeder. */
export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  category: text('category').notNull(),
  definition: jsonb('definition').notNull(),
  contentVersion: text('content_version').notNull(),
  updatedAt: updated(),
});

export const rubrics = pgTable(
  'rubrics',
  {
    id: text('id').notNull(),
    version: text('version').notNull(),
    definition: jsonb('definition').notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.id, t.version] })],
);

export const skillEvidence = pgTable(
  'skill_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id),
    source: text('source', { enum: ['interview', 'lab', 'reasoning'] }).notNull(),
    sourceId: uuid('source_id').notNull(),
    score: integer('score').notNull(),
    weight: numeric('weight', { precision: 4, scale: 2 }).notNull().default('1'),
    scoringVersion: text('scoring_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    rubricVersion: text('rubric_version').notNull(),
    model: text('model').notNull(),
    tier: text('tier').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('skill_evidence_source_uq').on(t.source, t.sourceId, t.skillId, t.scoringVersion),
    index('skill_evidence_user_idx').on(t.userId, t.skillId),
    check('skill_evidence_score_range', sql`score between 0 and 100`),
    ownerPolicy('skill_evidence'),
  ],
).enableRLS();

export const skillScores = pgTable(
  'skill_scores',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    evidenceCount: integer('evidence_count').notNull(),
    lastEvidenceAt: timestamp('last_evidence_at', { withTimezone: true }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.skillId] }), ownerPolicy('skill_scores')],
).enableRLS();

/**
 * Every LLM call (L28): reserved before the call, settled after. Holds token counts and cost, never text.
 * Also the PostgreSQL ledger for the tier-3 AI budget (L12).
 */
export const llmCallLog = pgTable(
  'llm_call_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ...tenant,
    feature: text('feature').notNull(),
    sourceId: uuid('source_id'),
    tier: text('tier', { enum: ['SMALL', 'LARGE'] }).notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    status: text('status', { enum: ['reserved', 'settled', 'failed'] }).notNull(),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 }).notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    latencyMs: integer('latency_ms'),
    errorKind: text('error_kind'),
    requestId: text('request_id'),
    createdAt: created(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    index('llm_call_log_user_day_idx').on(t.userId, t.createdAt),
    index('llm_call_log_source_idx').on(t.sourceId),
    index('llm_call_log_created_idx').on(t.createdAt),
    ownerPolicy('llm_call_log'),
  ],
).enableRLS();
