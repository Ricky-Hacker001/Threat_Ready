import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgPolicy, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organisations, users } from './auth.js';
import { appUserRole, ownerPolicy } from './rls.js';

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

/**
 * Questions. Pool items (`pool = true`) are generated ahead of time, belong to no learner
 * (user_id and org_id null) and are served to many learners in random order; `reasoning_served`
 * records who has seen which, so no learner sees a question twice. Older items are per-learner.
 */
export const reasoningItems = pgTable(
  'reasoning_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organisations.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    pool: boolean('pool').notNull().default(false),
    domain: text('domain').notNull(),
    difficulty: text('difficulty').notNull(),
    /** Canonical variation key (domain|topology|entry|objective|technique): equal keys are the same question shape. */
    fingerprint: text('fingerprint').notNull(),
    /** The variation seed the generator was given, for audit and for steering later generations away. */
    seed: jsonb('seed').notNull(),
    /** Scenario, narrative, diagram, question and options: everything the browser may see. */
    public: jsonb('public').notNull(),
    /**
     * Correct option, rubric, must-not-credit list, option analysis, reference answer: server only.
     * Since migration 0016 the API role has no SELECT privilege on this column; it is read only
     * through the worker/owner role (Database.system) by the evaluator and the result builder.
     */
    private: jsonb('private').notNull(),
    weights: jsonb('weights').$type<Record<string, number>>().notNull(),
    /**
     * Learners this question has been served to (kept by a trigger on reasoning_served). A pool
     * question past REASONING_ITEM_MAX_SERVES is retired from serving, bounding how far one answer
     * key can travel; the refill job generates a replacement.
     */
    serveCount: integer('serve_count').notNull().default(0),
    generatorVersion: text('generator_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    tier: text('tier', { enum: ['SMALL', 'LARGE'] }).notNull(),
    createdAt: created(),
  },
  (t) => [
    index('reasoning_items_user_domain_idx').on(t.userId, t.domain, t.createdAt),
    index('reasoning_items_pool_idx').on(t.pool, t.domain, t.difficulty, t.createdAt),
    index('reasoning_items_pool_serve_idx').on(t.pool, t.domain, t.difficulty, t.serveCount),
    check('reasoning_items_owner_or_pool', sql`pool or user_id is not null`),
    ownerPolicy('reasoning_items'),
    // Pool questions are readable by any learner's transaction; the private half is still never serialised.
    pgPolicy('reasoning_items_pool_read', { as: 'permissive', for: 'select', to: appUserRole, using: sql`pool` }),
  ],
).enableRLS();

/** Which pool question each learner has been served: the basis for never repeating a question. */
export const reasoningServed = pgTable(
  'reasoning_served',
  {
    ...tenant,
    itemId: uuid('item_id')
      .notNull()
      .references(() => reasoningItems.id, { onDelete: 'cascade' }),
    attemptId: uuid('attempt_id'),
    servedAt: timestamp('served_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemId] }), index('reasoning_served_item_idx').on(t.itemId), ownerPolicy('reasoning_served')],
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
    /**
     * The first time a submission was refused by the daily evaluation quota or an AI budget (the
     * learner's daily cap or the platform breaker), while the question was still open. The refusal is
     * the platform's, so the question then stays open until REASONING_READY_TTL_HOURS after the next
     * 00:00 UTC instead of expiring into a counted 0 (audit final review BIZ-07). Set once: the
     * extension cannot be renewed.
     */
    submitRefusedAt: timestamp('submit_refused_at', { withTimezone: true }),
    /** Generation runs so far (validation or similarity rejections regenerate; the limit is configured). */
    generationTries: integer('generation_tries').notNull().default(0),
    /** Manual retries of a failed generation and of a failed evaluation (each capped by REASONING_MAX_RETRIES). */
    generationRetries: integer('generation_retries').notNull().default(0),
    evaluationRetries: integer('evaluation_retries').notNull().default(0),
    /**
     * Whether skipping this question once shown (or leaving it to expire) counts as answered with 0
     * (audit BIZ-09). Attempts opened before that rule are false: their learners were told a skip does
     * not count. Migration 0014 adds the column as false for existing rows; new rows default to true.
     */
    skipCounts: boolean('skip_counts').notNull().default(true),
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
