-- Attack Reasoning cost reduction (2026-10-26, docs/ATTACK_REASONING_COST_DESIGN.md §4): questions are written on
-- a fixed library of 15 reviewed architectures, and each question goes to at most REASONING_ITEM_MAX_SERVES (2)
-- learners. Every statement is idempotent; drizzle runs the file in one transaction.

-- Library questions record the architecture they were written on (null for items generated before 0017).
ALTER TABLE "reasoning_items" ADD COLUMN IF NOT EXISTS "architecture_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_items_architecture_idx" ON "reasoning_items" USING btree ("architecture_id","created_at");
--> statement-breakpoint
-- Patch 2 (0016) replaced the table-level SELECT with a column list: a new public column needs its own grant,
-- or every ITEM_COLUMNS read in a learner's transaction fails with a privilege error. The answer key column
-- ("private") stays ungranted.
GRANT SELECT ("architecture_id") ON "reasoning_items" TO tr_app_user;
--> statement-breakpoint
-- The serve cap is enforced where the serve is recorded, atomically: the row lock taken by the UPDATE
-- serialises concurrent serves of one question, and the WHERE is re-checked against the committed count.
-- A serve over the cap (or a repeat for the same learner) is skipped (the BEFORE trigger returns NULL), so
-- the caller's INSERT ... RETURNING comes back empty and it picks another question. The cap comes from the
-- transaction setting app.reasoning_item_max_serves (REASONING_ITEM_MAX_SERVES, set by the API); without it,
-- the serve is only counted, as before. The duplicate check runs first because a BEFORE trigger fires before
-- ON CONFLICT detection: without it a repeated insert would count a serve that never happened.
CREATE OR REPLACE FUNCTION reasoning_items_bump_serve_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cap integer := NULLIF(current_setting('app.reasoning_item_max_serves', true), '')::integer;
BEGIN
  IF EXISTS (SELECT 1 FROM reasoning_served WHERE user_id = NEW.user_id AND item_id = NEW.item_id) THEN
    RETURN NULL;
  END IF;
  UPDATE reasoning_items SET serve_count = serve_count + 1 WHERE id = NEW.item_id AND (cap IS NULL OR serve_count < cap);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reasoning_items_bump_serve_count() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS reasoning_served_bump_serve_count ON "reasoning_served";
--> statement-breakpoint
CREATE TRIGGER reasoning_served_bump_serve_count BEFORE INSERT ON "reasoning_served" FOR EACH ROW EXECUTE FUNCTION reasoning_items_bump_serve_count();
