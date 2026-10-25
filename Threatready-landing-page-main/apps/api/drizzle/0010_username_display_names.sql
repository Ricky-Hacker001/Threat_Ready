-- The username plugin's displayUsername was free text at sign-up, and 0009 copied it into the name of
-- username/password accounts. The display form is now the username itself, in any case (auth.ts
-- user.create.before; the forgot-username email also sends it). Bring stored values in line.
UPDATE "users"
SET "display_username" = "username"
WHERE "username" IS NOT NULL
	AND ("display_username" IS NULL OR lower("display_username") <> "username");
--> statement-breakpoint
UPDATE "users" u
SET "name" = u."display_username"
WHERE u."username" IS NOT NULL
	AND coalesce(u."is_anonymous", false) = false
	AND u."name" IS DISTINCT FROM u."display_username"
	AND EXISTS (SELECT 1 FROM "accounts" a WHERE a."user_id" = u."id" AND a."provider_id" = 'credential');
