-- Corrects a constraint added in 20260101000300 that encoded the wrong rule.
--
-- password_reset_used_requires_token said a row with used_at must also have a
-- token_hash, on the assumption that used_at only ever means "the token was
-- spent". It also means "superseded": requesting a new code retires every
-- earlier request, and those were never verified, so they have no token. The
-- constraint made requesting a second code impossible.
--
-- The invariant that is actually true, that a token cannot exist without a
-- verification, is password_reset_token_requires_verification, which stays.

ALTER TABLE "password_reset_tokens"
  DROP CONSTRAINT IF EXISTS password_reset_used_requires_token;

COMMENT ON COLUMN "password_reset_tokens"."used_at" IS
  'When this request stopped being usable: either its token was spent, or a newer request superseded it.';
