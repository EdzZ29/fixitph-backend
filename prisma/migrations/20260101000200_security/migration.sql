-- ===========================================================================
-- FixItPH security layer
--
-- Everything here is enforcement the application cannot talk its way out of:
-- row level security, CHECK constraints, partial unique indexes, append-only
-- triggers, and two self-securing views.
--
-- IMPORTANT — how RLS actually takes effect here
-- ----------------------------------------------
-- A table's owner bypasses RLS unless the table is FORCEd. Migrations and
-- seeds run as the owner (DATABASE_URL). The running API connects as a
-- separate, non-owner, NOBYPASSRLS role (DATABASE_APP_URL) so that every
-- policy below is evaluated. The API refuses to boot if it detects it is
-- connected as an owner/superuser role; see src/prisma/prisma.service.ts.
--
-- Session context is set per transaction by PrismaService.withUser():
--   SELECT set_config('app.current_user_id', $1, true);
--   SELECT set_config('app.current_role',    $2, true);
-- The `true` makes them transaction-local, so a pooled connection can never
-- leak one request's identity into the next.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- 1. Runtime role
-- ---------------------------------------------------------------------------
-- Created without LOGIN here so that no password ever lands in version
-- control. docker/postgres/initdb/10-app-role.sh gives it LOGIN and a password
-- from APP_DB_PASSWORD. If you provision Postgres some other way, run:
--   ALTER ROLE fixitph_app WITH LOGIN PASSWORD '...';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fixitph_app') THEN
    CREATE ROLE fixitph_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Session context helpers
-- ---------------------------------------------------------------------------
-- current_setting(..., true) returns NULL rather than raising when the setting
-- is absent, which is what makes anonymous (unauthenticated) reads work: the
-- identity comparisons below evaluate to NULL, so only the explicitly public
-- clauses can match.

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_role() RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NULLIF(current_setting('app.current_role', true), '');
$$;

CREATE OR REPLACE FUNCTION app.is_admin() RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.current_role', true), '') = 'ADMIN', false);
$$;

-- SECURITY DEFINER so the lookup itself is not filtered by any policy, which
-- would otherwise make the provider policies recursive.
CREATE OR REPLACE FUNCTION app.current_provider_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
  SELECT p.id
  FROM public.providers p
  WHERE p.user_id = app.current_user_id()
    AND p.deleted_at IS NULL
  LIMIT 1;
$$;

-- Does the current user own this service request? Used by the quotes policy.
CREATE OR REPLACE FUNCTION app.owns_service_request(p_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.service_requests sr
    WHERE sr.id = p_request_id
      AND sr.customer_id = app.current_user_id()
  );
$$;

-- Has the current provider already quoted this request? Lets a provider keep
-- seeing a request after quoting it, without exposing the whole open pool.
CREATE OR REPLACE FUNCTION app.provider_has_quoted(p_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.quotes q
    WHERE q.service_request_id = p_request_id
      AND q.provider_id = app.current_provider_id()
  );
$$;

-- Is the current user a participant in this booking?
CREATE OR REPLACE FUNCTION app.participates_in_booking(p_booking_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id = p_booking_id
      AND (b.customer_id = app.current_user_id() OR b.provider_id = app.current_provider_id())
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. CHECK constraints
-- ---------------------------------------------------------------------------

-- users -------------------------------------------------------------------
ALTER TABLE "users"
  ADD CONSTRAINT users_failed_login_count_non_negative
    CHECK ("failed_login_count" >= 0),
  ADD CONSTRAINT users_email_shape
    CHECK ("email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- profiles ----------------------------------------------------------------
ALTER TABLE "profiles"
  ADD CONSTRAINT profiles_latitude_range
    CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90)),
  ADD CONSTRAINT profiles_longitude_range
    CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));

