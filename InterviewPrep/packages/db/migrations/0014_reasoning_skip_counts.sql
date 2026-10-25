-- Attack Reasoning: a shown question that is skipped (or left to expire) counts as answered with 0
-- (audit BIZ-09), but only for questions opened under that rule. Learners who skipped before it were
-- told a skip does not count, so every existing row gets false; rows inserted from now on get true
-- (the second statement changes the default only, existing rows keep false). Both statements change
-- catalog metadata only on PostgreSQL 11+ (no table rewrite); tr_app_user's table-level UPDATE grant
-- on reasoning_attempts (0006) covers the new column.
ALTER TABLE "reasoning_attempts" ADD COLUMN "skip_counts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reasoning_attempts" ALTER COLUMN "skip_counts" SET DEFAULT true;
