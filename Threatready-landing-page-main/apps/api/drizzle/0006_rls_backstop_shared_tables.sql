-- Request-scoped RLS backstop for users, memberships and organizations (generated from schema.ts).
-- The API role also serves Better Auth and the admin console, which read these tables across users
-- with no request user set, so the policies pass everything when app.user_id is unset or '' and
-- restrict to the caller's own row / memberships / organisations once withUserTx has set it.
-- Policies apply to threatready_app only; the owner (migrations, admin:grant) is not subject to RLS.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memberships_own_or_no_context" ON "memberships" AS PERMISSIVE FOR ALL TO "threatready_app" USING (coalesce(current_setting('app.user_id', true), '') = '' OR user_id = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR user_id = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "organizations_member_or_no_context" ON "organizations" AS PERMISSIVE FOR ALL TO "threatready_app" USING (coalesce(current_setting('app.user_id', true), '') = '' OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = organizations.id AND m.user_id = current_setting('app.user_id', true))) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = organizations.id AND m.user_id = current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "users_self_or_no_context" ON "users" AS PERMISSIVE FOR ALL TO "threatready_app" USING (coalesce(current_setting('app.user_id', true), '') = '' OR id = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR id = current_setting('app.user_id', true));