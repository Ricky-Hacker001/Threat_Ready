-- Business accounts (organisations), 28 Oct 2026: an organisation owns seats, a plan and the people it
-- invites (design: claude/threatready-business-accounts-plan.md, phase 1). Generated from schema.ts, then
-- made idempotent and given its grants by hand.
--
-- Enum values: PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction but forbids using the
-- new value in the same transaction, and drizzle runs every pending migration in one. Nothing below
-- uses the new values as enum literals (the partial index compares role::text); the API does, next
-- request. Existing rows are untouched: every personal workspace keeps kind 'personal', role learner/
-- trial, plan free/trial, and the new columns take their defaults (status active, seats 1).
--
-- org_audit_log is append-only for the API role (like admin_audit_log). org_invitations and
-- org_audit_log carry no RLS: every query names the organisation, which comes from the caller's
-- verified membership, never from the request (see org.service.ts).
ALTER TYPE "public"."member_role" ADD VALUE IF NOT EXISTS 'manager';--> statement-breakpoint
ALTER TYPE "public"."member_role" ADD VALUE IF NOT EXISTS 'member';--> statement-breakpoint
ALTER TYPE "public"."org_kind" ADD VALUE IF NOT EXISTS 'business';--> statement-breakpoint
ALTER TYPE "public"."plan_kind" ADD VALUE IF NOT EXISTS 'business_trial';--> statement-breakpoint
ALTER TYPE "public"."plan_kind" ADD VALUE IF NOT EXISTS 'business';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"target_id" text,
	"target_email" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "org_invitations_role_check" CHECK ("role" IN ('member', 'manager'))
);
--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN IF NOT EXISTS "seats" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN IF NOT EXISTS "period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN IF NOT EXISTS "ai_cap_usd" integer;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "invited_by" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "segment" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "created_by" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_audit_log" DROP CONSTRAINT IF EXISTS "org_audit_log_org_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "org_audit_log" ADD CONSTRAINT "org_audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_audit_log" DROP CONSTRAINT IF EXISTS "org_audit_log_actor_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "org_audit_log" ADD CONSTRAINT "org_audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_audit_log" DROP CONSTRAINT IF EXISTS "org_audit_log_target_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "org_audit_log" ADD CONSTRAINT "org_audit_log_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" DROP CONSTRAINT IF EXISTS "org_invitations_org_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" DROP CONSTRAINT IF EXISTS "org_invitations_invited_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" DROP CONSTRAINT IF EXISTS "org_invitations_accepted_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_audit_log_org_at_idx" ON "org_audit_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invitations_org_idx" ON "org_invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invitations_email_idx" ON "org_invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_invitations_open_uidx" ON "org_invitations" USING btree ("org_id","email") WHERE "org_invitations"."accepted_at" IS NULL AND "org_invitations"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "memberships_invited_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_created_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_org_id_idx" ON "memberships" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_org_member_user_uidx" ON "memberships" USING btree ("user_id") WHERE "memberships"."role" not in ('learner', 'trial', 'student', 'instructor');--> statement-breakpoint
ALTER TABLE "entitlements" DROP CONSTRAINT IF EXISTS "entitlements_seats_check";--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_seats_check" CHECK ("seats" >= 0);--> statement-breakpoint
ALTER TABLE "entitlements" DROP CONSTRAINT IF EXISTS "entitlements_status_check";--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_status_check" CHECK ("status" IN ('trialing', 'active', 'past_due', 'suspended', 'cancelled'));--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "memberships_status_check";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_status_check" CHECK ("status" IN ('active', 'suspended'));--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_status_check";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_status_check" CHECK ("status" IN ('pending', 'active', 'suspended'));--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_segment_check";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_segment_check" CHECK ("segment" IS NULL OR "segment" IN ('business', 'institute'));
--> statement-breakpoint
-- The launcher's default privileges give the API role full DML on new tables; the audit log is append-only.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'threatready_app') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON "org_invitations" TO threatready_app;
		GRANT SELECT, INSERT ON "org_audit_log" TO threatready_app;
		REVOKE UPDATE, DELETE ON "org_audit_log" FROM threatready_app;
		GRANT USAGE, SELECT ON SEQUENCE "org_audit_log_id_seq" TO threatready_app;
	END IF;
END $$;
--> statement-breakpoint
-- The platform admin console also records reads of an organisation's detail page.
ALTER TABLE "admin_audit_log" DROP CONSTRAINT IF EXISTS "admin_audit_log_action_check";
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_action_check" CHECK ("action" IN ('role.promote', 'role.demote', 'users.export', 'user.view', 'org.view'));
--> statement-breakpoint
-- The organisation console and the admin console count launches per organisation and member with no
-- request user set (the same backstop the shared tables got in 0011): the owner policies stay, and
-- with a request user set a query still sees only that user's rows.
DROP POLICY IF EXISTS "feature_launches_no_context_select" ON "feature_launches";
--> statement-breakpoint
CREATE POLICY "feature_launches_no_context_select" ON "feature_launches" AS PERMISSIVE FOR SELECT TO "threatready_app" USING (coalesce(current_setting('app.user_id', true), '') = '');
