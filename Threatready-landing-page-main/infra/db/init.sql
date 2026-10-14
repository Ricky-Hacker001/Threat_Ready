-- Local/bootstrap roles. On AWS the same statements run once from OpenTofu
-- (or a one-off task) against RDS with the master user.
--
--   threatready_owner  owns the schema, runs migrations
--   threatready_app    what the API connects as: DML only, cannot bypass RLS
--   threatready_worker reserved for the worker role (ADD L7); not used yet
--
-- Passwords here are for local development only.

CREATE ROLE threatready_owner LOGIN PASSWORD 'owner_dev_password';
CREATE ROLE threatready_app LOGIN PASSWORD 'app_dev_password' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE threatready_worker LOGIN PASSWORD 'worker_dev_password' NOSUPERUSER NOBYPASSRLS;

CREATE DATABASE threatready OWNER threatready_owner;

\connect threatready

ALTER SCHEMA public OWNER TO threatready_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO threatready_app, threatready_worker;

-- Every table/sequence/type the owner creates is usable (not owned) by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE threatready_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO threatready_app;
ALTER DEFAULT PRIVILEGES FOR ROLE threatready_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO threatready_app;
ALTER DEFAULT PRIVILEGES FOR ROLE threatready_owner IN SCHEMA public
  GRANT USAGE ON TYPES TO threatready_app;