-- providers ---------------------------------------------------------------
ALTER TABLE "providers"
  ADD CONSTRAINT providers_rating_avg_range
    CHECK ("rating_avg" >= 0 AND "rating_avg" <= 5),
  ADD CONSTRAINT providers_rating_count_non_negative
    CHECK ("rating_count" >= 0),
  ADD CONSTRAINT providers_completed_jobs_non_negative
    CHECK ("completed_jobs_count" >= 0),
  ADD CONSTRAINT providers_service_radius_positive
    CHECK ("service_radius_km" IS NULL OR "service_radius_km" > 0),
  ADD CONSTRAINT providers_years_experience_sane
    CHECK ("years_experience" IS NULL OR ("years_experience" >= 0 AND "years_experience" <= 80)),
  ADD CONSTRAINT providers_latitude_range
    CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90)),
  ADD CONSTRAINT providers_longitude_range
    CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180)),
  -- A provider is only ever "verified" with a timestamp to prove when.
  ADD CONSTRAINT providers_verified_at_matches_status
    CHECK (("verification_status" = 'APPROVED') = ("verified_at" IS NOT NULL));

-- categories --------------------------------------------------------------
ALTER TABLE "categories"
  ADD CONSTRAINT categories_not_own_parent
    CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- services ----------------------------------------------------------------
-- Business rule 1: a price is mandatory unless the listing explicitly says the
-- price has to be quoted.
ALTER TABLE "services"
  ADD CONSTRAINT services_price_required_unless_quote
    CHECK ("pricing_type" = 'QUOTE_REQUIRED' OR ("price" IS NOT NULL AND "price" >= 0)),
  ADD CONSTRAINT services_quote_required_has_no_price
    CHECK ("pricing_type" <> 'QUOTE_REQUIRED' OR "price" IS NULL),
  ADD CONSTRAINT services_price_band_ordered
    CHECK ("min_price" IS NULL OR "max_price" IS NULL OR "min_price" <= "max_price"),
  ADD CONSTRAINT services_price_band_non_negative
    CHECK (("min_price" IS NULL OR "min_price" >= 0) AND ("max_price" IS NULL OR "max_price" >= 0)),
  ADD CONSTRAINT services_duration_positive
    CHECK ("duration_minutes" IS NULL OR "duration_minutes" > 0),
  -- Per-unit and hourly pricing are meaningless without naming the unit.
  ADD CONSTRAINT services_unit_named_when_needed
    CHECK ("pricing_type" NOT IN ('HOURLY', 'PER_UNIT') OR "price_unit" IS NOT NULL);

-- availability ------------------------------------------------------------
ALTER TABLE "availability"
  ADD CONSTRAINT availability_window_ordered
    CHECK ("is_closed" OR "end_time" > "start_time");

-- service_areas -----------------------------------------------------------
ALTER TABLE "service_areas"
  ADD CONSTRAINT service_areas_radius_present_when_radius_type
    CHECK ("area_type" <> 'RADIUS' OR "radius_km" IS NOT NULL),
  ADD CONSTRAINT service_areas_surcharge_non_negative
    CHECK ("surcharge" IS NULL OR "surcharge" >= 0);

-- service_requests --------------------------------------------------------
ALTER TABLE "service_requests"
  ADD CONSTRAINT service_requests_budget_ordered
    CHECK ("budget_min" IS NULL OR "budget_max" IS NULL OR "budget_min" <= "budget_max"),
  ADD CONSTRAINT service_requests_budget_non_negative
    CHECK (("budget_min" IS NULL OR "budget_min" >= 0) AND ("budget_max" IS NULL OR "budget_max" >= 0)),
  ADD CONSTRAINT service_requests_latitude_range
    CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90)),
  ADD CONSTRAINT service_requests_longitude_range
    CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));

