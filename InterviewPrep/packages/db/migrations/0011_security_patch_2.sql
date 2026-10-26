-- Security patch 2 (2026-10-23): A2 evaluating lease, A3 evaluations(user_id) index, A5 answer-key column privilege and serve cap.

-- A2. A session left in 'evaluating' when the API process died between storing the answer and asking
-- the next question used to wait 24 hours for the inactivity sweep. The lease marks when the
-- evaluation is presumed lost; the 5-minute sweeper moves such sessions on.
ALTER TABLE "interview_sessions" ADD COLUMN IF NOT EXISTS "evaluating_lease_until" timestamp with time zone;
--> statement-breakpoint
-- Sessions already stuck before this migration: give them a lease that has expired, so the first sweep recovers them.
UPDATE "interview_sessions" SET "evaluating_lease_until" = now() WHERE "state" = 'evaluating' AND "evaluating_lease_until" IS NULL;
--> statement-breakpoint

-- A3. Every RLS policy and dashboard query on evaluations filters by user_id.
-- (drizzle runs migrations in one transaction, so CONCURRENTLY is not available here; the table is small.)
CREATE INDEX IF NOT EXISTS "evaluations_user_idx" ON "evaluations" USING btree ("user_id");
--> statement-breakpoint

-- A5. The answer key, rubric, option analysis and reference answer live in reasoning_items.private.
-- Pool questions are readable by every learner's transaction (policy reasoning_items_pool_read), so a
-- single missed projection anywhere in the API would hand a learner the answer key. The API role now
-- has no SELECT privilege on the column at all; it is read only through the owner role (worker path).
ALTER TABLE "reasoning_items" ADD COLUMN IF NOT EXISTS "serve_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
REVOKE SELECT ON "reasoning_items" FROM tr_app_user;
--> statement-breakpoint
GRANT SELECT ("id", "org_id", "user_id", "pool", "domain", "difficulty", "fingerprint", "seed", "public", "weights", "generator_version", "prompt_version", "model", "tier", "created_at", "serve_count") ON "reasoning_items" TO tr_app_user;
--> statement-breakpoint
-- The API never writes reasoning_items (generation runs in the worker); drop the privileges it does not use.
REVOKE INSERT, UPDATE, DELETE ON "reasoning_items" FROM tr_app_user;
--> statement-breakpoint

-- serve_count follows reasoning_served: one increment per learner a question is served to, whichever
-- code path records the serve. SECURITY DEFINER so the API role's insert (under RLS) can bump a pool
-- row it has no UPDATE privilege on.
CREATE OR REPLACE FUNCTION reasoning_items_bump_serve_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE reasoning_items SET serve_count = serve_count + 1 WHERE id = NEW.item_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reasoning_items_bump_serve_count() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS reasoning_served_bump_serve_count ON "reasoning_served";
--> statement-breakpoint
CREATE TRIGGER reasoning_served_bump_serve_count AFTER INSERT ON "reasoning_served" FOR EACH ROW EXECUTE FUNCTION reasoning_items_bump_serve_count();
--> statement-breakpoint
-- Backfill from the serves already recorded.
UPDATE "reasoning_items" i SET "serve_count" = s.n FROM (SELECT item_id, count(*)::int AS n FROM "reasoning_served" GROUP BY item_id) s WHERE s.item_id = i.id;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_items_pool_serve_idx" ON "reasoning_items" USING btree ("pool", "domain", "difficulty", "serve_count");
