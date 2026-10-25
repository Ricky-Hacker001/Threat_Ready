-- Per-account sign-in lockout (auth.ts). One row per submitted username, existing or not, keyed by a
-- hash of the normalised name: the lock gives nothing away about which accounts exist, and the table
-- never holds a username. Kept out of rate_limits, which Better Auth prunes after its longest window
-- (one hour) while a lock can last a day. The API resets a row on success and the retention job
-- removes old ones, so the app role keeps DELETE here.
CREATE TABLE IF NOT EXISTS "signin_failures" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_failure_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signin_failures_failures_check" CHECK ("failures" >= 0)
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'threatready_app') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON "signin_failures" TO threatready_app;
	END IF;
END $$;
