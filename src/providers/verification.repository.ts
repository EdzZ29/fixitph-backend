import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NO_APPROVALS, type VerificationApprovals } from './verification';

/**
 * Reading verification badges for a public payload.
 *
 * provider_documents is under row level security and only its owner or an
 * administrator may read it, which is right — the rows hold a passport scan
 * and a home address. It also meant a public profile, read with no session,
 * saw no documents and concluded nothing had been checked. Every provider on
 * the site showed at most "Email Verified".
 *
 * provider_public_verification is a view over the same table that publishes
 * the conclusion and nothing else: whether an approved identity or business
 * document exists, and when it was approved. No id, no type, no filename, no
 * storage key. It is an ordinary view, so it runs with its owner's rights
 * rather than the caller's, which is the whole mechanism — one deliberately
 * chosen set of columns is published instead of loosening the policy that
 * guards everything else in the table.
 */

/**
 * The ids are cast in the parameter rather than the column.
 *
 * Prisma binds a string as text, and `uuid = text` has no operator, so the
 * query simply fails. Casting the column instead would work but would rule
 * out an index scan on it, which is the wrong half to give up.
 */
function castToUuid(ids: string[]): Prisma.Sql[] {
  return ids.map((id) => Prisma.sql`${id}::uuid`);
}

interface Row {
  provider_id: string;
  identity_verified: boolean;
  identity_verified_at: Date | null;
  business_verified: boolean;
  business_verified_at: Date | null;
}

/**
 * Badges for a page of providers, in one query rather than one each.
 *
 * Providers with nothing approved have no row in the view, so the caller
 * should fall back to NO_APPROVALS — which `get` below does.
 */
export async function readApprovals(
  prisma: PrismaService,
  providerIds: string[],
): Promise<Map<string, VerificationApprovals>> {
  const unique = [...new Set(providerIds)];
  if (!unique.length) return new Map();

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT provider_id,
           identity_verified,
           identity_verified_at,
           business_verified,
           business_verified_at
    FROM provider_public_verification
    WHERE provider_id IN (${Prisma.join(castToUuid(unique))})
  `;

  return new Map(
    rows.map((row) => [
      row.provider_id,
      {
        identityVerified: row.identity_verified,
        identityVerifiedAt: row.identity_verified_at,
        businessVerified: row.business_verified,
        businessVerifiedAt: row.business_verified_at,
      },
    ]),
  );
}

/** No row in the view means nothing has been approved yet. */
export function approvalsFor(
  approvals: Map<string, VerificationApprovals>,
  providerId: string,
): VerificationApprovals {
  return approvals.get(providerId) ?? NO_APPROVALS;
}
