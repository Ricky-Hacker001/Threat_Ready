ALTER TABLE "interview_sessions" ADD COLUMN "ai_consent_version" text;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD COLUMN "ai_consent_at" timestamp with time zone;