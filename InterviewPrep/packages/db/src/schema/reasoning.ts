import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organisations, users } from './auth.js';
import { ownerPolicy } from './rls.js';

/**
 * Attack Reasoning (ADD L17b, LLD-20). One attempt is one AI-generated, architecture-based
 * question answered with a selected option and a written justification, evaluated server-side.
 * Items keep a public half (what the browser may see) and a private half (answer key, rubric,
 * option analysis, reference answer) that never leaves the API.
 */
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

export const REASONING_ATTEMPT_STATES = ['generating', 'ready', 'evaluating', 'evaluated', 'generation_failed', 'evaluation_failed', 'abandoned'] as const;

export const reasoningItems = pgTable(
  'reasoning_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    domain: text('domain').notNull(),
    difficulty: text('difficulty').notNull(),
    /** Canonical variation key (domain|topology|entry|objective|technique): equal keys are the same question shape. */
    fingerprint: text('fingerprint').notNull(),
    /** The variation seed the generator was given, for audit and for steering later generations away. */
    seed: jsonb('seed').notNull(),
    /** Scenario, narrative, diagram, question and options: everything the browser may see. */
    public: jsonb('public').notNull(),
    /** Correct option, rubric, must-not-credit list, option analysis, reference answer: server only. */
    private: jsonb('private').notNull(),
    weights: jsonb('weights').$type<Record<string, number>>().notNull(),
    generatorVersion: text('generator_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    tier: text('tier', { enum: ['SMALL', 'LARGE'] }).notNull(),
    createdAt: created(),
  },
  (t) => [index('reasoning_items_user_domain_idx').on(t.userId, t.domain, t.createdAt), ownerPolicy('reasoning_items')],
).enableRLS();

export const reasoningAttempts = pgTable(
  'reasoning_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    domain: text('domain').notNull(),
    difficulty: text('difficulty').notNull().default('intermediate'),
    state: text('state', { enum: REASONING_ATTEMPT_STATES }).notNull(),
    /** Null while the attempt is pre-generated in the background; set when the learner opens it. */
    openedAt: timestamp('opened_at', { withTimezone: true }),
    itemId: uuid('item_id').references(() => reasoningItems.id, { onDelete: 'set null' }),
    selectedOption: text('selected_option'),
    justification: text('justification'),
    clientSubmissionId: uuid('client_submission_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** Generation runs so far (validation or similarity rejections regenerate; the limit is configured). */
    generationTries: integer('generation_tries').notNull().default(0),
    failureCode: text('failure_code'),
    failureStage: text('failure_stage'),
    /** Optimistic concurrency for state transitions. */
    version: integer('version').notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('reasoning_attempts_user_idx').on(t.userId, t.createdAt),
    index('reasoning_attempts_state_idx').on(t.state, t.updatedAt),
    index('reasoning_attempts_prefetch_idx').on(t.userId, t.domain, t.difficulty, t.openedAt),
    /** At most one scenario waits un-opened per learner, domain and difficulty (the backstop for prefetch idempotency). */
    uniqueIndex('reasoning_attempts_one_waiting_uq').on(t.userId, t.domain, t.difficulty).where(sql`opened_at is null and state in ('generating', 'ready')`),
    uniqueIndex('reasoning_attempts_submission_uq').on(t.id, t.clientSubmissionId),
    check('reasoning_attempts_justification_len', sql`justification is null or char_length(justification) <= 4000`),
    ownerPolicy('reasoning_attempts'),
  ],
).enableRLS();

/** One evaluation per attempt. Stage outputs are kept for audit; the score is computed in code. */
export const reasoningEvaluations = pgTable(
  'reasoning_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenant,
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => reasoningAttempts.id, { onDelete: 'cascade' }),
    scoringVersion: text('scoring_version').notNull(),
    totalScore: integer('total_score').notNull(),
    correct: boolean('correct').notNull(),
    dimensions: jsonb('dimensions').notNull(),
    feedback: jsonb('feedback').notNull(),
    /** Raw evaluator, challenger and reconciler outputs (validated), for audit and disputes. */
    stages: jsonb('stages').notNull(),
    confidence: text('confidence', { enum: ['high', 'medium', 'low'] }).notNull(),
    reviewFlag: boolean('review_flag').notNull().default(false),
    degraded: boolean('degraded').notNull().default(false),
    promptVersion: text('prompt_version').notNull(),
    rubricVersion: text('rubric_version').notNull(),
    model: text('model').notNull(),
    tier: text('tier', { enum: ['SMALL', 'LARGE'] }).notNull(),
    latencyMs: integer('latency_ms'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('reasoning_evaluations_attempt_uq').on(t.attemptId),
    index('reasoning_evaluations_user_idx').on(t.userId, t.createdAt),
    check('reasoning_evaluations_score_range', sql`total_score between 0 and 100`),
    ownerPolicy('reasoning_evaluations'),
  ],
).enableRLS();
