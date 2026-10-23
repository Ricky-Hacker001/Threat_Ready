-- Billed failures count toward every budget (audit 2026-10-15 §3.5). A call that failed after the
-- provider billed it (truncated at max_tokens, schema-invalid output, refusal after tokens) is
-- recorded by the API with status 'failed' AND its real cost_usd. The daily breaker sums:
--   settled calls (cost_usd), reservations in flight (estimated_cost_usd), and failed calls that
--   carry a cost. Only a failure with no usage (cost_usd null) is free. Same rule as LlmService.sum().
CREATE OR REPLACE FUNCTION ai_spend_today_usd() RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(COALESCE(cost_usd, estimated_cost_usd)), 0)
  FROM llm_call_log
  WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND (status <> 'failed' OR cost_usd IS NOT NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ai_spend_today_usd() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ai_spend_today_usd() TO tr_app_user;
