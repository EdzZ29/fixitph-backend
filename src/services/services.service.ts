import { Injectable } from '@nestjs/common';
import {
  Prisma,
  PricingType,
  ServiceStatus,
  VerificationStatus,
} from '@prisma/client';
import { ApiError } from '../common/errors';
import { CacheService, TTL } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, type Paginated } from '../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../common/types';
import type { CreateServiceDto } from './dto/create-service.dto';
import type { UpdateServiceDto } from './dto/update-service.dto';
import type { ListServicesDto } from './dto/list-services.dto';

const PUBLIC_SERVICE_SELECT = {
  id: true,
  title: true,
  slug: true,
  description: true,
  pricingType: true,
  price: true,
  priceUnit: true,
  minPrice: true,
  maxPrice: true,
  currency: true,
  durationMinutes: true,
  status: true,
  createdAt: true,
  category: { select: { id: true, name: true, slug: true } },
  provider: {
    select: {
      id: true,
      slug: true,
      businessName: true,
      baseCity: true,
      baseBarangay: true,
      ratingAvg: true,
      ratingCount: true,
      verificationStatus: true,
    },
  },
} satisfies Prisma.ServiceSelect;

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async list(dto: ListServicesDto): Promise<Paginated<unknown>> {
    const key = await this.cache.listKey('services', { ...dto });

    return this.cache.wrap(key, TTL.LIST, async () => {
      const where: Prisma.ServiceWhereInput = {
        deletedAt: null,
        status: ServiceStatus.ACTIVE,
        provider: {
          deletedAt: null,
          suspendedAt: null,
          verificationStatus: VerificationStatus.APPROVED,
          ...(dto.city
            ? { baseCity: { equals: dto.city, mode: 'insensitive' } }
            : {}),
        },
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.providerId ? { providerId: dto.providerId } : {}),
        ...(dto.pricingType ? { pricingType: dto.pricingType } : {}),
        ...(dto.minPrice !== undefined || dto.maxPrice !== undefined
          ? {
              price: {
                ...(dto.minPrice !== undefined ? { gte: dto.minPrice } : {}),
                ...(dto.maxPrice !== undefined ? { lte: dto.maxPrice } : {}),
              },
            }
          : {}),
        ...(dto.q
          ? {
              OR: [
                { title: { contains: dto.q, mode: 'insensitive' } },
                { description: { contains: dto.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const [items, total] = await this.prisma.$transaction([
        this.prisma.service.findMany({
          where,
          select: PUBLIC_SERVICE_SELECT,
          orderBy:
            dto.sort === 'price_asc'
              ? [{ price: 'asc' }]
              : dto.sort === 'price_desc'
                ? [{ price: 'desc' }]
                : [{ provider: { ratingAvg: 'desc' } }, { createdAt: 'desc' }],
          skip: dto.skip,
          take: dto.limit,
        }),
        this.prisma.service.count({ where }),
      ]);

      return paginate(items, total, dto);
    });
  }

  async findOne(id: string): Promise<unknown> {
    const key = this.cache.detailKey('services', id);
    const service = await this.cache.wrap(key, TTL.DETAIL, async () =>
      this.prisma.service.findFirst({
        where: { id, deletedAt: null },
        select: {
          ...PUBLIC_SERVICE_SELECT,
          images: {
            select: {
              id: true,
              altText: true,
              position: true,
              width: true,
              height: true,
            },
            orderBy: { position: 'asc' },
          },
        },
      }),
    );
    if (!service)
      throw ApiError.notFound(
        'SERVICE_NOT_FOUND',
        'That service does not exist.',
      );
    return service;
  }

  async create(
    user: AuthenticatedUser,
    dto: CreateServiceDto,
  ): Promise<unknown> {
    const providerId = this.requireOwnProvider(user);

    // Business rule 1: only a verified provider can put a live listing up.
    const provider = await this.prisma.provider.findFirst({
      where: { id: providerId, deletedAt: null },
      select: { verificationStatus: true, suspendedAt: true },
    });
    if (!provider) throw ApiError.notFound('PROVIDER_NOT_FOUND');
    if (provider.suspendedAt) {
      throw ApiError.forbidden(
        'PROVIDER_SUSPENDED',
        'This provider account is suspended.',
      );
    }
    if (
      dto.status === ServiceStatus.ACTIVE &&
      provider.verificationStatus !== VerificationStatus.APPROVED
    ) {
      throw ApiError.forbidden(
        'PROVIDER_NOT_VERIFIED',
        'Your documents have to be approved before a service can go live. Save it as a draft for now.',
      );
    }

    this.assertPricingCoherent(dto);

    const category = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, isActive: true },
      select: { id: true },
    });
    if (!category)
      throw ApiError.badRequest('CATEGORY_NOT_FOUND', 'Unknown category.');

    const slug = await this.uniqueSlug(providerId, dto.title);

    const service = await this.prisma.service.create({
      data: {
        providerId,
        categoryId: dto.categoryId,
        title: dto.title,
        slug,
        description: dto.description,
        pricingType: dto.pricingType,
        price:
          dto.pricingType === PricingType.QUOTE_REQUIRED ? null : dto.price,
        priceUnit: dto.priceUnit ?? null,
        minPrice: dto.minPrice ?? null,
        maxPrice: dto.maxPrice ?? null,
        durationMinutes: dto.durationMinutes ?? null,
        status: dto.status ?? ServiceStatus.DRAFT,
      },
      select: PUBLIC_SERVICE_SELECT,
    });

    await this.cache.invalidateLists('services');
    await this.cache.invalidateResource('providers', providerId);
    return service;
  }

  async update(id: string, dto: UpdateServiceDto): Promise<unknown> {
    const existing = await this.prisma.service.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        providerId: true,
        pricingType: true,
        price: true,
        priceUnit: true,
        provider: { select: { verificationStatus: true } },
      },
    });
    if (!existing) throw ApiError.notFound('SERVICE_NOT_FOUND');

    const merged = {
      pricingType: dto.pricingType ?? existing.pricingType,
      price:
        dto.price !== undefined
          ? dto.price
          : Number(existing.price ?? 0) || undefined,
      priceUnit:
        dto.priceUnit !== undefined
          ? dto.priceUnit
          : (existing.priceUnit ?? undefined),
      minPrice: dto.minPrice,
      maxPrice: dto.maxPrice,
    };
    this.assertPricingCoherent(merged);

    if (
      dto.status === ServiceStatus.ACTIVE &&
      existing.provider.verificationStatus !== VerificationStatus.APPROVED
    ) {
      throw ApiError.forbidden(
        'PROVIDER_NOT_VERIFIED',
        'Your documents have to be approved before a service can go live.',
      );
    }

    const service = await this.prisma.service.update({
      where: { id },
      data: {
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.pricingType !== undefined
          ? { pricingType: dto.pricingType }
          : {}),
        ...(dto.price !== undefined
          ? {
              price:
                merged.pricingType === PricingType.QUOTE_REQUIRED
                  ? null
                  : dto.price,
            }
          : merged.pricingType === PricingType.QUOTE_REQUIRED
            ? { price: null }
            : {}),
        ...(dto.priceUnit !== undefined ? { priceUnit: dto.priceUnit } : {}),
        ...(dto.minPrice !== undefined ? { minPrice: dto.minPrice } : {}),
        ...(dto.maxPrice !== undefined ? { maxPrice: dto.maxPrice } : {}),
        ...(dto.durationMinutes !== undefined
          ? { durationMinutes: dto.durationMinutes }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
      select: PUBLIC_SERVICE_SELECT,
    });

    await this.cache.invalidateResource('services', id);
    await this.cache.invalidateResource('providers', existing.providerId);
    return service;
  }

  /** Soft delete, because bookings reference the service. */
  async remove(id: string): Promise<{ id: string; deletedAt: Date }> {
    const service = await this.prisma.service.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, providerId: true },
    });
    if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

    const now = new Date();
    await this.prisma.service.update({
      where: { id },
      data: { deletedAt: now, status: ServiceStatus.ARCHIVED },
    });

    await this.cache.invalidateResource('services', id);
    await this.cache.invalidateResource('providers', service.providerId);
    return { id, deletedAt: now };
  }

  // -- helpers ---------------------------------------------------------------

  /**
   * Mirrors the CHECK constraints so the caller gets a readable 400 instead of
   * a database error. The constraints are still the thing that guarantees it.
   */
  private assertPricingCoherent(dto: {
    pricingType: PricingType;
    price?: number | null;
    priceUnit?: string | null;
    minPrice?: number | null;
    maxPrice?: number | null;
  }): void {
    if (dto.pricingType === PricingType.QUOTE_REQUIRED) {
      if (dto.price != null) {
        throw ApiError.badRequest(
          'PRICE_NOT_ALLOWED',
          'A quote-only service cannot carry a fixed price.',
        );
      }
    } else if (dto.price == null) {
      throw ApiError.badRequest(
        'PRICE_REQUIRED',
        'A price is required unless the pricing type is QUOTE_REQUIRED.',
      );
    }

    if (
      (dto.pricingType === PricingType.HOURLY ||
        dto.pricingType === PricingType.PER_UNIT) &&
      !dto.priceUnit
    ) {
      throw ApiError.badRequest(
        'PRICE_UNIT_REQUIRED',
        'Hourly and per-unit pricing need the unit named, for example "hour" or "split type unit".',
      );
    }

    if (
      dto.minPrice != null &&
      dto.maxPrice != null &&
      dto.minPrice > dto.maxPrice
    ) {
      throw ApiError.badRequest(
        'PRICE_BAND_INVALID',
        'The minimum price is above the maximum.',
      );
    }
  }

  private requireOwnProvider(user: AuthenticatedUser): string {
    if (!user.providerId) {
      throw ApiError.forbidden(
        'NO_PROVIDER_PROFILE',
        'Create a provider profile before adding services.',
      );
    }
    return user.providerId;
  }

  private async uniqueSlug(providerId: string, title: string): Promise<string> {
    const base =
      title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 140) || 'service';

    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      const clash = await this.prisma.service.findFirst({
        where: { providerId, slug: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}
