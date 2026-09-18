import { DocumentType, VerificationStatus } from '@prisma/client';

/**
 * What a verification badge on FixItPH actually means.
 *
 * The rule this file exists to enforce is the one in the brief: a badge says
 * a *specific check was carried out*, and nothing more. It is not a guarantee
 * of the provider's work, their prices, or any claim they make about
 * themselves. Every badge therefore ships with the sentence that says so, and
 * the public payload carries the disclaimer alongside the badges rather than
 * leaving it to whoever writes the page.
 *
 * Badges are derived, never stored. Identity and business verification are
 * already recorded as an administrator's approval of a particular document,
 * so computing them at read time means a badge cannot outlive the evidence
 * behind it: reject the document and the badge is gone on the next read. A
 * stored boolean would need a migration path for every way that evidence can
 * later be withdrawn, and would eventually disagree with it.
 */
export type VerificationBadge = 'EMAIL' | 'IDENTITY' | 'BUSINESS';

/**
 * Tiers, in the order a provider earns them. `level` is the highest tier
 * reached, and reaching one does not require the ones below it — a business
 * can be BUSINESS-verified before an administrator has looked at their ID —
 * so the badge list stays the precise answer and the level is only a summary.
 */
export type VerificationLevel = 'NONE' | 'BASIC' | 'IDENTITY' | 'BUSINESS';

export interface BadgeDetail {
  badge: VerificationBadge;
  /** Shown on the badge itself, e.g. "Identity Verified". */
  label: string;
  /** What was actually checked. Shown on hover, and in the badge legend. */
  means: string;
  earned: boolean;
  /** When the check passed. Null when it has not. */
  at: string | null;
}

/**
 * The documents that stand for each checked badge.
 *
 * Identity accepts any government-issued proof of the person: a national ID,
 * a PRC licence or a TESDA certificate all establish who someone is, and a
 * tradesperson is far more likely to hold the latter two. Business is
 * narrower on purpose — only a permit shows a registered business.
 */
const IDENTITY_DOCUMENTS: DocumentType[] = [
  DocumentType.GOVERNMENT_ID,
  DocumentType.PRC_LICENSE,
  DocumentType.TESDA_CERTIFICATE,
];

const BUSINESS_DOCUMENTS: DocumentType[] = [DocumentType.BUSINESS_PERMIT];

/** The one sentence that has to accompany any display of these badges. */
export const VERIFICATION_DISCLAIMER =
  'A badge means FixItPH checked that one thing and nothing else. It is not a guarantee of the provider’s work, their prices, or any claim they make. Always agree the job and the price before work starts.';

const MEANING: Record<VerificationBadge, { label: string; means: string }> = {
  EMAIL: {
    label: 'Email Verified',
    means:
      'They entered a code sent to their email address, so we know it reaches them.',
  },
  IDENTITY: {
    label: 'Identity Verified',
    means:
      'They submitted a government ID, PRC licence or TESDA certificate, and an administrator checked it against the name on the account.',
  },
  BUSINESS: {
    label: 'Business Verified',
    means:
      'They submitted business registration or a mayor’s permit, and an administrator checked it.',
  },
};

/**
 * Timestamps arrive as Date from Prisma and as ISO strings from the cache,
 * because a cached provider has been through JSON. Both are accepted, and
 * normalised below.
 *
 * This is not defensive padding: getting it wrong meant the first request for
 * a profile succeeded and every one after it threw, since only the cached
 * path produced strings.
 */
export type Timestamp = Date | string | null | undefined;

/**
 * What an administrator has approved, as two conclusions rather than a list
 * of documents.
 *
 * The documents are private — they are somebody's passport and their home
 * address — and provider_documents is under row level security to keep them
 * that way. A public profile cannot read them, and for a long time that meant
 * it silently concluded nothing had been checked. So the conclusion is
 * published separately, by the provider_public_verification view, and this is
 * the shape both paths agree on: the owner derives it from the documents they
 * are allowed to see, a public read takes it from the view.
 */
export interface VerificationApprovals {
  identityVerified: boolean;
  /**
   * When the check passed. Null is possible even when verified: approval is
   * the fact, the timestamp is presentation.
   */
  identityVerifiedAt: Timestamp;
  businessVerified: boolean;
  businessVerifiedAt: Timestamp;
}

/** Nothing approved — for a provider the view has no row for. */
export const NO_APPROVALS: VerificationApprovals = {
  identityVerified: false,
  identityVerifiedAt: null,
  businessVerified: false,
  businessVerifiedAt: null,
};

export interface VerificationInput {
  /**
   * Required rather than optional, because `complete` is meaningless without
   * it: an individual is fully checked with an ID, a business is not. A
   * default here would quietly mark half-checked businesses as complete.
   */
  providerType: ProviderType;
  emailVerifiedAt: Timestamp;
  approvals: VerificationApprovals;
}

/**
 * The same conclusion, worked out from the documents themselves.
 *
 * Used where the caller is allowed to see them — a provider looking at their
 * own account, an administrator reviewing it — so both paths go through one
 * definition of what counts, and the view and this function cannot drift
 * apart on what an identity document is.
 */
