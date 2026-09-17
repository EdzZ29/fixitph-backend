import { Injectable } from '@nestjs/common';
import {
  Prisma,
  RequestStatus,
  UserRole,
  VerificationStatus,
} from '@prisma/client';
import { ApiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, type Paginated } from '../common/dto/pagination.dto';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import type { CreateRequestDto } from './dto/create-request.dto';
import type { ListRequestsDto } from './dto/list-requests.dto';
import type { UpdateRequestStatusDto } from './dto/update-request-status.dto';

/**
 * Which status transitions are legal, and who may make them. Encoding this as
 * data rather than as scattered ifs means the whole lifecycle is readable in
 * one place and the guard cannot drift from the documentation.
 */
const TRANSITIONS: Record<
  RequestStatus,
  Partial<Record<RequestStatus, ('customer' | 'provider' | 'admin')[]>>
> = {
  DRAFT: {
    OPEN: ['customer', 'admin'],
    CANCELLED: ['customer', 'admin'],
  },
  OPEN: {
    QUOTED: ['provider', 'admin'],
    CANCELLED: ['customer', 'admin'],
    EXPIRED: ['admin'],
  },
  QUOTED: {
    ACCEPTED: ['customer', 'admin'],
    CANCELLED: ['customer', 'admin'],
    EXPIRED: ['admin'],
  },
  ACCEPTED: {
    BOOKED: ['customer', 'admin'],
    CANCELLED: ['customer', 'admin'],
  },
  BOOKED: {
    CLOSED: ['customer', 'provider', 'admin'],
  },
  CANCELLED: {},
  EXPIRED: {},
  CLOSED: {},
};

