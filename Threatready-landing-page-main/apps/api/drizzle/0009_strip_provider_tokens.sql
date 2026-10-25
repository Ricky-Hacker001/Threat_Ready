-- Google/GitHub sign-in only needs the verified email and profile, so provider tokens are no longer
-- stored (auth.ts account hooks). Clear the ones written before, encrypted or not: id_tokens were
-- never encrypted, and older access tokens stayed plaintext until the user's next OAuth sign-in.
UPDATE "accounts"
SET "access_token" = NULL, "refresh_token" = NULL, "id_token" = NULL
WHERE "provider_id" <> 'credential'
	AND ("access_token" IS NOT NULL OR "refresh_token" IS NOT NULL OR "id_token" IS NOT NULL);
--> statement-breakpoint
-- A username/password account is shown by its username (auth.ts user.create.before). Earlier
-- sign-ups could set any display name through the API; bring those back in line.
UPDATE "users" u
SET "name" = coalesce(u."display_username", u."username")
WHERE u."username" IS NOT NULL
	AND coalesce(u."is_anonymous", false) = false
	AND u."name" IS DISTINCT FROM coalesce(u."display_username", u."username")
	AND EXISTS (SELECT 1 FROM "accounts" a WHERE a."user_id" = u."id" AND a."provider_id" = 'credential');
