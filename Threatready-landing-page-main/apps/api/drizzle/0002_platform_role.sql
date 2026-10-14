-- Platform role for the admin console. Granted with `pnpm --filter @threatready/api admin:grant <email>`
-- or by listing the email in ADMIN_EMAILS; never settable through the auth API (input: false).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('user', 'admin'));