-- quotes ------------------------------------------------------------------
ALTER TABLE "quotes"
  ADD CONSTRAINT quotes_amount_positive
    CHECK ("amount" > 0),
  ADD CONSTRAINT quotes_components_non_negative
    CHECK (("labor_cost" IS NULL OR "labor_cost" >= 0) AND ("parts_cost" IS NULL OR "parts_cost" >= 0)),
  ADD CONSTRAINT quotes_duration_positive
    CHECK ("estimated_duration_minutes" IS NULL OR "estimated_duration_minutes" > 0),
  ADD CONSTRAINT quotes_responded_at_matches_status
    CHECK ("status" = 'PENDING' OR "responded_at" IS NOT NULL);

-- bookings ----------------------------------------------------------------
ALTER TABLE "bookings"
  ADD CONSTRAINT bookings_total_amount_non_negative
    CHECK ("total_amount" >= 0),
  ADD CONSTRAINT bookings_schedule_ordered
    CHECK ("scheduled_end" IS NULL OR "scheduled_end" > "scheduled_start"),
  ADD CONSTRAINT bookings_actual_window_ordered
    CHECK ("actual_end" IS NULL OR "actual_start" IS NULL OR "actual_end" >= "actual_start"),
  -- Business rule 5: the exact address is never released while the booking is
  -- still awaiting confirmation.
  ADD CONSTRAINT bookings_contact_release_requires_confirmation
    CHECK ("contact_released_at" IS NULL OR "status" <> 'PENDING_CONFIRMATION'),
  ADD CONSTRAINT bookings_cancellation_fields_consistent
    CHECK (
      "status" NOT IN ('CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PROVIDER')
      OR ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL)
    ),
  ADD CONSTRAINT bookings_completion_fields_consistent
    CHECK ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL);

-- reviews -----------------------------------------------------------------
-- Business rule 7: ratings are 1 to 5, no exceptions.
ALTER TABLE "reviews"
  ADD CONSTRAINT reviews_rating_range
    CHECK ("rating" >= 1 AND "rating" <= 5),
  ADD CONSTRAINT reviews_punctuality_rating_range
    CHECK ("punctuality_rating" IS NULL OR ("punctuality_rating" >= 1 AND "punctuality_rating" <= 5)),
  ADD CONSTRAINT reviews_quality_rating_range
    CHECK ("quality_rating" IS NULL OR ("quality_rating" >= 1 AND "quality_rating" <= 5)),
  ADD CONSTRAINT reviews_value_rating_range
    CHECK ("value_rating" IS NULL OR ("value_rating" >= 1 AND "value_rating" <= 5)),
  ADD CONSTRAINT reviews_edit_history_is_array
    CHECK (jsonb_typeof("edit_history") = 'array'),
  ADD CONSTRAINT reviews_response_has_timestamp
    CHECK ("provider_response" IS NULL OR "provider_responded_at" IS NOT NULL);

-- messages ----------------------------------------------------------------
-- A message hangs off exactly one thread anchor. This is what lets the RLS
-- policy stay a simple participant check.
ALTER TABLE "messages"
  ADD CONSTRAINT messages_exactly_one_anchor
    CHECK (("booking_id" IS NOT NULL)::int + ("service_request_id" IS NOT NULL)::int = 1),
  ADD CONSTRAINT messages_no_self_send
    CHECK ("sender_id" <> "recipient_id"),
  ADD CONSTRAINT messages_body_not_blank
    CHECK (length(btrim("body")) > 0);

-- attachments and documents ------------------------------------------------
ALTER TABLE "message_attachments"
  ADD CONSTRAINT message_attachments_size_positive CHECK ("size_bytes" > 0),
  ADD CONSTRAINT message_attachments_checksum_hex CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "provider_documents"
  ADD CONSTRAINT provider_documents_size_positive CHECK ("size_bytes" > 0),
  ADD CONSTRAINT provider_documents_checksum_hex CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT provider_documents_rejection_reason_present
    CHECK ("status" <> 'REJECTED' OR "rejection_reason" IS NOT NULL);

