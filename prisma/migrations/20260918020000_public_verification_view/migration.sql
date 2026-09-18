-- ===========================================================================
-- Public verification badges
--
-- Fixes a quiet failure in the badge system.
--
-- Badges are derived from approved provider_documents, but that table is
-- under row level security and its SELECT policy is admin-or-owner. A public
-- profile is read with no session context, so the documents came back as an
-- empty list and summariseVerification concluded, perfectly correctly, that
-- nothing had been checked. Every provider on the site showed at most "Email
-- Verified" no matter how much an administrator had approved.
--
-- The documents themselves must stay private: they are somebody's passport
-- and their home address. What is public is the conclusion, which the profile
-- was always meant to publish. So this view exposes the conclusion and only
-- the conclusion — whether an approved identity or business document exists,
-- and when the check passed.
--
-- It carries no document id, no type, no filename and no storage key. Knowing
-- a provider passed an identity check does not tell you whether they did it
-- with a passport or a PRC licence, which is right: the badge never claimed
-- to, and which document someone used is their business.
--
-- Like open_service_request_feed, this is an ordinary view, so it runs with
-- its owner's privileges and is not itself filtered by the policy on the
-- table beneath it. That is the whole mechanism: one carefully chosen set of
-- columns is published, instead of loosening a policy that guards the rest.
-- ===========================================================================

CREATE VIEW public.provider_public_verification AS
SELECT
  d.provider_id,

  -- Any government-issued proof of the person. A tradesperson is far more
  -- likely to hold a PRC licence or a TESDA certificate than a passport, and
  -- all three establish who they are. Kept in step with IDENTITY_DOCUMENTS in
  -- src/providers/verification.ts.
  bool_or(
    d.document_type IN ('GOVERNMENT_ID', 'PRC_LICENSE', 'TESDA_CERTIFICATE')
  ) AS identity_verified,

  -- The earliest approval: that is when the check was actually passed, not
  -- when the most recent supporting document happened to be filed.
  min(d.reviewed_at) FILTER (
    WHERE d.document_type IN ('GOVERNMENT_ID', 'PRC_LICENSE', 'TESDA_CERTIFICATE')
  ) AS identity_verified_at,

  -- Narrower on purpose: only a permit shows a registered business.
  bool_or(d.document_type = 'BUSINESS_PERMIT') AS business_verified,
  min(d.reviewed_at) FILTER (
    WHERE d.document_type = 'BUSINESS_PERMIT'
  ) AS business_verified_at

FROM public.provider_documents d
-- Approved, and not a document that has since lapsed. A badge must not
-- outlive the evidence behind it.
WHERE d.status = 'APPROVED'
  AND (d.expires_at IS NULL OR d.expires_at > now())
GROUP BY d.provider_id;

COMMENT ON VIEW public.provider_public_verification IS
  'Derived verification badges for public profiles. Deliberately excludes document ids, types, filenames, storage keys and rejection reasons.';

GRANT SELECT ON public.provider_public_verification TO fixitph_app;
