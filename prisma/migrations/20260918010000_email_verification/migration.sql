-- ===========================================================================
-- Email verification
--
-- users.email_verified_at already existed but nothing ever wrote to it, so
-- the "Email Verified" badge could only ever come from a seed. This is the
-- flow that earns it.
--
-- Deliberately a separate table from password_reset_tokens rather than a flag
-- on it. A reset token can change a password; a code that only proves an
-- inbox is reachable must never be spendable for that, and keeping them apart
-- means a bug in one cannot promote a code issued by the other.
-- ===========================================================================

CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    -- The address being proved, so a code issued for an old address cannot
    -- confirm a new one after a change of email.
    "email" CITEXT NOT NULL,
    -- argon2id hash. The code itself is never stored.
    "code_hash" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "requested_ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_verification_tokens_user_id_created_at_idx"
  ON "email_verification_tokens"("user_id", "created_at" DESC);

CREATE INDEX "email_verification_tokens_expires_at_idx"
  ON "email_verification_tokens"("expires_at");

ALTER TABLE "email_verification_tokens"
  ADD CONSTRAINT "email_verification_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Guessing budget is enforced in the service; this stops a negative count
-- being written at all.
ALTER TABLE "email_verification_tokens"
  ADD CONSTRAINT "email_verification_attempts_non_negative"
  CHECK ("attempt_count" >= 0);

-- The table holds a code hash tied to one account, so it follows the same
-- rule as the rest of the auth tables: reachable only through the service,
-- never readable by another user.
ALTER TABLE "email_verification_tokens" ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_verification_select ON "email_verification_tokens"
  FOR SELECT USING (app.is_admin() OR "user_id" = app.current_user_id());

CREATE POLICY email_verification_insert ON "email_verification_tokens"
  FOR INSERT WITH CHECK (app.is_admin() OR "user_id" = app.current_user_id());

CREATE POLICY email_verification_update ON "email_verification_tokens"
  FOR UPDATE USING (app.is_admin() OR "user_id" = app.current_user_id())
  WITH CHECK (app.is_admin() OR "user_id" = app.current_user_id());

-- No delete policy: expired rows are cleaned up by whatever runs migrations,
-- not by the API.