-- disputes -----------------------------------------------------------------
ALTER TABLE "disputes"
  ADD CONSTRAINT disputes_refund_non_negative
    CHECK ("refund_amount" IS NULL OR "refund_amount" >= 0),
  ADD CONSTRAINT disputes_resolution_fields_consistent
    CHECK (
      "status" NOT IN ('RESOLVED_REFUND', 'RESOLVED_PARTIAL_REFUND', 'RESOLVED_NO_ACTION')
      OR ("resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL AND "resolution" IS NOT NULL)
    );

-- ---------------------------------------------------------------------------
-- 4. Partial unique indexes
-- ---------------------------------------------------------------------------

-- Business rule 3: one live quote per provider per request. A withdrawn or
-- rejected quote does not block re-quoting.
CREATE UNIQUE INDEX quotes_one_live_per_provider_per_request
  ON "quotes" ("service_request_id", "provider_id")
  WHERE "status" IN ('PENDING', 'ACCEPTED');

-- Business rule 4: a request can only ever have one accepted quote, so it can
-- only ever produce one booking. Paired with the unique bookings.quote_id.
CREATE UNIQUE INDEX quotes_one_accepted_per_request
  ON "quotes" ("service_request_id")
  WHERE "status" = 'ACCEPTED';

-- A provider cannot hold two live bookings in the same slot.
CREATE UNIQUE INDEX bookings_provider_slot_unique
  ON "bookings" ("provider_id", "scheduled_start")
  WHERE "deleted_at" IS NULL
    AND "status" IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'IN_PROGRESS');

-- Only one open dispute per booking at a time.
CREATE UNIQUE INDEX disputes_one_open_per_booking
  ON "disputes" ("booking_id")
  WHERE "status" IN ('OPEN', 'UNDER_REVIEW', 'AWAITING_CUSTOMER', 'AWAITING_PROVIDER', 'ESCALATED');

-- Case-insensitive slug uniqueness, so "Rommel-Aircon" cannot shadow
-- "rommel-aircon".
CREATE UNIQUE INDEX providers_slug_lower_unique ON "providers" (lower("slug"));

-- ---------------------------------------------------------------------------
-- 5. Append-only and soft-delete triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.deny_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not permitted: this table is append only',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;

-- Business rule 9: these four are soft-deleted, never removed.
CREATE OR REPLACE FUNCTION app.deny_hard_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'hard delete on %.% is not permitted: set deleted_at instead',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;

-- Business rule 10: the admin audit log can only grow.
CREATE TRIGGER admin_actions_no_update
  BEFORE UPDATE ON "admin_actions"
  FOR EACH ROW EXECUTE FUNCTION app.deny_mutation();

CREATE TRIGGER admin_actions_no_delete
  BEFORE DELETE ON "admin_actions"
  FOR EACH ROW EXECUTE FUNCTION app.deny_mutation();

-- Business rule 6: so can the booking status trail.
CREATE TRIGGER booking_status_history_no_update
  BEFORE UPDATE ON "booking_status_history"
  FOR EACH ROW EXECUTE FUNCTION app.deny_mutation();

CREATE TRIGGER booking_status_history_no_delete
  BEFORE DELETE ON "booking_status_history"
  FOR EACH ROW EXECUTE FUNCTION app.deny_mutation();

CREATE TRIGGER users_no_hard_delete
  BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION app.deny_hard_delete();

CREATE TRIGGER services_no_hard_delete
  BEFORE DELETE ON "services"
  FOR EACH ROW EXECUTE FUNCTION app.deny_hard_delete();

CREATE TRIGGER bookings_no_hard_delete
  BEFORE DELETE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION app.deny_hard_delete();

CREATE TRIGGER reviews_no_hard_delete
  BEFORE DELETE ON "reviews"
  FOR EACH ROW EXECUTE FUNCTION app.deny_hard_delete();

