-- ===========================================================================
-- Provider profile: trading type, and profile imagery
--
-- Verification badges are deliberately NOT columns here. Whether a provider
-- is identity- or business-verified is already recorded, as the approval an
-- administrator gave to a specific document, and duplicating that into a
-- boolean invites the two disagreeing — a badge that outlives the document it
-- was based on is worse than no badge. The badges are derived at read time
-- from provider_documents plus the email/phone timestamps on users.
-- ===========================================================================

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'provider_type') THEN
    CREATE TYPE "provider_type" AS ENUM ('INDIVIDUAL', 'BUSINESS');
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "providers"
  ADD COLUMN IF NOT EXISTS "provider_type" "provider_type" NOT NULL DEFAULT 'INDIVIDUAL',
  ADD COLUMN IF NOT EXISTS "avatar_key" TEXT,
  ADD COLUMN IF NOT EXISTS "cover_key" TEXT;

COMMENT ON COLUMN "providers"."avatar_key" IS
  'Private bucket key for the profile photo. Exposed only as a short-lived signed URL.';
COMMENT ON COLUMN "providers"."cover_key" IS
  'Private bucket key for the cover image. Exposed only as a short-lived signed URL.';

-- Browsing filters by trading type ("show me registered businesses"), so it
-- joins the existing discovery index rather than getting one of its own.
CREATE INDEX IF NOT EXISTS "providers_provider_type_idx"
  ON "providers"("provider_type");
