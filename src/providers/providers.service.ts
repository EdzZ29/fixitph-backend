import { Injectable } from '@nestjs/common';
import { Prisma, UserRole, VerificationStatus } from '@prisma/client';
import { ApiError } from '../common/errors';
import { CacheService, TTL } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, type Paginated } from '../common/dto/pagination.dto';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import type { CreateProviderDto } from './dto/create-provider.dto';
import type { UpdateProviderDto } from './dto/update-provider.dto';
import type { SearchProvidersDto } from './dto/search-providers.dto';

/**
 * Tells a uuid path parameter from a slug. Slugs are generated from the
 * business name and lowercased, so they never take this shape.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fields safe to return on a public listing. No user id, no exact address. */
const PUBLIC_PROVIDER_SELECT = {
  id: true,
  slug: true,
  businessName: true,
  headline: true,
  bio: true,
  yearsExperience: true,
  verificationStatus: true,
  verifiedAt: true,
  baseCity: true,
  baseBarangay: true,
  serviceRadiusKm: true,
  ratingAvg: true,
  ratingCount: true,
  completedJobsCount: true,
  responseTimeMinutes: true,
  acceptsEmergency: true,
  isAcceptingBookings: true,
  paymentMethods: true,
  createdAt: true,
} satisfies Prisma.ProviderSelect;

