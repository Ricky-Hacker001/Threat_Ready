-- Privileges for the RLS role. Auth and content tables are readable by the API role; owned
-- tables are reachable only through the owner-isolation policies created in 0001.
GRANT USAGE ON SCHEMA public TO tr_app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  resumes, job_descriptions, candidate_profiles, job_profiles,
  interview_sessions, interview_turns, evaluations, reports,
  skill_evidence, skill_scores, llm_call_log
TO tr_app_user;
--> statement-breakpoint
GRANT SELECT ON skills, rubrics, organisations, memberships, users TO tr_app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE llm_call_log_id_seq TO tr_app_user;
--> statement-breakpoint
-- The global daily AI-spend breaker needs a total across all users without exposing rows.
CREATE OR REPLACE FUNCTION ai_spend_today_usd() RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(COALESCE(cost_usd, estimated_cost_usd)), 0)
  FROM llm_call_log
  WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND status <> 'failed'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ai_spend_today_usd() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ai_spend_today_usd() TO tr_app_user;