-- Prisma's @updatedAt only fires for writes that go through the client. This
-- keeps updated_at honest for raw SQL, admin fixes and trigger-driven writes.
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'updated_at'
      AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()',
      t.relname || '_set_updated_at', t.relname
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Booking status trail, written by the database
-- ---------------------------------------------------------------------------
-- Business rule 6: no status change can escape the log, because the log is not
-- written by application code. The service layer only supplies the reason:
--   SELECT set_config('app.status_change_reason', 'customer cancelled', true);
-- SECURITY DEFINER because the application role has no INSERT on this table.

CREATE OR REPLACE FUNCTION app.record_booking_status_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.booking_status_history (booking_id, from_status, to_status, changed_by, reason)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
    NEW.status,
    app.current_user_id(),
    NULLIF(current_setting('app.status_change_reason', true), '')
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_record_status_insert
  AFTER INSERT ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION app.record_booking_status_change();

CREATE TRIGGER bookings_record_status_update
  AFTER UPDATE OF "status" ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION app.record_booking_status_change();

-- ---------------------------------------------------------------------------
-- 7. Review integrity
-- ---------------------------------------------------------------------------
-- Business rule 7: a review may only be attached to the author's own COMPLETED
-- booking. Checked here rather than only in the service, so a raw insert
-- cannot bypass it.

CREATE OR REPLACE FUNCTION app.reviews_guard_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app, pg_catalog, pg_temp
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
BEGIN
  SELECT * INTO v_booking FROM public.bookings WHERE id = NEW.booking_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking % does not exist', NEW.booking_id USING ERRCODE = '23503';
  END IF;

  IF v_booking.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'a review can only be left on a COMPLETED booking (booking is %)', v_booking.status
      USING ERRCODE = '23514';
  END IF;

  IF v_booking.customer_id <> NEW.author_id THEN
    RAISE EXCEPTION 'only the booking customer may review it' USING ERRCODE = '42501';
  END IF;

  IF v_booking.provider_id <> NEW.provider_id THEN
    RAISE EXCEPTION 'review provider must match the booking provider' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reviews_guard_insert
  BEFORE INSERT ON "reviews"
  FOR EACH ROW EXECUTE FUNCTION app.reviews_guard_insert();

-- Business rule 8: an edit appends to edit_history. The original is kept.
-- A provider may only ever add their response; they can never touch the score
-- or the text.
CREATE OR REPLACE FUNCTION app.reviews_guard_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app, pg_catalog, pg_temp
AS $$
DECLARE
  v_content_changed boolean;
BEGIN
  IF app.is_admin() THEN
    RETURN NEW;
  END IF;

  -- History is append only, for everyone.
  IF jsonb_array_length(NEW.edit_history) < jsonb_array_length(OLD.edit_history) THEN
    RAISE EXCEPTION 'review edit history is append only' USING ERRCODE = '42501';
  END IF;

  IF OLD.author_id = app.current_user_id() THEN
    -- The author may not write the provider's reply for them.
    IF NEW.provider_response IS DISTINCT FROM OLD.provider_response THEN
      RAISE EXCEPTION 'the review author cannot modify the provider response' USING ERRCODE = '42501';
    END IF;

    v_content_changed :=
      NEW.rating IS DISTINCT FROM OLD.rating
      OR NEW.comment IS DISTINCT FROM OLD.comment
      OR NEW.punctuality_rating IS DISTINCT FROM OLD.punctuality_rating
      OR NEW.quality_rating IS DISTINCT FROM OLD.quality_rating
      OR NEW.value_rating IS DISTINCT FROM OLD.value_rating;

    IF v_content_changed
       AND jsonb_array_length(NEW.edit_history) <= jsonb_array_length(OLD.edit_history) THEN
      RAISE EXCEPTION 'changing review content requires appending the previous version to edit_history'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  -- Anyone else reaching this point is the provider replying.
  IF NEW.rating            IS DISTINCT FROM OLD.rating
     OR NEW.comment        IS DISTINCT FROM OLD.comment
     OR NEW.edit_history   IS DISTINCT FROM OLD.edit_history
     OR NEW.punctuality_rating IS DISTINCT FROM OLD.punctuality_rating
     OR NEW.quality_rating IS DISTINCT FROM OLD.quality_rating
     OR NEW.value_rating   IS DISTINCT FROM OLD.value_rating
     OR NEW.is_hidden      IS DISTINCT FROM OLD.is_hidden
     OR NEW.deleted_at     IS DISTINCT FROM OLD.deleted_at
     OR NEW.author_id      IS DISTINCT FROM OLD.author_id
     OR NEW.booking_id     IS DISTINCT FROM OLD.booking_id THEN
    RAISE EXCEPTION 'only the review author may change review content' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reviews_guard_update
  BEFORE UPDATE ON "reviews"
  FOR EACH ROW EXECUTE FUNCTION app.reviews_guard_update();

