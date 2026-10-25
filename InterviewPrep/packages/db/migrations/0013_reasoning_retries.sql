-- Attack Reasoning: per-attempt ceilings on manual retries of a failed generation and of a failed
-- evaluation (REASONING_MAX_RETRIES, audit TR-08). Adding an integer column with a constant default is
-- a metadata-only change on PostgreSQL 11+ (no table rewrite); tr_app_user's table-level UPDATE grant
-- on reasoning_attempts (0006) covers the new columns.
ALTER TABLE "reasoning_attempts" ADD COLUMN "generation_retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reasoning_attempts" ADD COLUMN "evaluation_retries" integer DEFAULT 0 NOT NULL;