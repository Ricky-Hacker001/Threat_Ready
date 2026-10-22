-- Platform activity for the admin console: seconds of active use per user, day, app and area,
-- and where users use the platform from (country from an offline IP lookup, never the IP itself,
-- plus the browser's time zone). Written by POST /api/activity/ping for the caller's own rows.
CREATE TABLE IF NOT EXISTS "activity_days" (
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"day" date NOT NULL,
	"app" text NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_days_pk" PRIMARY KEY ("user_id", "day", "app", "area"),
	CONSTRAINT "activity_days_app_check" CHECK ("app" IN ('home', 'interview', 'labs', 'reasoning')),
	CONSTRAINT "activity_days_seconds_check" CHECK ("seconds" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_days_day_idx" ON "activity_days" ("day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_locations" (
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"day" date NOT NULL,
	"country" text NOT NULL,
	"time_zone" text DEFAULT '' NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_locations_pk" PRIMARY KEY ("user_id", "day", "country", "time_zone"),
	CONSTRAINT "user_locations_country_check" CHECK ("country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_locations_day_idx" ON "user_locations" ("day");
--> statement-breakpoint
-- The API's least-privilege role reads and writes these; it never deletes (the user cascade does).
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'threatready_app') THEN
		GRANT SELECT, INSERT, UPDATE ON "activity_days", "user_locations" TO threatready_app;
	END IF;
END $$;
