-- Attack Reasoning: a submission refused by the daily evaluation quota or an AI budget (the learner's
-- daily cap or the platform breaker) leaves the question open, and the refusal is the platform's, so
-- the question must not expire into a counted 0 before the learner could submit again (audit final
-- review BIZ-07). The first such refusal is recorded here; the TTL sweep then keeps the question open
-- until REASONING_READY_TTL_HOURS after the next 00:00 UTC. Nullable with no default, so this changes
-- catalog metadata only (no table rewrite); tr_app_user's table-level UPDATE grant on
-- reasoning_attempts (0006) covers the new column.
ALTER TABLE "reasoning_attempts" ADD COLUMN "submit_refused_at" timestamp with time zone;
