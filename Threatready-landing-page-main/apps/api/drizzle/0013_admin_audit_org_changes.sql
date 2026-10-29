-- A platform admin's changes to an organisation (plan, status, seats, period end, AI cap; approval,
-- suspension, reinstatement) are written to the platform's append-only admin trail as well as to the
-- organisation's own log (org_audit_log, which its admins read and which goes with the organisation).
-- 0012 allowed only the read (org.view) here. Idempotent; older code never writes the new actions.
ALTER TABLE "admin_audit_log" DROP CONSTRAINT IF EXISTS "admin_audit_log_action_check";--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_action_check" CHECK ("action" IN ('role.promote', 'role.demote', 'users.export', 'user.view', 'org.view', 'org.plan', 'org.status'));
