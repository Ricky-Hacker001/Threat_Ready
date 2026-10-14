-- Role assumed by the API inside user-scoped transactions (SET LOCAL ROLE tr_app_user).
-- NOLOGIN and no BYPASSRLS: RLS policies apply to every statement it runs (ADD L7 backstop).
-- In RDS the API's login role (tr_api) is created by infra and granted membership in tr_app_user;
-- the worker's login role owns the tables and is not subject to the policies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tr_app_user') THEN
    CREATE ROLE tr_app_user NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT tr_app_user TO CURRENT_USER;
