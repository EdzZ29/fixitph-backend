-- ===========================================================================
-- Sign in with Google
--
-- Two changes. An account may now have no password at all, and an account may
-- be linked to an identity held somewhere else.
-- ===========================================================================

-- A Google-only account has nothing to put here. Login reads a null hash as
-- "no password set" rather than as a password that never matches, so the
-- distinction has to survive into the column.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE');

CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    -- Google's stable subject id, not the email. A Workspace administrator can
    -- reassign an address between people; the subject id survives that, so
    -- matching on it is what stops a reassigned address inheriting somebody
    -- else's FixItPH account.
    "provider_account_id" VARCHAR(255) NOT NULL,
    -- What Google asserted at link time. Kept for support, never matched on.
    "email" CITEXT NOT NULL,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(6),

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- One FixItPH account per external identity. Without this, two accounts could
-- both claim the same Google user and which one you landed in would depend on
-- row order.
CREATE UNIQUE INDEX "oauth_accounts_provider_provider_account_id_key"
  ON "oauth_accounts"("provider", "provider_account_id");

CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts"("user_id");

ALTER TABLE "oauth_accounts"
  ADD CONSTRAINT "oauth_accounts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Deliberately NOT under row level security.
--
-- Every other table that holds one person's data is, and the reason this one
-- is not is worth stating rather than leaving as an oversight.
--
-- RLS scopes a row to the caller's session. This table is read *before* there
-- is a session: the whole point of the lookup is to find out who is signing
-- in. A policy here would not fail loudly, it would return no rows, and every
-- returning Google user would silently become a brand new account. That is
-- the same trap that had provider_documents invisible to the profile that
-- derives its badges from them.
--
-- So it follows the rule the other pre-session auth tables already follow —
-- users, refresh_tokens, password_reset_tokens are none of them RLS-protected
-- either. What guards it instead is that no route returns its contents: it is
-- read by the sign-in path and written by the link path, and nothing else
-- touches it. The API role reaches it through the default privileges granted
-- in the security migration.
-- ---------------------------------------------------------------------------