-- ---------------------------------------------------------------------------
-- 8. Row level security
-- ---------------------------------------------------------------------------
-- Enabled on the seven tables named in the security design, plus
-- booking_status_history (it carries the same data as bookings and there is no
-- reason to leave it readable).

ALTER TABLE "bookings"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_requests"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quotes"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reviews"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_documents"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_actions"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "booking_status_history"  ENABLE ROW LEVEL SECURITY;

-- bookings ----------------------------------------------------------------
CREATE POLICY bookings_select ON "bookings" FOR SELECT
  USING (
    app.is_admin()
    OR "customer_id" = app.current_user_id()
    OR "provider_id" = app.current_provider_id()
  );

CREATE POLICY bookings_insert ON "bookings" FOR INSERT
  WITH CHECK (
    app.is_admin()
    OR "customer_id" = app.current_user_id()
  );

CREATE POLICY bookings_update ON "bookings" FOR UPDATE
  USING (
    app.is_admin()
    OR "customer_id" = app.current_user_id()
    OR "provider_id" = app.current_provider_id()
  )
  WITH CHECK (
    app.is_admin()
    OR "customer_id" = app.current_user_id()
    OR "provider_id" = app.current_provider_id()
  );
-- Deliberately no DELETE policy: bookings are soft-deleted.

-- service_requests ---------------------------------------------------------
CREATE POLICY service_requests_select ON "service_requests" FOR SELECT
  USING (
    app.is_admin()
    OR "customer_id" = app.current_user_id()
    OR "provider_id" = app.current_provider_id()
    OR app.provider_has_quoted("id")
  );

CREATE POLICY service_requests_insert ON "service_requests" FOR INSERT
  WITH CHECK (
    app.is_admin()
    OR "customer_id" = app.current_user_id()
  );

CREATE POLICY service_requests_update ON "service_requests" FOR UPDATE
  USING (
    app.is_admin()
    OR "customer_id" = app.current_user_id()
    OR "provider_id" = app.current_provider_id()
    OR app.provider_has_quoted("id")
  )
  WITH CHECK (
    app.is_admin()
    OR "customer_id" = app.current_user_id()
    OR "provider_id" = app.current_provider_id()
    OR app.provider_has_quoted("id")
  );

CREATE POLICY service_requests_delete ON "service_requests" FOR DELETE
  USING (app.is_admin());

-- quotes -------------------------------------------------------------------
CREATE POLICY quotes_select ON "quotes" FOR SELECT
  USING (
    app.is_admin()
    OR "provider_id" = app.current_provider_id()
    OR app.owns_service_request("service_request_id")
  );

CREATE POLICY quotes_insert ON "quotes" FOR INSERT
  WITH CHECK (
    app.is_admin()
    OR "provider_id" = app.current_provider_id()
  );

-- The customer needs UPDATE to accept or reject; the guard layer restricts
-- which columns each side is allowed to touch.
CREATE POLICY quotes_update ON "quotes" FOR UPDATE
  USING (
    app.is_admin()
    OR "provider_id" = app.current_provider_id()
    OR app.owns_service_request("service_request_id")
  )
  WITH CHECK (
    app.is_admin()
    OR "provider_id" = app.current_provider_id()
    OR app.owns_service_request("service_request_id")
  );

