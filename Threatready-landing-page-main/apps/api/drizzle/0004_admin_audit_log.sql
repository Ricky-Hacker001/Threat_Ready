-- Who changed whose platform role, when, from where. Written by the admin console's role endpoint
-- in the same transaction as the change. Append-only: the API role may insert and read, never
-- update or delete; user rows are kept as text copies so the record survives account deletion.
CREATE TABLE IF NOT EXISTS "admin_audit_log" (
	"id" bigserial PRIMARY KEY,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"actor_id" text REFERENCES "users"("id") ON DELETE SET NULL,
	"actor_email" text,
	"target_id" text REFERENCES "users"("id") ON DELETE SET NULL,
	"target_email" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	CONSTRAINT "admin_audit_log_action_check" CHECK ("action" IN ('role.promote', 'role.demote'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_at_idx" ON "admin_audit_log" ("at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_target_idx" ON "admin_audit_log" ("target_id");
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'threatready_app') THEN
		GRANT SELECT, INSERT ON "admin_audit_log" TO threatready_app;
		GRANT USAGE, SELECT ON SEQUENCE "admin_audit_log_id_seq" TO threatready_app;
	END IF;
END $$;
