-- Time spent is credited once per user, not once per (app, area) row: the activity ping locks this
-- row, so pings from several tabs or areas at the same moment add the elapsed time only once.
-- Rows go with the user (ON DELETE CASCADE); the API never deletes them itself.
CREATE TABLE IF NOT EXISTS "activity_last_ping" (
	"user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"last_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'threatready_app') THEN
		GRANT SELECT, INSERT, UPDATE ON "activity_last_ping" TO threatready_app;
		REVOKE DELETE ON "activity_last_ping" FROM threatready_app;
	END IF;
END $$;