CREATE POLICY quotes_delete ON "quotes" FOR DELETE
  USING (app.is_admin());

-- messages -----------------------------------------------------------------
CREATE POLICY messages_select ON "messages" FOR SELECT
  USING (
    app.is_admin()
    OR "sender_id" = app.current_user_id()
    OR "recipient_id" = app.current_user_id()
  );

CREATE POLICY messages_insert ON "messages" FOR INSERT
  WITH CHECK (
    app.is_admin()
    OR "sender_id" = app.current_user_id()
  );

-- Recipients update only to stamp read_at.
CREATE POLICY messages_update ON "messages" FOR UPDATE
  USING (app.is_admin() OR "recipient_id" = app.current_user_id())
  WITH CHECK (app.is_admin() OR "recipient_id" = app.current_user_id());

CREATE POLICY messages_delete ON "messages" FOR DELETE
  USING (app.is_admin());

-- reviews ------------------------------------------------------------------
-- Reviews are public by design: that is the whole point of the rating system.
-- Hidden and soft-deleted rows collapse back to author, provider and admin.
CREATE POLICY reviews_select ON "reviews" FOR SELECT
  USING (
    app.is_admin()
    OR "author_id" = app.current_user_id()
    OR "provider_id" = app.current_provider_id()
    OR ("deleted_at" IS NULL AND "is_hidden" = false)
  );

CREATE POLICY reviews_insert ON "reviews" FOR INSERT
  WITH CHECK (
    app.is_admin()
    OR "author_id" = app.current_user_id()
  );

CREATE POLICY reviews_update ON "reviews" FOR UPDATE
  USING (
    app.is_admin()
    OR "author_id" = app.current_user_id()
    OR "provider_id" = app.current_provider_id()
  )
  WITH CHECK (
    app.is_admin()
    OR "author_id" = app.current_user_id()
    OR "provider_id" = app.current_provider_id()
  );
-- No DELETE policy: reviews are soft-deleted.

-- provider_documents -------------------------------------------------------
CREATE POLICY provider_documents_select ON "provider_documents" FOR SELECT
  USING (app.is_admin() OR "provider_id" = app.current_provider_id());

CREATE POLICY provider_documents_insert ON "provider_documents" FOR INSERT
  WITH CHECK (app.is_admin() OR "provider_id" = app.current_provider_id());

CREATE POLICY provider_documents_update ON "provider_documents" FOR UPDATE
  USING (app.is_admin() OR "provider_id" = app.current_provider_id())
  WITH CHECK (app.is_admin() OR "provider_id" = app.current_provider_id());

CREATE POLICY provider_documents_delete ON "provider_documents" FOR DELETE
  USING (app.is_admin() OR "provider_id" = app.current_provider_id());

-- admin_actions ------------------------------------------------------------
-- Readable only by admins, writable only by the acting admin, never mutable.
CREATE POLICY admin_actions_select ON "admin_actions" FOR SELECT
  USING (app.is_admin());

CREATE POLICY admin_actions_insert ON "admin_actions" FOR INSERT
  WITH CHECK (app.is_admin() AND "admin_id" = app.current_user_id());
-- No UPDATE or DELETE policy, and the triggers above refuse both anyway.

-- booking_status_history ---------------------------------------------------
CREATE POLICY booking_status_history_select ON "booking_status_history" FOR SELECT
  USING (app.is_admin() OR app.participates_in_booking("booking_id"));
-- No INSERT policy: rows arrive only via the SECURITY DEFINER trigger.

-- ---------------------------------------------------------------------------
-- 9. Least-privilege views
-- ---------------------------------------------------------------------------
-- These are owned by the migration role, so they read underlying tables
-- without RLS and secure themselves in their own WHERE clause. That is what
-- lets them show a provider strictly less than the base table would.