@Injectable()
export class RequestsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Nothing here is cached. Requests are auth-scoped and change the moment a
   * quote lands, so a stale read would show a customer the wrong picture.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateRequestDto,
  ): Promise<unknown> {
    const category = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, isActive: true },
      select: { id: true },
    });
    if (!category)
      throw ApiError.badRequest('CATEGORY_NOT_FOUND', 'Unknown category.');

    // Business rule 2: a direct request can only go to a provider who is
    // verified, not suspended, and open for work.
    if (dto.providerId) {
      const provider = await this.prisma.provider.findFirst({
        where: { id: dto.providerId, deletedAt: null },
        select: {
          id: true,
          suspendedAt: true,
          verificationStatus: true,
          isAcceptingBookings: true,
        },
      });
      if (!provider)
        throw ApiError.badRequest('PROVIDER_NOT_FOUND', 'Unknown provider.');
      if (
        provider.suspendedAt ||
        provider.verificationStatus !== VerificationStatus.APPROVED
      ) {
        throw ApiError.forbidden(
          'PROVIDER_UNAVAILABLE',
          'That provider is not taking requests right now.',
        );
      }
      if (!provider.isAcceptingBookings) {
        throw ApiError.conflict(
          'PROVIDER_NOT_ACCEPTING',
          'That provider has paused new bookings.',
        );
      }
    }

    if (dto.serviceId) {
      const service = await this.prisma.service.findFirst({
        where: { id: dto.serviceId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true, providerId: true },
      });
      if (!service)
        throw ApiError.badRequest('SERVICE_NOT_FOUND', 'Unknown service.');
      if (dto.providerId && service.providerId !== dto.providerId) {
        throw ApiError.badRequest(
          'SERVICE_PROVIDER_MISMATCH',
          'That service does not belong to the chosen provider.',
        );
      }
    }

    return this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.serviceRequest.create({
        data: {
          customerId: user.id,
          providerId: dto.providerId ?? null,
          serviceId: dto.serviceId ?? null,
          categoryId: dto.categoryId,
          title: dto.title,
          description: dto.description,
          urgency: dto.urgency,
          preferredAt: dto.preferredAt ? new Date(dto.preferredAt) : null,
          budgetMin: dto.budgetMin ?? null,
          budgetMax: dto.budgetMax ?? null,
          city: dto.city,
          barangay: dto.barangay ?? null,
          addressLine1: dto.addressLine1 ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          status: RequestStatus.OPEN,
          // Open requests go stale. 14 days keeps the feed honest.
          expiresAt: new Date(Date.now() + 14 * 86_400_000),
        },
        select: this.detailSelect(),
      }),
    );
  }

  /**
   * A customer sees their own requests. A provider sees requests addressed to
   * them plus ones they have quoted. Row level security enforces the same
   * thing underneath, so a mistake here cannot leak another customer's job.
   */
  async list(
    user: AuthenticatedUser,
    dto: ListRequestsDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const scope: Prisma.ServiceRequestWhereInput =
        user.role === UserRole.ADMIN
          ? {}
          : user.role === UserRole.PROVIDER && user.providerId
            ? {
                OR: [
                  { providerId: user.providerId },
                  { quotes: { some: { providerId: user.providerId } } },
                ],
              }
            : { customerId: user.id };

      const where: Prisma.ServiceRequestWhereInput = {
        ...scope,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.city
          ? { city: { equals: dto.city, mode: 'insensitive' } }
          : {}),
      };

      const [items, total] = await Promise.all([
        tx.serviceRequest.findMany({
          where,
          select: this.listSelect(),
          orderBy: { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.serviceRequest.count({ where }),
      ]);

      return paginate(items, total, dto);
    });
  }

  /**
   * Broadcast requests a provider can pick up. Served from the
   * open_service_request_feed view, which carries no customer identity, no
   * street address and no coordinates.
   */
  async feed(
    user: AuthenticatedUser,
    dto: ListRequestsDto,
  ): Promise<Paginated<unknown>> {
    if (!user.providerId) {
      throw ApiError.forbidden(
        'NO_PROVIDER_PROFILE',
        'Only providers can browse open requests.',
      );
    }

    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const city = dto.city ?? null;
      const categoryId = dto.categoryId ?? null;

      const items = await tx.$queryRaw<unknown[]>`
        SELECT * FROM open_service_request_feed
        WHERE (${city}::text IS NULL OR lower(city) = lower(${city}::text))
          AND (${categoryId}::uuid IS NULL OR category_id = ${categoryId}::uuid)
        ORDER BY created_at DESC
        LIMIT ${dto.limit} OFFSET ${dto.skip}
      `;

      const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM open_service_request_feed
        WHERE (${city}::text IS NULL OR lower(city) = lower(${city}::text))
          AND (${categoryId}::uuid IS NULL OR category_id = ${categoryId}::uuid)
      `;

      return paginate(items, Number(count), dto);
    });
  }

  async findOne(user: AuthenticatedUser, id: string): Promise<unknown> {
    const request = await this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.serviceRequest.findUnique({
        where: { id },
        select: this.detailSelect(),
      }),
    );
    if (!request) throw ApiError.notFound('REQUEST_NOT_FOUND');
    return request;
  }

  async updateStatus(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateRequestStatusDto,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const current = await tx.serviceRequest.findUnique({
        where: { id },
        select: { id: true, status: true, customerId: true, providerId: true },
      });
      if (!current) throw ApiError.notFound('REQUEST_NOT_FOUND');

      const actor = this.actorFor(user, current);
      const allowed = TRANSITIONS[current.status][dto.status];

      if (!allowed) {
        throw ApiError.conflict(
          'INVALID_STATUS_TRANSITION',
          `A request cannot go from ${current.status} to ${dto.status}.`,
        );
      }
      if (!allowed.includes(actor)) {
        throw ApiError.forbidden(
          'NOT_ALLOWED_TO_TRANSITION',
          `A ${actor} cannot move this request to ${dto.status}.`,
        );
      }

      return tx.serviceRequest.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.status === RequestStatus.CLOSED ||
          dto.status === RequestStatus.CANCELLED
            ? { closedAt: new Date() }
            : {}),
        },
        select: this.detailSelect(),
      });
    });
  }

  private actorFor(
    user: AuthenticatedUser,
    request: { customerId: string; providerId: string | null },
  ): 'customer' | 'provider' | 'admin' {
    if (user.role === UserRole.ADMIN) return 'admin';
    if (request.customerId === user.id) return 'customer';
    if (user.providerId && request.providerId === user.providerId)
      return 'provider';
    // Reachable only for a provider who quoted a broadcast request.
    if (user.providerId) return 'provider';
    throw ApiError.forbidden(
      'NOT_A_PARTY',
      'You are not party to that request.',
    );
  }

  private listSelect() {
    return {
      id: true,
      title: true,
      status: true,
      urgency: true,
      city: true,
      barangay: true,
      budgetMin: true,
      budgetMax: true,
      preferredAt: true,
      createdAt: true,
      expiresAt: true,
      category: { select: { id: true, name: true, slug: true } },
      provider: { select: { id: true, businessName: true, slug: true } },
      _count: { select: { quotes: true } },
    } satisfies Prisma.ServiceRequestSelect;
  }

  private detailSelect() {
    return {
      ...this.listSelect(),
      description: true,
      addressLine1: true,
      latitude: true,
      longitude: true,
      serviceId: true,
      customerId: true,
      quotes: {
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          notes: true,
          validUntil: true,
          estimatedDurationMinutes: true,
          createdAt: true,
          provider: {
            select: {
              id: true,
              businessName: true,
              slug: true,
              ratingAvg: true,
              ratingCount: true,
            },
          },
        },
        orderBy: { amount: 'asc' },
      },
    } satisfies Prisma.ServiceRequestSelect;
  }
}
