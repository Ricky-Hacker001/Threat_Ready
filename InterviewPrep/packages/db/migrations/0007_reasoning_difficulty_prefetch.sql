ALTER TABLE "reasoning_attempts" ADD COLUMN "difficulty" text DEFAULT 'intermediate' NOT NULL;--> statement-breakpoint
ALTER TABLE "reasoning_attempts" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "reasoning_attempts_prefetch_idx" ON "reasoning_attempts" USING btree ("user_id","domain","difficulty","opened_at");--> statement-breakpoint
-- Attempts that exist already were all opened by the learner (pre-generation did not exist yet).
UPDATE "reasoning_attempts" SET "opened_at" = "created_at" WHERE "opened_at" IS NULL;
