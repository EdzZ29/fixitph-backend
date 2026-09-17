import { Injectable } from '@nestjs/common';
import {
  BookingStatus,
  NotificationType,
  Prisma,
  UserRole,
} from '@prisma/client';
import { ApiError } from '../common/errors';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { paginate, type Paginated } from '../common/dto/pagination.dto';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import type {
  CancelBookingDto,
  CompleteBookingDto,
  ListBookingsDto,
  UpdateBookingDto,
} from './dto/booking.dto';

type Actor = 'customer' | 'provider' | 'admin';

/** The booking lifecycle, as data. Nothing moves except along these edges. */
const TRANSITIONS: Record<
  BookingStatus,
  Partial<Record<BookingStatus, Actor[]>>
> = {
  PENDING_CONFIRMATION: {
    CONFIRMED: ['provider', 'admin'],
    CANCELLED_BY_CUSTOMER: ['customer', 'admin'],
    CANCELLED_BY_PROVIDER: ['provider', 'admin'],
  },
  CONFIRMED: {
    IN_PROGRESS: ['provider', 'admin'],
    CANCELLED_BY_CUSTOMER: ['customer', 'admin'],
    CANCELLED_BY_PROVIDER: ['provider', 'admin'],
    NO_SHOW_CUSTOMER: ['provider', 'admin'],
    NO_SHOW_PROVIDER: ['customer', 'admin'],
  },
  IN_PROGRESS: {
    COMPLETED: ['provider', 'admin'],
    DISPUTED: ['customer', 'provider', 'admin'],
  },
  COMPLETED: {
    DISPUTED: ['customer', 'admin'],
  },
  DISPUTED: {
    COMPLETED: ['admin'],
    CANCELLED_BY_CUSTOMER: ['admin'],
    CANCELLED_BY_PROVIDER: ['admin'],
  },
  CANCELLED_BY_CUSTOMER: {},
  CANCELLED_BY_PROVIDER: {},
  NO_SHOW_CUSTOMER: {},
  NO_SHOW_PROVIDER: {},
};

const BOOKING_SELECT = {
  id: true,
  status: true,
  scheduledStart: true,
  scheduledEnd: true,
  actualStart: true,
  actualEnd: true,
  totalAmount: true,
  currency: true,
  paymentMethod: true,
  paymentStatus: true,
  contactReleasedAt: true,
  cancellationReason: true,
  cancelledAt: true,
  completedAt: true,
  createdAt: true,
  quoteId: true,
  serviceRequestId: true,
  customerId: true,
  providerId: true,
  provider: {
    select: {
      id: true,
      businessName: true,
      slug: true,
      ratingAvg: true,
      ratingCount: true,
    },
  },
  service: { select: { id: true, title: true, slug: true } },
  // Presence only, not the review itself: the list needs to know whether
  // "Leave a review" is still an available action, and reviews.booking_id is
  // unique so there is at most one.
  review: { select: { id: true, rating: true } },
  serviceRequest: {
    select: {
      id: true,
      title: true,
      city: true,
      barangay: true,
      categoryId: true,
    },
  },
} satisfies Prisma.BookingSelect;

