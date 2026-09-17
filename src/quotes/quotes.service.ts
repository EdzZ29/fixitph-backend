import { Injectable } from '@nestjs/common';
import {
  BookingStatus,
  NotificationType,
  Prisma,
  QuoteStatus,
  RequestStatus,
  UserRole,
  VerificationStatus,
} from '@prisma/client';
import { ApiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import type { AcceptQuoteDto } from './dto/accept-quote.dto';
import type { CreateQuoteDto } from './dto/create-quote.dto';
import type { UpdateQuoteDto } from './dto/update-quote.dto';

const QUOTE_SELECT = {
  id: true,
  serviceRequestId: true,
  amount: true,
  currency: true,
  laborCost: true,
  partsCost: true,
  breakdown: true,
  notes: true,
  estimatedDurationMinutes: true,
  validUntil: true,
  status: true,
  respondedAt: true,
  createdAt: true,
  provider: {
    select: {
      id: true,
      businessName: true,
      slug: true,
      ratingAvg: true,
      ratingCount: true,
      completedJobsCount: true,
    },
  },
} satisfies Prisma.QuoteSelect;

@Injectable()
export class QuotesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Business rule 3: only a provider the request is open to may quote, and
   * only once at a time. The partial unique index
   * quotes_one_live_per_provider_per_request is the actual guarantee; this is
   * the readable error.
   */
  async create(user: AuthenticatedUser, dto: CreateQuoteDto): Promise<unknown> {
    if (!user.providerId) {
      throw ApiError.forbidden(
        'NO_PROVIDER_PROFILE',
        'Only providers can send quotes.',
      );
    }

    const provider = await this.prisma.provider.findFirst({
      where: { id: user.providerId, deletedAt: null },
      select: { id: true, suspendedAt: true, verificationStatus: true },
    });
    if (!provider) throw ApiError.notFound('PROVIDER_NOT_FOUND');
    if (provider.suspendedAt) {
      throw ApiError.forbidden(
        'PROVIDER_SUSPENDED',
        'This provider account is suspended.',
      );
    }
    if (provider.verificationStatus !== VerificationStatus.APPROVED) {
      throw ApiError.forbidden(
        'PROVIDER_NOT_VERIFIED',
        'Your documents have to be approved before you can send quotes.',
      );
    }

    // Read with elevated privileges deliberately: a provider cannot yet see a
    // broadcast request row, so we have to check eligibility before the RLS
    // scoped write. Only the columns needed for that decision are read.
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: dto.serviceRequestId },
      select: {
        id: true,
        status: true,
        customerId: true,
        providerId: true,
        expiresAt: true,
      },
    });
    if (!request) throw ApiError.notFound('REQUEST_NOT_FOUND');

    if (request.providerId && request.providerId !== user.providerId) {
      throw ApiError.forbidden(
        'REQUEST_NOT_FOR_YOU',
        'That request was sent to a different provider.',
      );
    }
    if (
      request.status !== RequestStatus.OPEN &&
      request.status !== RequestStatus.QUOTED
    ) {
      throw ApiError.conflict(
        'REQUEST_NOT_OPEN',
        `That request is ${request.status.toLowerCase()} and is no longer taking quotes.`,
      );
    }
    if (request.expiresAt && request.expiresAt <= new Date()) {
      throw ApiError.conflict('REQUEST_EXPIRED', 'That request has expired.');
    }

    const existing = await this.prisma.quote.findFirst({
      where: {
        serviceRequestId: dto.serviceRequestId,
        providerId: user.providerId,
        status: { in: [QuoteStatus.PENDING, QuoteStatus.ACCEPTED] },
      },
      select: { id: true },
    });
    if (existing) {
      throw ApiError.conflict(
        'QUOTE_ALREADY_SENT',
        'You already have a live quote on this request. Update or withdraw it first.',
      );
    }

    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const quote = await tx.quote.create({
        data: {
          serviceRequestId: dto.serviceRequestId,
          providerId: user.providerId!,
          amount: dto.amount,
          laborCost: dto.laborCost ?? null,
          partsCost: dto.partsCost ?? null,
          breakdown:
            (dto.breakdown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          notes: dto.notes ?? null,
          estimatedDurationMinutes: dto.estimatedDurationMinutes ?? null,
          validUntil: dto.validUntil
            ? new Date(dto.validUntil)
            : new Date(Date.now() + 7 * 86_400_000),
          status: QuoteStatus.PENDING,
        },
        select: QUOTE_SELECT,
      });

      if (request.status === RequestStatus.OPEN) {
        await tx.serviceRequest.update({
          where: { id: dto.serviceRequestId },
          data: { status: RequestStatus.QUOTED },
        });
      }

      await tx.notification.create({
        data: {
          userId: request.customerId,
          type: NotificationType.QUOTE_RECEIVED,
          title: 'You have a new quote',
          body: `A provider quoted ${dto.amount} for your request.`,
          data: { quoteId: quote.id, serviceRequestId: dto.serviceRequestId },
        },
      });

      return quote;
    });
  }

  async findOne(user: AuthenticatedUser, id: string): Promise<unknown> {
    const quote = await this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.quote.findUnique({ where: { id }, select: QUOTE_SELECT }),
    );
    if (!quote) throw ApiError.notFound('QUOTE_NOT_FOUND');
    return quote;
  }

  /** Only the issuing provider may revise a quote, and only while pending. */
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateQuoteDto,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const quote = await tx.quote.findUnique({
        where: { id },
        select: { id: true, providerId: true, status: true },
      });
      if (!quote) throw ApiError.notFound('QUOTE_NOT_FOUND');

      if (
        user.role !== UserRole.ADMIN &&
        quote.providerId !== user.providerId
      ) {
        throw ApiError.forbidden('NOT_QUOTE_OWNER', 'That is not your quote.');
      }
      if (quote.status !== QuoteStatus.PENDING) {
        throw ApiError.conflict(
          'QUOTE_NOT_PENDING',
          `A ${quote.status.toLowerCase()} quote can no longer be changed.`,
        );
      }

      return tx.quote.update({
        where: { id },
        data: {
          ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
          ...(dto.laborCost !== undefined ? { laborCost: dto.laborCost } : {}),
          ...(dto.partsCost !== undefined ? { partsCost: dto.partsCost } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.estimatedDurationMinutes !== undefined
            ? { estimatedDurationMinutes: dto.estimatedDurationMinutes }
            : {}),
          ...(dto.validUntil !== undefined
            ? { validUntil: new Date(dto.validUntil) }
            : {}),
          ...(dto.status === QuoteStatus.WITHDRAWN
            ? { status: QuoteStatus.WITHDRAWN, respondedAt: new Date() }
            : {}),
        },
        select: QUOTE_SELECT,
      });
    });
  }

  /**
   * Business rule 4: only the requesting customer accepts, and doing so
   * creates exactly one booking and closes every sibling quote. All of it in
   * one transaction, so a crash halfway cannot leave two accepted quotes.
   */
  async accept(
    user: AuthenticatedUser,
    id: string,
    dto: AcceptQuoteDto,
  ): Promise<unknown> {
    return this.prisma.withUser(
      toAuthContext(user),
      async (tx) => {
        const quote = await tx.quote.findUnique({
          where: { id },
          select: {
            id: true,
            amount: true,
            status: true,
            validUntil: true,
            providerId: true,
            serviceRequestId: true,
            estimatedDurationMinutes: true,
            serviceRequest: {
              select: {
                id: true,
                customerId: true,
                serviceId: true,
                status: true,
              },
            },
          },
        });
        if (!quote) throw ApiError.notFound('QUOTE_NOT_FOUND');

        if (
          user.role !== UserRole.ADMIN &&
          quote.serviceRequest.customerId !== user.id
        ) {
          throw ApiError.forbidden(
            'NOT_REQUEST_OWNER',
            'Only the customer who posted the request can accept a quote.',
          );
        }
        if (quote.status !== QuoteStatus.PENDING) {
          throw ApiError.conflict(
            'QUOTE_NOT_PENDING',
            `That quote is already ${quote.status.toLowerCase()}.`,
          );
        }
        if (quote.validUntil && quote.validUntil <= new Date()) {
          throw ApiError.conflict('QUOTE_EXPIRED', 'That quote has expired.');
        }

        const scheduledStart = new Date(dto.scheduledStart);
        if (scheduledStart <= new Date()) {
          throw ApiError.badRequest(
            'SCHEDULE_IN_PAST',
            'Pick a time in the future.',
          );
        }
        const scheduledEnd = quote.estimatedDurationMinutes
          ? new Date(
              scheduledStart.getTime() +
                quote.estimatedDurationMinutes * 60_000,
            )
          : null;

        await tx.quote.update({
          where: { id },
          data: { status: QuoteStatus.ACCEPTED, respondedAt: new Date() },
        });

        // Every other live quote on this request is now moot.
        await tx.quote.updateMany({
          where: {
            serviceRequestId: quote.serviceRequestId,
            id: { not: id },
            status: QuoteStatus.PENDING,
          },
          data: { status: QuoteStatus.REJECTED, respondedAt: new Date() },
        });

        const booking = await tx.booking.create({
          data: {
            quoteId: quote.id,
            serviceRequestId: quote.serviceRequestId,
            customerId: quote.serviceRequest.customerId,
            providerId: quote.providerId,
            serviceId: quote.serviceRequest.serviceId,
            scheduledStart,
            scheduledEnd,
            totalAmount: quote.amount,
            paymentMethod: dto.paymentMethod,
            status: BookingStatus.PENDING_CONFIRMATION,
          },
          select: {
            id: true,
            status: true,
            scheduledStart: true,
            totalAmount: true,
          },
        });

        await tx.serviceRequest.update({
          where: { id: quote.serviceRequestId },
          data: { status: RequestStatus.BOOKED },
        });

        await tx.notification.create({
          data: {
            userId: user.id,
            type: NotificationType.QUOTE_ACCEPTED,
            title: 'Booking created',
            body: 'Your booking is waiting for the provider to confirm.',
            data: { bookingId: booking.id },
          },
        });

        return { quoteId: id, booking };
      },
      { statusChangeReason: 'quote accepted by customer' },
    );
  }

  async reject(
    user: AuthenticatedUser,
    id: string,
    reason?: string,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const quote = await tx.quote.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          serviceRequest: { select: { customerId: true } },
        },
      });
      if (!quote) throw ApiError.notFound('QUOTE_NOT_FOUND');

      if (
        user.role !== UserRole.ADMIN &&
        quote.serviceRequest.customerId !== user.id
      ) {
        throw ApiError.forbidden(
          'NOT_REQUEST_OWNER',
          'Only the customer who posted the request can reject a quote.',
        );
      }
      if (quote.status !== QuoteStatus.PENDING) {
        throw ApiError.conflict(
          'QUOTE_NOT_PENDING',
          `That quote is already ${quote.status.toLowerCase()}.`,
        );
      }

      return tx.quote.update({
        where: { id },
        data: {
          status: QuoteStatus.REJECTED,
          respondedAt: new Date(),
          notes: reason ? `${reason}` : undefined,
        },
        select: QUOTE_SELECT,
      });
    });
  }
}
