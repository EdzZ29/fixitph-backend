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

    /**
     * Everything from here runs inside the caller's own row level security
     * context. Deciding whether this provider may quote needs a request row
     * they cannot necessarily see yet, and there are exactly two cases:
     *
     *   - A request addressed to them is visible in the base table, because
     *     service_requests_select admits provider_id = current_provider_id().
     *     An ordinary read settles it.
     *   - A broadcast request is deliberately invisible until they have
     *     quoted it. open_service_request_feed is the sanctioned read for
     *     those: the view already restricts itself to unaddressed, OPEN or
     *     QUOTED, unexpired rows, and carries no customer identity, no street
     *     address and no coordinates.
     *
     * This used to be a single read on the request table with *no* session
     * context at all. Every clause of the policy then compared against NULL,
     * the row came back empty, and quoting a broadcast request always failed
     * with a 404 — on a real deployment, though not under the superuser test
     * harness. The comment here previously claimed elevated privileges that
     * the client did not actually have.
     */
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const addressed = await tx.serviceRequest.findUnique({
        where: { id: dto.serviceRequestId },
        select: { id: true, status: true, providerId: true, expiresAt: true },
      });

      if (addressed) {
        if (addressed.providerId && addressed.providerId !== user.providerId) {
          throw ApiError.forbidden(
            'REQUEST_NOT_FOR_YOU',
            'That request was sent to a different provider.',
          );
        }
        if (
          addressed.status !== RequestStatus.OPEN &&
          addressed.status !== RequestStatus.QUOTED
        ) {
          throw ApiError.conflict(
            'REQUEST_NOT_OPEN',
            `That request is ${addressed.status.toLowerCase()} and is no longer taking quotes.`,
          );
        }
        if (addressed.expiresAt && addressed.expiresAt <= new Date()) {
          throw ApiError.conflict(
            'REQUEST_EXPIRED',
            'That request has expired.',
          );
        }
      } else {
        // Presence in the feed is itself the eligibility check: the view's
        // own WHERE clause is the "open, unexpired, unaddressed" rule.
        const open = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM open_service_request_feed
          WHERE id = ${dto.serviceRequestId}::uuid
        `;
        if (!open.length) throw ApiError.notFound('REQUEST_NOT_FOUND');
      }

      const existing = await tx.quote.findFirst({
        where: {
          serviceRequestId: dto.serviceRequestId,
          providerId: user.providerId!,
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

      /**
       * Inserting the quote is what makes the request readable to this
       * provider — app.provider_has_quoted() returns true for it now — so the
       * owner and the current status can be read here, and could not have
       * been read a moment ago.
       */
      const request = await tx.serviceRequest.findUnique({
        where: { id: dto.serviceRequestId },
        select: { status: true, customerId: true },
      });

      if (request?.status === RequestStatus.OPEN) {
        await tx.serviceRequest.update({
          where: { id: dto.serviceRequestId },
          data: { status: RequestStatus.QUOTED },
        });
      }

      if (request) {
        await tx.notification.create({
          data: {
            userId: request.customerId,
            type: NotificationType.QUOTE_RECEIVED,
            title: 'You have a new quote',
            body: `A provider quoted ${dto.amount} for your request.`,
            data: {
              quoteId: quote.id,
              serviceRequestId: dto.serviceRequestId,
            },
          },
        });
      }

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