@Injectable()
export class BookingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Never cached: a booking is auth-scoped and has to be read fresh. */
  async list(
    user: AuthenticatedUser,
    dto: ListBookingsDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const scope: Prisma.BookingWhereInput =
        user.role === UserRole.ADMIN
          ? {}
          : user.providerId
            ? { OR: [{ customerId: user.id }, { providerId: user.providerId }] }
            : { customerId: user.id };

      const where: Prisma.BookingWhereInput = {
        deletedAt: null,
        ...scope,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.from || dto.to
          ? {
              scheduledStart: {
                ...(dto.from ? { gte: new Date(dto.from) } : {}),
                ...(dto.to ? { lte: new Date(dto.to) } : {}),
              },
            }
          : {}),
      };

      const [items, total] = await Promise.all([
        tx.booking.findMany({
          where,
          select: BOOKING_SELECT,
          orderBy: { scheduledStart: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.booking.count({ where }),
      ]);

      return paginate(items, total, dto);
    });
  }

  /**
   * Security design item 7. A provider gets the customer's general area up
   * front and the exact address only once the booking is confirmed. That
   * decision is made by the booking_contact_for_provider view, not here.
   */
  async findOne(user: AuthenticatedUser, id: string): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const booking = await tx.booking.findFirst({
        where: { id, deletedAt: null },
        select: {
          ...BOOKING_SELECT,
          statusHistory: {
            select: {
              fromStatus: true,
              toStatus: true,
              reason: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
          },
          review: {
            select: { id: true, rating: true, comment: true, createdAt: true },
          },
        },
      });
      if (!booking) throw ApiError.notFound('BOOKING_NOT_FOUND');

      const isProvider =
        !!user.providerId && booking.providerId === user.providerId;

      if (isProvider) {
        const [contact] = await tx.$queryRaw<
          {
            customer_city: string | null;
            customer_barangay: string | null;
            customer_name: string | null;
            customer_phone: string | null;
            customer_address_line1: string | null;
            customer_latitude: string | null;
            customer_longitude: string | null;
          }[]
        >`SELECT * FROM booking_contact_for_provider WHERE booking_id = ${id}::uuid`;

        return {
          ...booking,
          customerContact: contact
            ? {
                city: contact.customer_city,
                barangay: contact.customer_barangay,
                name: contact.customer_name,
                phone: contact.customer_phone,
                addressLine1: contact.customer_address_line1,
                latitude: contact.customer_latitude,
                longitude: contact.customer_longitude,
                released: booking.contactReleasedAt != null,
              }
            : null,
        };
      }

      return booking;
    });
  }

  /**
   * Bookings are created by accepting a quote, which is the only path that can
   * satisfy the unique bookings.quote_id. This endpoint exists for the admin
   * case of recording a booking agreed off platform.
   */
  async create(
    user: AuthenticatedUser,
    quoteId: string,
    scheduledStart: string,
  ): Promise<unknown> {
    if (user.role !== UserRole.ADMIN) {
      throw ApiError.forbidden(
        'USE_QUOTE_ACCEPT',
        'Create a booking by accepting a quote: POST /api/quotes/:id/accept.',
      );
    }
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const quote = await tx.quote.findUnique({
        where: { id: quoteId },
        select: {
          id: true,
          amount: true,
          providerId: true,
          serviceRequestId: true,
          serviceRequest: { select: { customerId: true, serviceId: true } },
        },
      });
      if (!quote) throw ApiError.notFound('QUOTE_NOT_FOUND');

      return tx.booking.create({
        data: {
          quoteId: quote.id,
          serviceRequestId: quote.serviceRequestId,
          customerId: quote.serviceRequest.customerId,
          providerId: quote.providerId,
          serviceId: quote.serviceRequest.serviceId,
          scheduledStart: new Date(scheduledStart),
          totalAmount: quote.amount,
        },
        select: BOOKING_SELECT,
      });
    });
  }

  /** Reschedule or change payment method. Status moves have their own routes. */
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateBookingDto,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const booking = await this.loadForActor(tx, id, user);

      if (
        booking.status !== BookingStatus.PENDING_CONFIRMATION &&
        booking.status !== BookingStatus.CONFIRMED
      ) {
        throw ApiError.conflict(
          'BOOKING_NOT_RESCHEDULABLE',
          `A ${booking.status.toLowerCase()} booking cannot be rescheduled.`,
        );
      }

      if (dto.scheduledStart && new Date(dto.scheduledStart) <= new Date()) {
        throw ApiError.badRequest(
          'SCHEDULE_IN_PAST',
          'Pick a time in the future.',
        );
      }

      /**
       * Moving a booking keeps its length.
       *
       * bookings_schedule_ordered requires scheduled_end > scheduled_start.
       * A booking created from a quote with an estimated duration has an end,
       * so moving only the start used to push it past the end and the write
       * failed on the constraint — surfacing as a 500 rather than anything a
       * caller could act on. Shifting the end by the same amount is both what
       * the constraint needs and what someone rescheduling an appointment
       * means.
       */
      const current = await tx.booking.findUniqueOrThrow({
        where: { id },
        select: { scheduledStart: true, scheduledEnd: true },
      });

      const nextStart = dto.scheduledStart
        ? new Date(dto.scheduledStart)
        : current.scheduledStart;

      let nextEnd: Date | null = dto.scheduledEnd
        ? new Date(dto.scheduledEnd)
        : current.scheduledEnd;

      if (dto.scheduledStart && !dto.scheduledEnd && current.scheduledEnd) {
        const length =
          current.scheduledEnd.getTime() - current.scheduledStart.getTime();
        nextEnd = new Date(nextStart.getTime() + length);
      }

      if (nextEnd && nextEnd <= nextStart) {
        throw ApiError.badRequest(
          'SCHEDULE_ENDS_BEFORE_IT_STARTS',
          'The end of the booking has to come after the start.',
        );
      }

      return tx.booking.update({
        where: { id },
        data: {
          ...(dto.scheduledStart ? { scheduledStart: nextStart } : {}),
          ...(nextEnd !== current.scheduledEnd
            ? { scheduledEnd: nextEnd }
            : {}),
          ...(dto.paymentMethod ? { paymentMethod: dto.paymentMethod } : {}),
        },
        select: BOOKING_SELECT,
      });
    });
  }

  /**
   * Confirming is what releases the customer's exact address, so it is its own
   * explicit step rather than a side effect of a generic status patch.
   */
  async confirm(user: AuthenticatedUser, id: string): Promise<unknown> {
    return this.prisma.withUser(
      toAuthContext(user),
      async (tx) => {
        const booking = await this.loadForActor(tx, id, user);
        this.assertTransition(
          booking.status,
          BookingStatus.CONFIRMED,
          booking.actor,
        );

        const updated = await tx.booking.update({
          where: { id },
          data: {
            status: BookingStatus.CONFIRMED,
            // Business rule 5: this stamp is the gate the view checks.
            contactReleasedAt: new Date(),
          },
          select: BOOKING_SELECT,
        });

        await tx.notification.create({
          data: {
            userId: booking.customerId,
            type: NotificationType.BOOKING_CONFIRMED,
            title: 'Your booking is confirmed',
            body: 'The provider confirmed. They now have your address and contact number.',
            data: { bookingId: id },
          },
        });

        return updated;
      },
      { statusChangeReason: 'confirmed by provider' },
    );
  }

  async start(user: AuthenticatedUser, id: string): Promise<unknown> {
    return this.prisma.withUser(
      toAuthContext(user),
      async (tx) => {
        const booking = await this.loadForActor(tx, id, user);
        this.assertTransition(
          booking.status,
          BookingStatus.IN_PROGRESS,
          booking.actor,
        );
        return tx.booking.update({
          where: { id },
          data: { status: BookingStatus.IN_PROGRESS, actualStart: new Date() },
          select: BOOKING_SELECT,
        });
      },
      { statusChangeReason: 'work started' },
    );
  }

  async cancel(
    user: AuthenticatedUser,
    id: string,
    dto: CancelBookingDto,
  ): Promise<unknown> {
    return this.prisma.withUser(
      toAuthContext(user),
      async (tx) => {
        const booking = await this.loadForActor(tx, id, user);

        const target =
          booking.actor === 'provider'
            ? BookingStatus.CANCELLED_BY_PROVIDER
            : BookingStatus.CANCELLED_BY_CUSTOMER;

        this.assertTransition(booking.status, target, booking.actor);

        const updated = await tx.booking.update({
          where: { id },
          data: {
            status: target,
            cancellationReason: dto.reason,
            cancelledById: user.id,
            cancelledAt: new Date(),
          },
          select: BOOKING_SELECT,
        });

        const notify =
          booking.actor === 'provider'
            ? booking.customerId
            : booking.providerUserId;
        if (notify) {
          await tx.notification.create({
            data: {
              userId: notify,
              type: NotificationType.BOOKING_CANCELLED,
              title: 'Booking cancelled',
              body: dto.reason,
              data: { bookingId: id },
            },
          });
        }

        return updated;
      },
      { statusChangeReason: dto.reason },
    );
  }

  /**
   * Business rule 6: the booking_status_history row is written by a database
   * trigger on the status change, inside this same transaction. It cannot be
   * skipped and it cannot be edited afterwards.
   */
  async complete(
    user: AuthenticatedUser,
    id: string,
    dto: CompleteBookingDto,
  ): Promise<unknown> {
    return this.prisma.withUser(
      toAuthContext(user),
      async (tx) => {
        const booking = await this.loadForActor(tx, id, user);
        this.assertTransition(
          booking.status,
          BookingStatus.COMPLETED,
          booking.actor,
        );

        const now = new Date();
        const updated = await tx.booking.update({
          where: { id },
          data: {
            status: BookingStatus.COMPLETED,
            completedAt: now,
            actualEnd: now,
            ...(dto.finalAmount !== undefined
              ? { totalAmount: dto.finalAmount }
              : {}),
            ...(dto.paymentStatus ? { paymentStatus: dto.paymentStatus } : {}),
          },
          select: BOOKING_SELECT,
        });

        await tx.provider.update({
          where: { id: booking.providerId },
          data: { completedJobsCount: { increment: 1 } },
        });

        await tx.notification.create({
          data: {
            userId: booking.customerId,
            type: NotificationType.BOOKING_COMPLETED,
            title: 'Job marked finished',
            body: 'How did it go? Leave a review so the next person knows.',
            data: { bookingId: id },
          },
        });

        const history = await tx.bookingStatusHistory.findMany({
          where: { bookingId: id },
          select: {
            fromStatus: true,
            toStatus: true,
            reason: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        });

        return { ...updated, statusHistory: history };
      },
      { statusChangeReason: dto.notes ?? 'work completed' },
    );
  }

  // -- helpers ---------------------------------------------------------------

  private async loadForActor(
    tx: Tx,
    id: string,
    user: AuthenticatedUser,
  ): Promise<{
    id: string;
    status: BookingStatus;
    customerId: string;
    providerId: string;
    providerUserId: string | null;
    actor: Actor;
  }> {
    const booking = await tx.booking.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        status: true,
        customerId: true,
        providerId: true,
        provider: { select: { userId: true } },
      },
    });
    if (!booking) throw ApiError.notFound('BOOKING_NOT_FOUND');

    const actor: Actor =
      user.role === UserRole.ADMIN
        ? 'admin'
        : booking.customerId === user.id
          ? 'customer'
          : user.providerId && booking.providerId === user.providerId
            ? 'provider'
            : (() => {
                throw ApiError.forbidden(
                  'NOT_A_PARTY',
                  'You are not party to that booking.',
                );
              })();

    return {
      id: booking.id,
      status: booking.status,
      customerId: booking.customerId,
      providerId: booking.providerId,
      providerUserId: booking.provider?.userId ?? null,
      actor,
    };
  }

  private assertTransition(
    from: BookingStatus,
    to: BookingStatus,
    actor: Actor,
  ): void {
    const allowed = TRANSITIONS[from][to];
    if (!allowed) {
      throw ApiError.conflict(
        'INVALID_STATUS_TRANSITION',
        `A booking cannot go from ${from} to ${to}.`,
      );
    }
    if (!allowed.includes(actor)) {
      throw ApiError.forbidden(
        'NOT_ALLOWED_TO_TRANSITION',
        `A ${actor} cannot move this booking to ${to}.`,
      );
    }
  }
}
