import { Injectable } from '@nestjs/common';
import {
  BookingStatus,
  NotificationType,
  Prisma,
  ReportTargetType,
  UserRole,
} from '@prisma/client';
import { ApiError } from '../common/errors';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, type Paginated } from '../common/dto/pagination.dto';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import type { CreateReviewDto } from './dto/create-review.dto';
import type { ListReviewsDto } from './dto/list-reviews.dto';
import type { ReportReviewDto } from './dto/report-review.dto';
import type { UpdateReviewDto } from './dto/update-review.dto';

const PUBLIC_REVIEW_SELECT = {
  id: true,
  rating: true,
  punctualityRating: true,
  qualityRating: true,
  valueRating: true,
  comment: true,
  providerResponse: true,
  providerRespondedAt: true,
  createdAt: true,
  updatedAt: true,
  // Length only. The contents are the customer's, and exposing every previous
  // wording of a complaint is not the point; that it was edited is.
  editHistory: false,
  author: {
    select: { profile: { select: { displayName: true, firstName: true } } },
  },
  booking: {
    select: {
      id: true,
      completedAt: true,
      service: { select: { title: true } },
    },
  },
} satisfies Prisma.ReviewSelect;

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Business rule 7: one review, by the customer, on their own COMPLETED
   * booking. Every clause here is mirrored by the reviews_guard_insert trigger
   * and the unique index on booking_id, which are the real guarantees.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateReviewDto,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const booking = await tx.booking.findFirst({
        where: { id: dto.bookingId, deletedAt: null },
        select: {
          id: true,
          status: true,
          customerId: true,
          providerId: true,
          completedAt: true,
          review: { select: { id: true } },
          provider: { select: { userId: true } },
        },
      });
      if (!booking) throw ApiError.notFound('BOOKING_NOT_FOUND');

      if (booking.customerId !== user.id) {
        throw ApiError.forbidden(
          'NOT_BOOKING_CUSTOMER',
          'Only the customer on the booking can review it.',
        );
      }
      if (booking.status !== BookingStatus.COMPLETED) {
        throw ApiError.conflict(
          'BOOKING_NOT_COMPLETED',
          'You can review a job once it is marked finished.',
        );
      }
      if (booking.review) {
        throw ApiError.conflict(
          'REVIEW_ALREADY_EXISTS',
          'You have already reviewed this booking. Edit that review instead.',
        );
      }

      const review = await tx.review.create({
        data: {
          bookingId: dto.bookingId,
          authorId: user.id,
          providerId: booking.providerId,
          rating: dto.rating,
          punctualityRating: dto.punctualityRating ?? null,
          qualityRating: dto.qualityRating ?? null,
          valueRating: dto.valueRating ?? null,
          comment: dto.comment ?? null,
        },
        select: PUBLIC_REVIEW_SELECT,
      });

      await this.recomputeRating(tx, booking.providerId);

      if (booking.provider?.userId) {
        await tx.notification.create({
          data: {
            userId: booking.provider.userId,
            type: NotificationType.REVIEW_RECEIVED,
            title: 'You have a new review',
            body: `${dto.rating} out of 5 on a finished job.`,
            data: { bookingId: booking.id },
          },
        });
      }

      await this.cache.invalidateResource('providers', booking.providerId);
      return review;
    });
  }

  async listForProvider(
    providerId: string,
    dto: ListReviewsDto,
  ): Promise<Paginated<unknown>> {
    // Public, but never cached: a rating people are about to act on should be
    // the current one, and the query is cheap and well indexed.
    return this.prisma.withoutUser(async (tx) => {
      const where: Prisma.ReviewWhereInput = {
        providerId,
        deletedAt: null,
        isHidden: false,
        ...(dto.minRating !== undefined
          ? { rating: { gte: dto.minRating } }
          : {}),
      };

      const [items, total, breakdown] = await Promise.all([
        tx.review.findMany({
          where,
          select: PUBLIC_REVIEW_SELECT,
          orderBy:
            dto.sort === 'rating' ? { rating: 'desc' } : { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.review.count({ where }),
        tx.review.groupBy({
          by: ['rating'],
          where: { providerId, deletedAt: null, isHidden: false },
          _count: { rating: true },
        }),
      ]);

      return {
        ...paginate(items, total, dto),
        breakdown: [5, 4, 3, 2, 1].map((stars) => ({
          stars,
          count: breakdown.find((b) => b.rating === stars)?._count.rating ?? 0,
        })),
      };
    });
  }

  /**
   * Business rule 8: the previous version is pushed onto edit_history before
   * the new text is written. The reviews_guard_update trigger refuses the
   * update if that append is missing, so this cannot be skipped.
   */
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateReviewDto,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const existing = await tx.review.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          authorId: true,
          providerId: true,
          rating: true,
          punctualityRating: true,
          qualityRating: true,
          valueRating: true,
          comment: true,
          editHistory: true,
          createdAt: true,
        },
      });
      if (!existing) throw ApiError.notFound('REVIEW_NOT_FOUND');

      const isAuthor = existing.authorId === user.id;
      const isProvider =
        !!user.providerId && existing.providerId === user.providerId;

      // A provider may only ever attach a public response.
      if (dto.providerResponse !== undefined) {
        if (!isProvider && user.role !== UserRole.ADMIN) {
          throw ApiError.forbidden(
            'NOT_REVIEW_PROVIDER',
            'Only the provider being reviewed can respond.',
          );
        }
        return tx.review.update({
          where: { id },
          data: {
            providerResponse: dto.providerResponse,
            providerRespondedAt: new Date(),
          },
          select: PUBLIC_REVIEW_SELECT,
        });
      }

      if (!isAuthor && user.role !== UserRole.ADMIN) {
        throw ApiError.forbidden(
          'NOT_REVIEW_AUTHOR',
          'Only the author can edit a review.',
        );
      }

      const changesContent =
        (dto.rating !== undefined && dto.rating !== existing.rating) ||
        (dto.comment !== undefined && dto.comment !== existing.comment) ||
        (dto.punctualityRating !== undefined &&
          dto.punctualityRating !== existing.punctualityRating) ||
        (dto.qualityRating !== undefined &&
          dto.qualityRating !== existing.qualityRating) ||
        (dto.valueRating !== undefined &&
          dto.valueRating !== existing.valueRating);

      if (!changesContent) {
        throw ApiError.badRequest('NO_CHANGES', 'Nothing to change.');
      }

      const history = Array.isArray(existing.editHistory)
        ? existing.editHistory
        : [];

      const snapshot = {
        rating: existing.rating,
        punctualityRating: existing.punctualityRating,
        qualityRating: existing.qualityRating,
        valueRating: existing.valueRating,
        comment: existing.comment,
        editedAt: new Date().toISOString(),
      };

      const review = await tx.review.update({
        where: { id },
        data: {
          ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
          ...(dto.punctualityRating !== undefined
            ? { punctualityRating: dto.punctualityRating }
            : {}),
          ...(dto.qualityRating !== undefined
            ? { qualityRating: dto.qualityRating }
            : {}),
          ...(dto.valueRating !== undefined
            ? { valueRating: dto.valueRating }
            : {}),
          ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
          // Append, never replace.
          editHistory: [...history, snapshot] as Prisma.InputJsonValue,
        },
        select: PUBLIC_REVIEW_SELECT,
      });

      if (dto.rating !== undefined) {
        await this.recomputeRating(tx, existing.providerId);
        await this.cache.invalidateResource('providers', existing.providerId);
      }

      return review;
    });
  }

  async report(
    user: AuthenticatedUser,
    id: string,
    dto: ReportReviewDto,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const review = await tx.review.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!review) throw ApiError.notFound('REVIEW_NOT_FOUND');

      const existing = await tx.report.findFirst({
        where: {
          reporterId: user.id,
          targetType: ReportTargetType.REVIEW,
          targetId: id,
        },
        select: { id: true },
      });
      if (existing) {
        throw ApiError.conflict(
          'ALREADY_REPORTED',
          'You have already reported this review.',
        );
      }

      return tx.report.create({
        data: {
          reporterId: user.id,
          targetType: ReportTargetType.REVIEW,
          targetId: id,
          reason: dto.reason,
          details: dto.details ?? null,
        },
        select: { id: true, status: true, createdAt: true },
      });
    });
  }

  /**
   * Keeps providers.ratingAvg and ratingCount honest. Runs inside the same
   * transaction as the review write, so the two can never disagree.
   */
  private async recomputeRating(
    tx: Parameters<Parameters<PrismaService['withUser']>[1]>[0],
    providerId: string,
  ): Promise<void> {
    const agg = await tx.review.aggregate({
      where: { providerId, deletedAt: null, isHidden: false },
      _avg: { rating: true },
      _count: { rating: true },
    });

    await tx.provider.update({
      where: { id: providerId },
      data: {
        ratingAvg: new Prisma.Decimal((agg._avg.rating ?? 0).toFixed(2)),
        ratingCount: agg._count.rating,
      },
    });
  }
}
