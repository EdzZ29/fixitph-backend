-- Prepares a locally installed PostgreSQL for the FixItPH API.
--
-- Use this instead of docker-compose when Postgres is already installed on the
-- machine. Run it as a superuser against the fixitph database:
--
--   psql -h localhost -p 3000 -U postgres -d fixitph -f scripts/setup-local-postgres.sql
--
-- Idempotent: safe to run again.
--
-- What it does and why
-- --------------------
-- The API must not connect as a role that owns its tables. A table's owner
-- bypasses row level security silently, with no error, which would make every
-- policy in the security migration dead code. So:
--
--   * migrations run as the superuser, which owns the tables (DATABASE_URL)
--   * the API runs as fixitph_app, which owns nothing        (DATABASE_APP_URL)
--
-- The API verifies this at boot and refuses to start if it is connected as an
-- owner or as a role with BYPASSRLS.

\set app_password 'fixitph_app_dev_password'

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fixitph_app') THEN
    ALTER ROLE fixitph_app
      WITH LOGIN PASSWORD 'fixitph_app_dev_password'
           NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    RAISE NOTICE 'fixitph_app already existed; password and flags reset';
  ELSE
    CREATE ROLE fixitph_app
      WITH LOGIN PASSWORD 'fixitph_app_dev_password'
           NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    RAISE NOTICE 'fixitph_app created';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE fixitph TO fixitph_app;

-- The runtime role must not be able to create tables of its own in public.
-- It would own them, and owned tables skip row level security.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM fixitph_app;

-- Table-level grants are issued by the security migration, which knows which
-- tables exist and which privileges to withhold.

SELECT
  rolname,
  rolcanlogin  AS can_login,
  rolsuper     AS is_superuser,
  rolbypassrls AS bypasses_rls
FROM pg_roles
WHERE rolname = 'fixitph_app';
