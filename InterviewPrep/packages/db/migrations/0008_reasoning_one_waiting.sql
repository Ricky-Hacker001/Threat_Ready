-- Keep the newest waiting scenario per learner, domain and difficulty; older duplicates are skipped.
UPDATE "reasoning_attempts" a SET "state" = 'abandoned', "opened_at" = now()
WHERE a."opened_at" IS NULL AND a."state" IN ('generating', 'ready')
  AND EXISTS (SELECT 1 FROM "reasoning_attempts" b WHERE b."user_id" = a."user_id" AND b."domain" = a."domain" AND b."difficulty" = a."difficulty" AND b."opened_at" IS NULL AND b."state" IN ('generating', 'ready') AND b."created_at" > a."created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reasoning_attempts_one_waiting_uq" ON "reasoning_attempts" USING btree ("user_id","domain","difficulty") WHERE opened_at is null and state in ('generating', 'ready');