-- Platform identity: users are mirrored from onboard.threatready.io (the identity provider) by id.
-- Email uniqueness is onboard's to enforce; a local constraint would reject a user whose address
-- was once held by a pre-platform local account.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_unique";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");
--> statement-breakpoint
-- Cross-user LLM usage for onboard's admin console (tokens and cost per user, model and feature).
-- Aggregates only: no text ever leaves llm_call_log, and the API role still cannot read its rows.
-- Cost: settled cost, or the reservation while a call is in flight; nothing for a call that failed
-- before any tokens were billed (the same rule as the daily budget).
CREATE OR REPLACE FUNCTION platform_llm_usage(p_from timestamptz, p_to timestamptz, p_user_id text DEFAULT NULL)
RETURNS TABLE (
  user_id text,
  model text,
  feature text,
  calls bigint,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  cost_usd numeric,
  last_call_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.user_id, l.model, l.feature,
         count(*) FILTER (WHERE l.status <> 'failed'),
         COALESCE(sum(l.input_tokens), 0)::bigint,
         COALESCE(sum(l.output_tokens), 0)::bigint,
         COALESCE(sum(l.cache_read_tokens), 0)::bigint,
         COALESCE(sum(l.cache_write_tokens), 0)::bigint,
         COALESCE(sum(COALESCE(l.cost_usd, CASE WHEN l.status = 'reserved' THEN l.estimated_cost_usd ELSE 0 END)), 0),
         max(l.created_at)
  FROM llm_call_log l
  WHERE l.created_at >= p_from AND l.created_at < p_to
    AND (p_user_id IS NULL OR l.user_id = p_user_id)
  GROUP BY l.user_id, l.model, l.feature
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_llm_usage(timestamptz, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_llm_usage(timestamptz, timestamptz, text) TO tr_app_user;