export function approvalsFromDocuments(
  documents: {
    documentType: DocumentType;
    status: VerificationStatus;
    reviewedAt: Timestamp;
    expiresAt?: Timestamp;
  }[],
): VerificationApprovals {
  const live = documents.filter((doc) => {
    if (doc.status !== VerificationStatus.APPROVED) return false;
    const expires = toDate(doc.expiresAt ?? null);
    // A badge must not outlive the evidence behind it.
    return !expires || expires > new Date();
  });

  const has = (types: DocumentType[]) =>
    live.some((doc) => types.includes(doc.documentType));

  // The earliest approval: that is when the check was actually passed.
  const earliest = (types: DocumentType[]): Date | null =>
    live
      .filter((doc) => types.includes(doc.documentType))
      .reduce<Date | null>((soonest, doc) => {
        const reviewed = toDate(doc.reviewedAt);
        if (!reviewed) return soonest;
        return !soonest || reviewed < soonest ? reviewed : soonest;
      }, null);

  return {
    identityVerified: has(IDENTITY_DOCUMENTS),
    identityVerifiedAt: earliest(IDENTITY_DOCUMENTS),
    businessVerified: has(BUSINESS_DOCUMENTS),
    businessVerifiedAt: earliest(BUSINESS_DOCUMENTS),
  };
}

/** One shape for a timestamp, whichever side it came from. */
function toDate(value: Timestamp): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface VerificationSummary {
  level: VerificationLevel;
  /**
   * Every check this provider's trading type calls for has been passed.
   *
   * Computed here rather than in each page, so that "fully verified" means
   * the same thing on a search card, a profile and a dashboard — and so that
   * adding a check to a trading type updates all of them at once.
   */
  complete: boolean;
  /** Every badge, earned or not, so a profile can show what is still missing. */
  badges: BadgeDetail[];
  /** Just the earned ones, for a compact row on a card. */
  earned: VerificationBadge[];
  disclaimer: string;
}

/**
 * Works out which badges a provider has. Pure, so it can be used on a list of
 * twenty search results without a query each.
 */
export function summariseVerification(
  input: VerificationInput,
): VerificationSummary {
  const at: Record<VerificationBadge, Date | null> = {
    EMAIL: toDate(input.emailVerifiedAt),
    IDENTITY: toDate(input.approvals.identityVerifiedAt),
    BUSINESS: toDate(input.approvals.businessVerifiedAt),
  };

  const earnedFlags: Record<VerificationBadge, boolean> = {
    EMAIL: toDate(input.emailVerifiedAt) !== null,
    IDENTITY: input.approvals.identityVerified,
    BUSINESS: input.approvals.businessVerified,
  };

  const badges: BadgeDetail[] = (
    ['EMAIL', 'IDENTITY', 'BUSINESS'] as VerificationBadge[]
  ).map((badge) => ({
    badge,
    label: MEANING[badge].label,
    means: MEANING[badge].means,
    earned: earnedFlags[badge],
    at: at[badge]?.toISOString() ?? null,
  }));

  return {
    complete: wantedBadges(input.providerType).every((b) => earnedFlags[b]),
    level: earnedFlags.BUSINESS
      ? 'BUSINESS'
      : earnedFlags.IDENTITY
        ? 'IDENTITY'
        : earnedFlags.EMAIL
          ? 'BASIC'
          : 'NONE',
    badges,
    earned: badges.filter((b) => b.earned).map((b) => b.badge),
    disclaimer: VERIFICATION_DISCLAIMER,
  };
}

export type ProviderType = 'INDIVIDUAL' | 'BUSINESS';

/** Which checks are asked of a provider trading this way. */
function wantedBadges(providerType: ProviderType): VerificationBadge[] {
  return providerType === 'BUSINESS'
    ? ['EMAIL', 'IDENTITY', 'BUSINESS']
    : // An individual is never asked for a business permit.
      ['EMAIL', 'IDENTITY'];
}

/** The documents a provider of this type still needs, for a checklist. */
export function documentsStillNeeded(
  providerType: ProviderType,
  summary: VerificationSummary,
): { badge: VerificationBadge; label: string; means: string }[] {
  const wanted = wantedBadges(providerType);

  return summary.badges
    .filter((b) => wanted.includes(b.badge) && !b.earned)
    .map(({ badge, label, means }) => ({ badge, label, means }));
}

/**
 * Anything that has been read with enough columns to work its badges out.
 *
 * Timestamps are widened to Timestamp because a provider that came back
 * through the cache has been through JSON; summariseVerification normalises
 * both shapes.
 */
export interface VerifiableProvider {
  id: string;
  providerType: ProviderType;
  user?: { emailVerifiedAt: Timestamp } | null;
}

/**
 * Swaps the evidence for the conclusion.
 *
 * The account's email timestamp is read to derive the badges and is then
 * dropped, so the payload carries what was checked rather than the material
 * it was checked against. Approvals are passed in, because where they can be
 * read from depends on who is asking.
 */
export function attachVerification<T extends VerifiableProvider>(
  provider: T,
  approvals: VerificationApprovals = NO_APPROVALS,
): Omit<T, 'user'> & { verification: VerificationSummary } {
  const { user, ...rest } = provider;
  return {
    ...rest,
    verification: summariseVerification({
      providerType: provider.providerType,
      emailVerifiedAt: user?.emailVerifiedAt ?? null,
      approvals,
    }),
  };
}
