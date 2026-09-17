-- ===========================================================================
-- Platform settings
--
-- Operator-editable configuration for the admin dashboard. Key/value rather
-- than a column per setting, so adding a setting is an INSERT rather than a
-- migration.
--
-- The table is under RLS like the rest of the operator-sensitive data: anyone
-- may read a row flagged public, only an admin may read the others, and only
-- an admin may write. The API connects as a NOBYPASSRLS role, so this holds
-- even if the service layer forgets to check.
-- ===========================================================================

-- AlterEnum: new audit vocabulary for a settings change.
ALTER TYPE "admin_action_type" ADD VALUE IF NOT EXISTS 'SETTING_UPDATE';
ALTER TYPE "admin_action_target_type" ADD VALUE IF NOT EXISTS 'SETTING';

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'setting_value_type') THEN
    CREATE TYPE "setting_value_type" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');
  END IF;
END
$$;

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" VARCHAR(80) NOT NULL,
    "value" JSONB NOT NULL,
    "value_type" "setting_value_type" NOT NULL DEFAULT 'STRING',
    "label" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "group" VARCHAR(60) NOT NULL DEFAULT 'general',
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "is_editable" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "platform_settings_group_position_idx" ON "platform_settings"("group", "position");

-- CreateIndex
CREATE INDEX "platform_settings_is_public_idx" ON "platform_settings"("is_public");

-- AddForeignKey
ALTER TABLE "platform_settings"
  ADD CONSTRAINT "platform_settings_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A key is an identifier, not free text. Constrained here so a typo cannot
-- create a near-duplicate setting that silently shadows the real one.
ALTER TABLE "platform_settings"
  ADD CONSTRAINT "platform_settings_key_format"
  CHECK ("key" ~ '^[a-z][a-z0-9_.]{1,79}$');

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;

-- A maintenance notice has to be readable by someone who cannot log in, so
-- public rows are readable by anyone. Everything else is admin-only.
CREATE POLICY platform_settings_select ON "platform_settings" FOR SELECT
  USING (app.is_admin() OR "is_public");

CREATE POLICY platform_settings_insert ON "platform_settings" FOR INSERT
  WITH CHECK (app.is_admin());

-- is_editable is the operator's own guard rail against changing a row that
-- the code treats as fixed. Enforced here rather than only in the service.
CREATE POLICY platform_settings_update ON "platform_settings" FOR UPDATE
  USING (app.is_admin() AND "is_editable")
  WITH CHECK (app.is_admin() AND "is_editable");

-- No delete policy: with RLS on and no permissive policy, every DELETE is
-- refused. Retiring a setting is a migration, not a runtime action.

-- ---------------------------------------------------------------------------
-- Seed rows
-- ---------------------------------------------------------------------------
-- Defaults, so the settings screen is never an empty table. Inserted by the
-- migration (which runs as the owner and so bypasses the policies above).

INSERT INTO "platform_settings"
  ("key", "value", "value_type", "label", "description", "group", "position", "is_public")
VALUES
  ('platform.name', '"FixItPH"', 'STRING',
   'Platform name',
   'Shown in page titles and transactional email.', 'general', 10, true),

  ('platform.support_email', '"support@fixitph.test"', 'STRING',
   'Support email',
   'Where the site tells people to write when something goes wrong.', 'general', 20, true),

  ('platform.support_phone', '"0917 555 0143"', 'STRING',
   'Support hotline',
   'The number in the site header.', 'general', 30, true),

  ('maintenance.notice', '""', 'STRING',
   'Maintenance notice',
   'Shown as a banner on every page when not empty. Leave empty to hide it.', 'availability', 10, true),

  ('registration.customers_open', 'true', 'BOOLEAN',
   'Customer sign-up open',
   'Turn off to stop new customer registrations.', 'availability', 20, false),

  ('registration.providers_open', 'true', 'BOOLEAN',
   'Provider sign-up open',
   'Turn off to stop new provider registrations.', 'availability', 30, false),

  ('moderation.auto_hide_report_threshold', '3', 'NUMBER',
   'Reports before review is flagged',
   'How many open reports a review needs before it shows up as urgent on the moderation queue.', 'moderation', 10, false),

  ('moderation.require_documents_for_verification', 'true', 'BOOLEAN',
   'Require documents before approval',
   'Warn an admin who is about to approve a provider with no uploaded documents.', 'moderation', 20, false),

  ('booking.cancellation_window_hours', '12', 'NUMBER',
   'Free cancellation window (hours)',
   'How long before the scheduled start a customer may cancel without it counting against them.', 'bookings', 10, true),

  ('booking.max_active_per_customer', '5', 'NUMBER',
   'Active bookings per customer',
   'Guard rail against a single account tying up every provider in a city.', 'bookings', 20, false)
ON CONFLICT ("key") DO NOTHING;
