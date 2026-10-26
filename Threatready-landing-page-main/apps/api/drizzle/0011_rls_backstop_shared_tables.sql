-- Request-scoped RLS backstop for users, memberships and organizations (generated from schema.ts).
-- The API role also serves Better Auth and the admin console, which read these tables across users
-- with no request user set, so the policies pass everything when app.user_id is unset or '' and
-- restrict to the caller's own row / memberships / organisations once withUserTx has set it.
-- Policies apply to threatready_app only; the owner (migrations, admin:grant) is not subject to RLS.
-- Every other path of the API runs with no request user and is unaffected: sign-in and its per-account
-- lockout, the per-address code caps, the activity ping, the personal-workspace set-up, the identity
-- lookup, the admin console (reads, CSV export, role changes) and the retention job (which deletes
-- users and member-less workspaces). Foreign-key checks and ON DELETE actions bypass RLS.
-- Idempotent: a policy left by an earlier attempt is replaced, and enabling RLS twice is a no-op.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "memberships_own_or_no_context" ON "memberships";--> statement-breakpoint
CREATE POLICY "memberships_own_or_no_context" ON "memberships" AS PERMISSIVE FOR ALL TO "threatready_app" USING (coalesce(current_setting('app.user_id', true), '') = '' OR user_id = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR user_id = current_setting('app.user_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "organizations_member_or_no_context" ON "organizations";--> statement-breakpoint
CREATE POLICY "organizations_member_or_no_context" ON "organizations" AS PERMISSIVE FOR ALL TO "threatready_app" USING (coalesce(current_setting('app.user_id', true), '') = '' OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = organizations.id AND m.user_id = current_setting('app.user_id', true))) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = organizations.id AND m.user_id = current_setting('app.user_id', true)));--> statement-breakpoint
DROP POLICY IF EXISTS "users_self_or_no_context" ON "users";--> statement-breakpoint
CREATE POLICY "users_self_or_no_context" ON "users" AS PERMISSIVE FOR ALL TO "threatready_app" USING (coalesce(current_setting('app.user_id', true), '') = '' OR id = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR id = current_setting('app.user_id', true));
