#!/bin/sh
# Creates the least-privilege runtime role the API connects as.
#
# This matters more than it looks. A table's owner bypasses row level security,
# so if the API connected as POSTGRES_USER every policy in the security
# migration would be skipped without any error. Migrations run as the owner;
# the API runs as this role, which owns nothing and cannot bypass RLS.
#
# Runs once, when the data directory is first initialised.

set -eu

: "${APP_DB_USER:=fixitph_app}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  DO \$\$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
      ALTER ROLE ${APP_DB_USER}
        WITH LOGIN PASSWORD '${APP_DB_PASSWORD}'
             NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    ELSE
      CREATE ROLE ${APP_DB_USER}
        WITH LOGIN PASSWORD '${APP_DB_PASSWORD}'
             NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};

  -- The role must not be able to create tables of its own in public; it would
  -- own them, and owned tables skip RLS.
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  REVOKE CREATE ON SCHEMA public FROM ${APP_DB_USER};
SQL

echo "created runtime role ${APP_DB_USER} (NOBYPASSRLS, owns nothing)"
