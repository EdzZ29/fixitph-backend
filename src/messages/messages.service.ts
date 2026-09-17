import { Injectable } from '@nestjs/common';
import { MessageType, NotificationType, Prisma } from '@prisma/client';
import { ApiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, type Paginated } from '../common/dto/pagination.dto';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import type { ListMessagesDto, SendMessageDto } from './dto/message.dto';

const MESSAGE_SELECT = {
  id: true,
  bookingId: true,
  serviceRequestId: true,
  senderId: true,
  recipientId: true,
  messageType: true,
  body: true,
  readAt: true,
  createdAt: true,
  attachments: {
    select: {
      id: true,
      originalFilename: true,
      mimeType: true,
      sizeBytes: true,
    },
  },
} satisfies Prisma.MessageSelect;

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A message hangs off exactly one thread anchor, which is a CHECK constraint
   * as well. Everything else about who may read it is the RLS policy on
   * messages: sender or recipient, nobody else.
   */
  async send(user: AuthenticatedUser, dto: SendMessageDto): Promise<unknown> {
    if ((dto.bookingId ? 1 : 0) + (dto.serviceRequestId ? 1 : 0) !== 1) {
      throw ApiError.badRequest(
        'INVALID_THREAD',
        'A message belongs to exactly one booking or one service request.',
      );
    }

    const recipientId = await this.resolveRecipient(user, dto);

    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const message = await tx.message.create({
        data: {
          bookingId: dto.bookingId ?? null,
          serviceRequestId: dto.serviceRequestId ?? null,
          senderId: user.id,
          recipientId,
          messageType: dto.messageType ?? MessageType.TEXT,
          body: dto.body,
        },
        select: MESSAGE_SELECT,
      });

      await tx.notification.create({
        data: {
          userId: recipientId,
          type: NotificationType.MESSAGE_RECEIVED,
          title: 'New message',
          body: dto.body.slice(0, 140),
          data: { messageId: message.id, bookingId: dto.bookingId ?? null },
        },
      });

      return message;
    });
  }

  async thread(
    user: AuthenticatedUser,
    dto: ListMessagesDto,
  ): Promise<Paginated<unknown>> {
    if ((dto.bookingId ? 1 : 0) + (dto.serviceRequestId ? 1 : 0) !== 1) {
      throw ApiError.badRequest(
        'INVALID_THREAD',
        'Ask for one booking thread or one request thread.',
      );
    }

    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const where: Prisma.MessageWhereInput = dto.bookingId
        ? { bookingId: dto.bookingId }
        : { serviceRequestId: dto.serviceRequestId };

      const [items, total] = await Promise.all([
        tx.message.findMany({
          where,
          select: MESSAGE_SELECT,
          orderBy: { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.message.count({ where }),
      ]);

      // Reading a thread marks the caller's inbound messages as read. The RLS
      // update policy limits this to rows where they are the recipient.
      await tx.message.updateMany({
        where: { ...where, recipientId: user.id, readAt: null },
        data: { readAt: new Date() },
      });

      return paginate(items.reverse(), total, dto);
    });
  }

  async unreadCount(user: AuthenticatedUser): Promise<{ unread: number }> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const unread = await tx.message.count({
        where: { recipientId: user.id, readAt: null },
      });
      return { unread };
    });
  }

  /**
   * Works out the other party from the thread. Taking a recipient id from the
   * client would let anyone message any user id they can guess.
   */
  private async resolveRecipient(
    user: AuthenticatedUser,
    dto: SendMessageDto,
  ): Promise<string> {
    // Both lookups run in the caller's own context. They are reads of a
    // booking or request the caller is a party to, which is exactly what the
    // policies admit; with no context set they returned nothing and sending
    // any message failed with a 404.
    if (dto.bookingId) {
      const booking = await this.prisma.withUser(toAuthContext(user), (tx) =>
        tx.booking.findFirst({
          where: { id: dto.bookingId, deletedAt: null },
          select: {
            customerId: true,
            providerId: true,
            provider: { select: { userId: true } },
          },
        }),
      );
      if (!booking) throw ApiError.notFound('BOOKING_NOT_FOUND');

      if (booking.customerId === user.id) return booking.provider.userId;
      if (user.providerId && booking.providerId === user.providerId)
        return booking.customerId;
      throw ApiError.forbidden(
        'NOT_A_PARTY',
        'You are not party to that booking.',
      );
    }

    const request = await this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.serviceRequest.findUnique({
        where: { id: dto.serviceRequestId },
        select: {
          customerId: true,
          providerId: true,
          provider: { select: { userId: true } },
          quotes: {
            select: {
              providerId: true,
              provider: { select: { userId: true } },
            },
          },
        },
      }),
    );
    if (!request) throw ApiError.notFound('REQUEST_NOT_FOUND');

    if (request.customerId === user.id) {
      // The customer replies to the provider the request was sent to, or to
      // the single provider who has quoted it.
      const target =
        request.provider?.userId ?? request.quotes[0]?.provider.userId;
      if (!target) {
        throw ApiError.badRequest(
          'NO_RECIPIENT',
          'Nobody has quoted this request yet, so there is no one to message.',
        );
      }
      return target;
    }

    const isParty =
      user.providerId &&
      (request.providerId === user.providerId ||
        request.quotes.some((q) => q.providerId === user.providerId));

    if (!isParty) {
      throw ApiError.forbidden(
        'NOT_A_PARTY',
        'Send a quote before messaging about this request.',
      );
    }
    return request.customerId;
  }
}
