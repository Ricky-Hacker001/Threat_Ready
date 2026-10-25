-- InterviewPrep, audit 2026-10-23. Safe on live data: a jsonb column with a constant default is a
-- metadata-only change on PostgreSQL 11+ (no rewrite), and both indexes are on small per-user tables.
-- tr_app_user's table-level SELECT/UPDATE on interview_sessions (0002) covers the new column.
--
-- Pause and tab-switch counters for the report (TR-24). Kept apart from `progress` and updated with
-- atomic increments, so a tab-switch report from the browser never races a turn's state transition.
ALTER TABLE "interview_sessions" ADD COLUMN IF NOT EXISTS "integrity" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- The file-retention and abandoned-upload sweeps read documents by status and age (TR-25, TR-35).
CREATE INDEX IF NOT EXISTS "resumes_status_updated_idx" ON "resumes" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_descriptions_status_updated_idx" ON "job_descriptions" USING btree ("status","updated_at");
