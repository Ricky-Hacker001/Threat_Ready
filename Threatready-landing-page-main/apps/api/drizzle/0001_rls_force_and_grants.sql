-- RLS applies even to the table owner, so a migration or script that forgets
-- to set app.user_id cannot silently read every row.
ALTER TABLE "feature_launches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Belt and braces for environments where default privileges were not set
-- before the first migration ran (e.g. an RDS bootstrap done in a different order).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO threatready_app;
--> statement-breakpoint
-- Append-only from the API: no UPDATE/DELETE policy exists, and no grant either.
REVOKE UPDATE, DELETE ON "feature_launches" FROM threatready_app;