@Injectable()
export class ProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // -- read ------------------------------------------------------------------

  async search(dto: SearchProvidersDto): Promise<Paginated<unknown>> {
    const key = await this.cache.listKey('providers', { ...dto });

    return this.cache.wrap(key, TTL.LIST, async () => {
      const where: Prisma.ProviderWhereInput = {
        deletedAt: null,
        suspendedAt: null,
        // Only providers who have actually been checked are discoverable.
        verificationStatus: VerificationStatus.APPROVED,
        ...(dto.city
          ? { baseCity: { equals: dto.city, mode: 'insensitive' } }
          : {}),
        ...(dto.barangay
          ? { baseBarangay: { equals: dto.barangay, mode: 'insensitive' } }
          : {}),
        ...(dto.minRating !== undefined
          ? { ratingAvg: { gte: dto.minRating } }
          : {}),
        ...(dto.acceptsEmergency !== undefined
          ? { acceptsEmergency: dto.acceptsEmergency }
          : {}),
        ...(dto.availableNow ? { isAcceptingBookings: true } : {}),
        ...(dto.q
          ? {
              OR: [
                { businessName: { contains: dto.q, mode: 'insensitive' } },
                { headline: { contains: dto.q, mode: 'insensitive' } },
              ],
            }
          : {}),
        // Category and price filters reach through the provider's live
        // services, so "aircon under 500" means they actually list such a job.
        ...(dto.categoryId ||
        dto.maxPrice !== undefined ||
        dto.minPrice !== undefined
          ? {
              services: {
                some: {
                  deletedAt: null,
                  status: 'ACTIVE',
                  ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
                  ...(dto.maxPrice !== undefined || dto.minPrice !== undefined
                    ? {
                        price: {
                          ...(dto.minPrice !== undefined
                            ? { gte: dto.minPrice }
                            : {}),
                          ...(dto.maxPrice !== undefined
                            ? { lte: dto.maxPrice }
                            : {}),
                        },
                      }
                    : {}),
                },
              },
            }
          : {}),
      };

      const orderBy = this.orderFor(dto.sort);

      const [items, total] = await this.prisma.$transaction([
        this.prisma.provider.findMany({
          where,
          select: {
            ...PUBLIC_PROVIDER_SELECT,
            services: {
              where: { deletedAt: null, status: 'ACTIVE' },
              select: {
                id: true,
                title: true,
                slug: true,
                pricingType: true,
                price: true,
                priceUnit: true,
                categoryId: true,
              },
              orderBy: { price: 'asc' },
              take: 3,
            },
          },
          orderBy,
          skip: dto.skip,
          take: dto.limit,
        }),
        this.prisma.provider.count({ where }),
      ]);

      return paginate(items, total, dto);
    });
  }

  /**
   * Looked up by id or by slug. A public profile is linked by slug, because
   * /providers/aircon-pro-butuan is a better thing to share than a uuid, and
   * slug is unique. The two are told apart by shape rather than by trying one
   * and falling back, so a miss is a single query.
   */
  async findOne(idOrSlug: string): Promise<unknown> {
    const byId = UUID_PATTERN.test(idOrSlug);
    const key = this.cache.detailKey('providers', idOrSlug);

    const provider = await this.cache.wrap(key, TTL.DETAIL, async () =>
      this.prisma.provider.findFirst({
        where: byId
          ? { id: idOrSlug, deletedAt: null }
          : { slug: idOrSlug, deletedAt: null },
        select: {
          ...PUBLIC_PROVIDER_SELECT,
          services: {
            where: { deletedAt: null, status: 'ACTIVE' },
            select: {
              id: true,
              title: true,
              slug: true,
              description: true,
              pricingType: true,
              price: true,
              priceUnit: true,
              minPrice: true,
              maxPrice: true,
              durationMinutes: true,
              category: { select: { id: true, name: true, slug: true } },
              images: {
                select: { id: true, position: true },
                orderBy: { position: 'asc' },
              },
            },
          },
          serviceAreas: {
            select: {
              id: true,
              areaType: true,
              city: true,
              barangay: true,
              radiusKm: true,
            },
          },
          availability: {
            select: {
              dayOfWeek: true,
              startTime: true,
              endTime: true,
              isClosed: true,
            },
          },
          portfolioItems: {
            select: {
              id: true,
              title: true,
              description: true,
              completedAt: true,
            },
            orderBy: { position: 'asc' },
            take: 12,
          },
        },
      }),
    );

    if (!provider)
      throw ApiError.notFound(
        'PROVIDER_NOT_FOUND',
        'That provider does not exist.',
      );
    return provider;
  }

  // -- write -----------------------------------------------------------------

  async create(
    user: AuthenticatedUser,
    dto: CreateProviderDto,
  ): Promise<unknown> {
    if (user.providerId) {
      throw ApiError.conflict(
        'PROVIDER_ALREADY_EXISTS',
        'This account already has a provider profile.',
      );
    }

    const slug = await this.uniqueSlug(dto.businessName);

    const provider = await this.prisma.$transaction(async (tx) => {
      // A customer who opens a provider profile becomes a provider. The role
      // is what every downstream guard keys on.
      await tx.user.update({
        where: { id: user.id },
        data: { role: UserRole.PROVIDER },
      });

      return tx.provider.create({
        data: {
          userId: user.id,
          businessName: dto.businessName,
          slug,
          headline: dto.headline ?? null,
          bio: dto.bio ?? null,
          yearsExperience: dto.yearsExperience ?? null,
          baseCity: dto.baseCity,
          baseBarangay: dto.baseBarangay ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          serviceRadiusKm: dto.serviceRadiusKm ?? null,
          acceptsEmergency: dto.acceptsEmergency ?? false,
          paymentMethods: dto.paymentMethods ?? [],
          // Always starts unverified. Only the admin verification flow can
          // move this, and it writes an admin_actions row when it does.
          verificationStatus: VerificationStatus.UNVERIFIED,
        },
        select: PUBLIC_PROVIDER_SELECT,
      });
    });

    await this.cache.invalidateLists('providers');
    return provider;
  }

  async update(id: string, dto: UpdateProviderDto): Promise<unknown> {
    const exists = await this.prisma.provider.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!exists) throw ApiError.notFound('PROVIDER_NOT_FOUND');

    const provider = await this.prisma.provider.update({
      where: { id },
      data: {
        ...(dto.businessName !== undefined
          ? { businessName: dto.businessName }
          : {}),
        ...(dto.headline !== undefined ? { headline: dto.headline } : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
        ...(dto.yearsExperience !== undefined
          ? { yearsExperience: dto.yearsExperience }
          : {}),
        ...(dto.baseCity !== undefined ? { baseCity: dto.baseCity } : {}),
        ...(dto.baseBarangay !== undefined
          ? { baseBarangay: dto.baseBarangay }
          : {}),
        ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
        ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
        ...(dto.serviceRadiusKm !== undefined
          ? { serviceRadiusKm: dto.serviceRadiusKm }
          : {}),
        ...(dto.acceptsEmergency !== undefined
          ? { acceptsEmergency: dto.acceptsEmergency }
          : {}),
        ...(dto.isAcceptingBookings !== undefined
          ? { isAcceptingBookings: dto.isAcceptingBookings }
          : {}),
        ...(dto.paymentMethods !== undefined
          ? { paymentMethods: dto.paymentMethods }
          : {}),
      },
      select: PUBLIC_PROVIDER_SELECT,
    });

    // Invalidate immediately rather than waiting out the 5 minute TTL, so a
    // provider never sees their own edit missing from their profile.
    await this.cache.invalidateResource('providers', id);
    await this.cache.invalidateLists('services');
    return provider;
  }

  /**
   * Soft delete. The row stays for the booking history that references it.
   *
   * Takes the caller because the active-booking guard below has to actually
   * see those bookings: `bookings` is under RLS, and counting with no session
   * context returned zero every time — which let a provider close a profile
   * with live jobs on it.
   */
  async remove(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ id: string; deletedAt: Date }> {
    const provider = await this.prisma.provider.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!provider) throw ApiError.notFound('PROVIDER_NOT_FOUND');

    const active = await this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.booking.count({
        where: {
          providerId: id,
          deletedAt: null,
          status: { in: ['PENDING_CONFIRMATION', 'CONFIRMED', 'IN_PROGRESS'] },
        },
      }),
    );
    if (active > 0) {
      throw ApiError.conflict(
        'PROVIDER_HAS_ACTIVE_BOOKINGS',
        `Finish or cancel ${active} active booking(s) before closing this profile.`,
      );
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.provider.update({
        where: { id },
        data: { deletedAt: now, isAcceptingBookings: false },
      }),
      this.prisma.service.updateMany({
        where: { providerId: id, deletedAt: null },
        data: { deletedAt: now, status: 'ARCHIVED' },
      }),
    ]);

    await this.cache.invalidateResource('providers', id);
    await this.cache.invalidateLists('services');
    return { id, deletedAt: now };
  }

  // -- helpers ---------------------------------------------------------------

  private orderFor(
    sort: SearchProvidersDto['sort'],
  ): Prisma.ProviderOrderByWithRelationInput[] {
    switch (sort) {
      case 'rating':
        return [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }];
      case 'jobs':
        return [{ completedJobsCount: 'desc' }];
      case 'newest':
        return [{ createdAt: 'desc' }];
      case 'response':
        return [{ responseTimeMinutes: 'asc' }];
      default:
        // Default ranking favours providers with a real track record over a
        // brand new profile with a single five star review.
        return [
          { ratingCount: 'desc' },
          { ratingAvg: 'desc' },
          { createdAt: 'desc' },
        ];
    }
  }

  private async uniqueSlug(businessName: string): Promise<string> {
    const base =
      businessName
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 140) || 'provider';

    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      const clash = await this.prisma.provider.findFirst({
        where: { slug: { equals: candidate, mode: 'insensitive' } },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}
