import { Injectable } from '@nestjs/common';
import { MessageType, NotificationType, Prisma } from '@prisma/client';
import { ApiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, type Paginated } from '../common/dto/pagination.dto';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import { UploadsService, type StoredObject } from '../uploads/uploads.service';
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
      // Read to be exchanged for a signed URL, and dropped before the payload
      // leaves. A storage key in a response is a key somebody can try.
      storageKey: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.MessageSelect;

/** What a thread row looks like once the keys have become links. */
interface MessageWithAttachments {
  attachments: {
    id: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
  }[];
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
  ) {}

  /**
   * Swaps every attachment's storage key for a link that works for a few
   * minutes.
   *
   * Signed here rather than in the database select, because a signature has
   * an expiry: minting it at read time means the link is always as fresh as
   * the request that asked for it. The thread revalidates when the tab is
   * focused, so an image left on screen for an hour gets a new link rather
   * than a broken one.
   */
  private async withAttachmentUrls<T extends MessageWithAttachments>(
    messages: T[],
  ): Promise<
    (Omit<T, 'attachments'> & {
      attachments: {
        id: string;
        originalFilename: string;
        mimeType: string;
        sizeBytes: number;
        url: string | null;
      }[];
    })[]
  > {
    return Promise.all(
      messages.map(async ({ attachments, ...rest }) => ({
        ...rest,
        attachments: await Promise.all(
          attachments.map(async ({ storageKey, ...meta }) => ({
            ...meta,
            // A single unreachable object must not take the thread down with
            // it: the message still reads, the image just does not load.
            url: await this.uploads
              .signedUrl(storageKey)
              .then((r) => r.url)
              .catch(() => null),
          })),
        ),
      })),
    );
  }

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

      await this.notify(
        tx,
        recipientId,
        message.id,
        dto.bookingId ?? null,
        dto.serviceRequestId ?? null,
        dto.body,
      );

      const [withUrls] = await this.withAttachmentUrls([message]);
      return withUrls;
    });
  }

  /**
   * An image, and the message that carries it, in one request.
   *
   * Created together in one transaction rather than "send, then attach".
   * Splitting them means a failed upload leaves an empty message sitting in
   * somebody's thread, and a failed insert leaves an object in storage that
   * nothing points at. One of those is visible to the customer.
   *
   * The body is not optional at the database level — messages carries a
   * CHECK that it is not blank — so an image with no caption gets a plain
   * sentence rather than an empty bubble.
   */
  async sendImage(
    user: AuthenticatedUser,
    anchor: { bookingId?: string; serviceRequestId?: string },
    caption: string | undefined,
    stored: StoredObject,
  ): Promise<unknown> {
    if ((anchor.bookingId ? 1 : 0) + (anchor.serviceRequestId ? 1 : 0) !== 1) {
      throw ApiError.badRequest(
        'INVALID_THREAD',
        'A message belongs to exactly one booking or one service request.',
      );
    }

    const recipientId = await this.resolveRecipient(user, anchor);
    const body = caption?.trim() || 'Sent a photo';

    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const message = await tx.message.create({
        data: {
          bookingId: anchor.bookingId ?? null,
          serviceRequestId: anchor.serviceRequestId ?? null,
          senderId: user.id,
          recipientId,
          messageType: MessageType.IMAGE,
          body,
          attachments: {
            create: {
              storageKey: stored.storageKey,
              originalFilename: stored.originalFilename,
              mimeType: stored.mimeType,
              sizeBytes: stored.sizeBytes,
              checksumSha256: stored.checksumSha256,
            },
          },
        },
        select: MESSAGE_SELECT,
      });

      await this.notify(
        tx,
        recipientId,
        message.id,
        anchor.bookingId ?? null,
        anchor.serviceRequestId ?? null,
        caption?.trim() ? `Photo: ${caption.trim()}` : 'Sent a photo',
      );

      const [withUrls] = await this.withAttachmentUrls([message]);
      return withUrls;
    });
  }

  /**
   * The notification that goes with a message.
   *
   * It names the booking it is about. A provider with four jobs on the go
   * gets "New message" four times otherwise, and has to open each one to
   * find out which job somebody is asking about. The short reference is the
   * same eight characters the booking screens print, so the two match.
   */
  private async notify(
    tx: Parameters<Parameters<PrismaService['withUser']>[1]>[0],
    recipientId: string,
    messageId: string,
    bookingId: string | null,
    serviceRequestId: string | null,
    preview: string,
  ): Promise<void> {
    await tx.notification.create({
      data: {
        userId: recipientId,
        type: NotificationType.MESSAGE_RECEIVED,
        title: bookingId
          ? `New message about booking ${reference(bookingId)}`
          : 'New message about your request',
        body: preview.slice(0, 140),
        data: { messageId, bookingId, serviceRequestId },
      },
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

      return paginate(
        await this.withAttachmentUrls(items.reverse()),
        total,
        dto,
      );
    });
  }

  /**
   * Every conversation the caller is in, newest first.
   *
   * There was no way to ask this before: a thread could only be opened from
   * the booking it hangs off, so a customer with three jobs had three
   * different pages to check for replies and no way to see that somebody had
   * written. That is the whole reason this exists.
   *
   * Raw SQL for the first step, because "the latest row per group" is what
   * DISTINCT ON does in one pass and what an ORM makes into a query per
   * thread. Row level security still applies — the caller's own rows and no
   * others — so the grouping cannot see a conversation they are not in.
   */
  async listThreads(user: AuthenticatedUser): Promise<unknown[]> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const latest = await tx.$queryRaw<
        {
          booking_id: string | null;
          service_request_id: string | null;
          body: string;
          message_type: MessageType;
          created_at: Date;
          sender_id: string;
          unread: bigint;
        }[]
      >`
        WITH mine AS (
          SELECT
            m.*,
            coalesce(m.booking_id::text, m.service_request_id::text) AS anchor
          FROM messages m
        ),
        newest AS (
          SELECT DISTINCT ON (anchor) *
          FROM mine
          ORDER BY anchor, created_at DESC
        ),
        counts AS (
          SELECT anchor, count(*) AS unread
          FROM mine
          WHERE recipient_id = app.current_user_id() AND read_at IS NULL
          GROUP BY anchor
        )
        SELECT
          n.booking_id,
          n.service_request_id,
          n.body,
          n.message_type,
          n.created_at,
          n.sender_id,
          coalesce(c.unread, 0) AS unread
        FROM newest n
        LEFT JOIN counts c ON c.anchor = n.anchor
        ORDER BY n.created_at DESC
        LIMIT 100
      `;

      if (!latest.length) return [];

      const bookingIds = latest
        .map((row) => row.booking_id)
        .filter((id): id is string => id !== null);
      const requestIds = latest
        .map((row) => row.service_request_id)
        .filter((id): id is string => id !== null);

      /**
       * What to call each conversation.
       *
       * Read in the caller's own session, so these are bookings and requests
       * they are a party to. A provider gets the customer's name only once
       * the API has released it — booking_contact_for_provider withholds it
       * until confirmation, and this does not go behind that.
       */
      const [bookings, requests, contacts] = await Promise.all([
        tx.booking.findMany({
          where: { id: { in: bookingIds } },
          select: {
            id: true,
            status: true,
            scheduledStart: true,
            customerId: true,
            service: { select: { title: true } },
            serviceRequest: {
              select: { title: true, city: true, barangay: true },
            },
            provider: { select: { businessName: true } },
          },
        }),
        tx.serviceRequest.findMany({
          where: { id: { in: requestIds } },
          select: { id: true, title: true, city: true, barangay: true },
        }),
        user.providerId && bookingIds.length
          ? tx.$queryRaw<
              { booking_id: string; customer_name: string | null }[]
            >`
              SELECT booking_id, customer_name
              FROM booking_contact_for_provider
              WHERE booking_id IN (${Prisma.join(
                bookingIds.map((id) => Prisma.sql`${id}::uuid`),
              )})
            `
          : Promise.resolve(
              [] as { booking_id: string; customer_name: string | null }[],
            ),
      ]);

      const bookingById = new Map(bookings.map((b) => [b.id, b]));
      const requestById = new Map(requests.map((r) => [r.id, r]));
      const nameByBooking = new Map<string, string | null>(
        contacts.map((c) => [c.booking_id, c.customer_name] as const),
      );

      return latest.map((row) => {
        const booking = row.booking_id
          ? bookingById.get(row.booking_id)
          : undefined;
        const request = row.service_request_id
          ? requestById.get(row.service_request_id)
          : undefined;

        const area = booking
          ? [booking.serviceRequest?.barangay, booking.serviceRequest?.city]
              .filter(Boolean)
              .join(', ')
          : [request?.barangay, request?.city].filter(Boolean).join(', ');

        // Who the other side is, from whichever side is asking.
        const iAmCustomer = booking ? booking.customerId === user.id : true;
        const counterparty = booking
          ? iAmCustomer
            ? (booking.provider?.businessName ?? 'The provider')
            : (nameByBooking.get(booking.id) ??
              (area ? `Customer in ${area}` : 'Customer'))
          : 'FixItPH';

        return {
          bookingId: row.booking_id,
          serviceRequestId: row.service_request_id,
          reference: row.booking_id ? reference(row.booking_id) : null,
          title:
            booking?.service?.title ??
            booking?.serviceRequest?.title ??
            request?.title ??
            'Conversation',
          counterpartyName: counterparty,
          area: area || null,
          status: booking?.status ?? null,
          scheduledStart: booking?.scheduledStart ?? null,
          unread: Number(row.unread),
          lastMessage: {
            body: row.body,
            messageType: row.message_type,
            createdAt: row.created_at,
            mine: row.sender_id === user.id,
          },
        };
      });
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
    dto: { bookingId?: string; serviceRequestId?: string },
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

/**
 * The short form of an id, as every booking screen prints it. Eight hex
 * characters is enough to tell one of somebody's jobs from another, and short
 * enough to read out over the phone.
 */
function reference(id: string): string {
  return id.slice(0, 8);
}
