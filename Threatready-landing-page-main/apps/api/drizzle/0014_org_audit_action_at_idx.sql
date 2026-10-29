-- Invitation emails are capped per organisation, across the platform and per address (ORG_INVITES_*):
-- the platform-wide counts read the last day's invite.send/invite.resend rows of every organisation.
CREATE INDEX IF NOT EXISTS "org_audit_log_action_at_idx" ON "org_audit_log" USING btree ("action","at");
