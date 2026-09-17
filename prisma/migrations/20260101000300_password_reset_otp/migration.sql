-- Password reset moves from a single emailed link to a two step code flow:
-- a 6 digit one time code, then a token issued only once that code verifies.
--
-- A 6 digit code carries about 20 bits, which is not enough on its own. What
-- protects it is the short expiry, the hard attempt limit, and the lockout
-- added here.

-- Existing rows describe the old single-token flow and have no code. They are
-- ephemeral and single use, so clearing them costs nothing and lets code_hash
-- be NOT NULL from the start.
DELETE FROM "password_reset_tokens";

ALTER TABLE "password_reset_tokens"
  ADD COLUMN "code_hash"     TEXT NOT NULL,
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "locked_until"  TIMESTAMPTZ(6),
  ADD COLUMN "verified_at"   TIMESTAMPTZ(6),
  ADD COLUMN "requested_ip"  INET;

-- token_hash is no longer issued up front. It appears only when the code has
-- been verified, so it has to be nullable. The unique index still holds:
-- Postgres allows many NULLs in a unique column.
ALTER TABLE "password_reset_tokens" ALTER COLUMN "token_hash" DROP NOT NULL;

ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT password_reset_attempt_count_non_negative
    CHECK ("attempt_count" >= 0),
  -- A token can only exist on a request whose code was verified.
  ADD CONSTRAINT password_reset_token_requires_verification
    CHECK ("token_hash" IS NULL OR "verified_at" IS NOT NULL),
  -- And it can only be spent after it exists.
  ADD CONSTRAINT password_reset_used_requires_token
    CHECK ("used_at" IS NULL OR "token_hash" IS NOT NULL);

DROP INDEX IF EXISTS "password_reset_tokens_user_id_idx";
CREATE INDEX "password_reset_tokens_user_id_created_at_idx"
  ON "password_reset_tokens" ("user_id", "created_at" DESC);
