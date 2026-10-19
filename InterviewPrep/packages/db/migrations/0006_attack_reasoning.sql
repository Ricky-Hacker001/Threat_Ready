CREATE TABLE "reasoning_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"domain" text NOT NULL,
	"state" text NOT NULL,
	"item_id" uuid,
	"selected_option" text,
	"justification" text,
	"client_submission_id" uuid,
	"submitted_at" timestamp with time zone,
	"generation_tries" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"failure_stage" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reasoning_attempts_justification_len" CHECK (justification is null or char_length(justification) <= 4000)
);
--> statement-breakpoint
ALTER TABLE "reasoning_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reasoning_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"scoring_version" text NOT NULL,
	"total_score" integer NOT NULL,
	"correct" boolean NOT NULL,
	"dimensions" jsonb NOT NULL,
	"feedback" jsonb NOT NULL,
	"stages" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"review_flag" boolean DEFAULT false NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"prompt_version" text NOT NULL,
	"rubric_version" text NOT NULL,
	"model" text NOT NULL,
	"tier" text NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reasoning_evaluations_score_range" CHECK (total_score between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "reasoning_evaluations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reasoning_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"domain" text NOT NULL,
	"difficulty" text NOT NULL,
	"fingerprint" text NOT NULL,
	"seed" jsonb NOT NULL,
	"public" jsonb NOT NULL,
	"private" jsonb NOT NULL,
	"weights" jsonb NOT NULL,
	"generator_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"tier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reasoning_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reasoning_attempts" ADD CONSTRAINT "reasoning_attempts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_attempts" ADD CONSTRAINT "reasoning_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_attempts" ADD CONSTRAINT "reasoning_attempts_item_id_reasoning_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."reasoning_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_evaluations" ADD CONSTRAINT "reasoning_evaluations_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_evaluations" ADD CONSTRAINT "reasoning_evaluations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_evaluations" ADD CONSTRAINT "reasoning_evaluations_attempt_id_reasoning_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."reasoning_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_items" ADD CONSTRAINT "reasoning_items_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_items" ADD CONSTRAINT "reasoning_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reasoning_attempts_user_idx" ON "reasoning_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reasoning_attempts_state_idx" ON "reasoning_attempts" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reasoning_attempts_submission_uq" ON "reasoning_attempts" USING btree ("id","client_submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reasoning_evaluations_attempt_uq" ON "reasoning_evaluations" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "reasoning_evaluations_user_idx" ON "reasoning_evaluations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reasoning_items_user_domain_idx" ON "reasoning_items" USING btree ("user_id","domain","created_at");--> statement-breakpoint
CREATE POLICY "reasoning_attempts_owner_isolation" ON "reasoning_attempts" AS PERMISSIVE FOR ALL TO "tr_app_user" USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "reasoning_evaluations_owner_isolation" ON "reasoning_evaluations" AS PERMISSIVE FOR ALL TO "tr_app_user" USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "reasoning_items_owner_isolation" ON "reasoning_items" AS PERMISSIVE FOR ALL TO "tr_app_user" USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint
-- Attack Reasoning (ADD L17b): the API role reaches these tables only through the owner-isolation
-- policies above. The private half of an item (answer key, rubric) is read by the worker and by the
-- API inside the owner's transaction; it is never serialised to the browser (enforced in code).
GRANT SELECT, INSERT, UPDATE, DELETE ON reasoning_items, reasoning_attempts, reasoning_evaluations TO tr_app_user;
