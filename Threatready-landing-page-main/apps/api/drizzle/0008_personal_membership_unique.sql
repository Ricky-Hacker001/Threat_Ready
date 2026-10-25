-- One personal workspace per user. ensurePersonalWorkspace also takes an advisory lock, but parallel
-- first requests used to be able to create two. Keep each user's oldest personal membership; a
-- dropped duplicate leaves its (now member-less) workspace behind for the retention job rather than
-- deleting rows that reference it. Institute roles (student, instructor, org_admin) are not affected.
-- The user's launches recorded under a duplicate move to the kept workspace first: the retention job
-- deletes member-less personal workspaces, and launches cascade with them. feature_launches has FORCE
-- ROW LEVEL SECURITY and no policy for this (owner) role, so it is lifted for the move only; the
-- migrations run in one transaction, so no other session ever sees it lifted.
ALTER TABLE "feature_launches" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "feature_launches" f
SET "org_id" = k."org_id"
FROM (
	SELECT "user_id", "org_id", row_number() OVER (PARTITION BY "user_id" ORDER BY "created_at", "id") AS rn
	FROM "memberships"
	WHERE "role" IN ('learner', 'trial')
) d
JOIN (
	SELECT DISTINCT ON ("user_id") "user_id", "org_id"
	FROM "memberships"
	WHERE "role" IN ('learner', 'trial')
	ORDER BY "user_id", "created_at", "id"
) k ON k."user_id" = d."user_id"
WHERE d.rn > 1 AND f."org_id" = d."org_id" AND f."user_id" = d."user_id";
--> statement-breakpoint
ALTER TABLE "feature_launches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DELETE FROM "memberships" m
USING (
	SELECT "id", row_number() OVER (PARTITION BY "user_id" ORDER BY "created_at", "id") AS rn
	FROM "memberships"
	WHERE "role" IN ('learner', 'trial')
) d
WHERE m."id" = d."id" AND d.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_personal_user_uidx" ON "memberships" ("user_id") WHERE "role" IN ('learner', 'trial');
