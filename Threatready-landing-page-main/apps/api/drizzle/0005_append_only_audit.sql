-- Append-only tables for the API's least-privilege role. The launcher's default privileges grant
-- SELECT, INSERT, UPDATE, DELETE on every new table, so the audit log and the activity records
-- must have the destructive rights taken back explicitly. Rows of users who are deleted still go
-- through ON DELETE (SET NULL / CASCADE): referential actions run with the table owner's rights.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'threatready_app') THEN
		REVOKE UPDATE, DELETE ON "admin_audit_log" FROM threatready_app;
		REVOKE DELETE ON "activity_days" FROM threatready_app;
		REVOKE DELETE ON "user_locations" FROM threatready_app;
	END IF;
END $$;
--> statement-breakpoint
-- The admin console also records reads of personal data: the CSV export and a user's detail page.
ALTER TABLE "admin_audit_log" DROP CONSTRAINT IF EXISTS "admin_audit_log_action_check";
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_action_check" CHECK ("action" IN ('role.promote', 'role.demote', 'users.export', 'user.view'));