-- Security design item 7. Before the booking is confirmed a provider gets the
-- general area only. Exact street address, coordinates and phone number appear
-- only once contact_released_at is stamped, which happens on confirmation.
CREATE VIEW public.booking_contact_for_provider AS
SELECT
  b.id                AS booking_id,
  b.provider_id,
  b.status,
  b.scheduled_start,
  b.contact_released_at,
  -- Always visible: enough to judge travel and decide.
  sr.city             AS customer_city,
  sr.barangay         AS customer_barangay,
  -- Released on confirmation only.
  CASE WHEN b.contact_released_at IS NOT NULL
       THEN COALESCE(pr.display_name, pr.first_name || ' ' || pr.last_name)
  END                 AS customer_name,
  CASE WHEN b.contact_released_at IS NOT NULL THEN u.phone      END AS customer_phone,
  CASE WHEN b.contact_released_at IS NOT NULL THEN sr.address_line1 END AS customer_address_line1,
  CASE WHEN b.contact_released_at IS NOT NULL THEN sr.latitude  END AS customer_latitude,
  CASE WHEN b.contact_released_at IS NOT NULL THEN sr.longitude END AS customer_longitude
FROM public.bookings b
JOIN public.service_requests sr ON sr.id = b.service_request_id
JOIN public.users u             ON u.id = b.customer_id
LEFT JOIN public.profiles pr    ON pr.user_id = u.id
WHERE b.deleted_at IS NULL
  AND (app.is_admin() OR b.provider_id = app.current_provider_id());

COMMENT ON VIEW public.booking_contact_for_provider IS
  'Provider-facing customer contact. General area always; exact address, coordinates and phone only after contact_released_at is set on confirmation.';

-- Discovery feed for broadcast requests. Carries no customer identity, no
-- street address and no coordinates, so a provider can browse work in their
-- area without the base table ever exposing a customer.
CREATE VIEW public.open_service_request_feed AS
SELECT
  sr.id,
  sr.category_id,
  sr.service_id,
  sr.title,
  left(sr.description, 280) AS description_preview,
  sr.urgency,
  sr.city,
  sr.barangay,
  sr.budget_min,
  sr.budget_max,
  sr.preferred_at,
  sr.expires_at,
  sr.created_at,
  (
    SELECT count(*) FROM public.quotes q
    WHERE q.service_request_id = sr.id AND q.status = 'PENDING'
  ) AS pending_quote_count
FROM public.service_requests sr
WHERE sr.provider_id IS NULL
  AND sr.status IN ('OPEN', 'QUOTED')
  AND (sr.expires_at IS NULL OR sr.expires_at > now());

COMMENT ON VIEW public.open_service_request_feed IS
  'Broadcast requests available to quote. Deliberately excludes customer_id, address_line1, latitude and longitude.';

-- ---------------------------------------------------------------------------
-- 10. Grants for the runtime role
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO fixitph_app;
GRANT USAGE ON SCHEMA app    TO fixitph_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fixitph_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fixitph_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO fixitph_app;

-- Business rule 9: no route, ORM call or raw query from the API can hard
-- delete these, because the privilege is simply not there.
REVOKE DELETE ON "users", "services", "bookings", "reviews" FROM fixitph_app;

-- Business rules 6 and 10: append-only tables. The API cannot write
-- booking_status_history directly either; the trigger does it.
REVOKE INSERT, UPDATE, DELETE ON "booking_status_history" FROM fixitph_app;
REVOKE UPDATE, DELETE ON "admin_actions" FROM fixitph_app;

-- Migration bookkeeping is none of the API's business. Guarded because the
-- table only exists when Prisma Migrate is driving; applying this file with
-- psql or a test harness should not fail on it.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public._prisma_migrations FROM fixitph_app';
  END IF;
END
$$;

-- Anything added by a later migration inherits the same baseline.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fixitph_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fixitph_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO fixitph_app;
