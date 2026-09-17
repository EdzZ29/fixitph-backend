-- Extensions the schema depends on.
--   citext  : case-insensitive users.email, so Ana@x.com and ana@x.com collide
--             at the unique index instead of creating two accounts.
-- gen_random_uuid() is built into PostgreSQL 13+, so pgcrypto is not required.
CREATE EXTENSION IF NOT EXISTS citext;
