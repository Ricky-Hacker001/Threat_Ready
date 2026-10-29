-- Security audit 2026-10-29, I1: privileges the API role (tr_app_user) holds but never uses. Every
-- statement is idempotent (REVOKE of an absent privilege is a no-op; the function is CREATE OR REPLACE).

-- users: mirrored by the identity adapter, read by the report mailer and rewritten by account erasure,
-- all as the owner role (Database.system / the pool handle). No query under SET LOCAL ROLE tr_app_user
-- touches it, and the table has no RLS, so the grant from 0002 let any learner's transaction read every
-- account's name and email. Foreign keys into users are checked with the table owner's privileges.
REVOKE SELECT ON "users" FROM tr_app_user;
--> statement-breakpoint

-- platform_llm_usage(): every user's spend, read only by the onboard-facing internal route as the owner
-- role (PlatformService.aiUsage). ai_spend_today_usd() stays: the breaker runs in the learner's transaction.
REVOKE EXECUTE ON FUNCTION platform_llm_usage(timestamptz, timestamptz, text) FROM tr_app_user;
--> statement-breakpoint

-- reasoning_items.seed and .fingerprint describe how a question was built (architecture, attack path,
-- objective, technique): with the public column that is enough to reconstruct the answer for a pool
-- question any learner's transaction can read. The API never returns them (ITEM_COLUMNS leaves them
-- out); the one read in a learner's transaction, the serve path's "same shape as one already served"
-- check, moves into reasoning_item_shape_served() below.
REVOKE SELECT ("seed", "fingerprint") ON "reasoning_items" FROM tr_app_user;
--> statement-breakpoint

-- Whether a pool question has the shape of one the current learner (app.user_id) was already served:
-- the same variation fingerprint, or the same architecture, attack path and objective (ReasoningService
-- .servable, review AR-BIZ-2). SECURITY DEFINER so it can compare the two columns the API role cannot
-- read; it only ever answers for the transaction's own learner and returns one boolean, never a value
-- of either column. With no learner in the transaction it answers true (nothing is servable).
CREATE OR REPLACE FUNCTION reasoning_item_shape_served(p_item_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN true
    ELSE EXISTS (
      SELECT 1
      FROM reasoning_items i
      JOIN reasoning_served s ON s.user_id = current_setting('app.user_id', true)
      JOIN reasoning_items j ON j.id = s.item_id
      WHERE i.id = p_item_id
        AND (j.fingerprint = i.fingerprint
             OR (j.architecture_id IS NOT NULL
                 AND j.architecture_id = i.architecture_id
                 AND j.seed->'architecture'->>'pathKey' = i.seed->'architecture'->>'pathKey'
                 AND j.seed->>'objective' = i.seed->>'objective'))
    )
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reasoning_item_shape_served(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reasoning_item_shape_served(uuid) TO tr_app_user;
