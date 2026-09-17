import { Injectable } from '@nestjs/common';
import {
  AdminActionTargetType,
  AdminActionType,
  BookingStatus,
  DisputeStatus,
  NotificationType,
  Prisma,
  ReportStatus,
  ReportTargetType,
  ServiceStatus,
  SettingValueType,
  UserStatus,
  VerificationStatus,
} from '@prisma/client';
import { ApiError } from '../common/errors';
import { CacheService } from '../cache/cache.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  paginate,
  type Paginated,
  type PaginationDto,
} from '../common/dto/pagination.dto';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import type {
  ListAdminDisputesDto,
  ListAdminReportsDto,
  ListAdminReviewsDto,
  ListAdminServicesDto,
  ListAdminUsersDto,
  ModerateServiceDto,
  ResolveDisputeDto,
  ResolveReportDto,
  ReviewDocumentDto,
  ReviewVisibilityDto,
  SuspendUserDto,
  UpdateSettingsDto,
  VerifyProviderDto,
} from './dto/admin.dto';

/** Request details worth keeping alongside an audit row. */
export interface AdminRequestMeta {
  ip?: string;
  userAgent?: string;
}

/** A report's target, resolved into something an admin can read. */
export interface ReportTarget {
  kind: ReportTargetType;
  label: string;
  detail: string;
}

/** Dispute states that still need an admin to do something. */
const OPEN_DISPUTE_STATUSES: DisputeStatus[] = [
  DisputeStatus.OPEN,
  DisputeStatus.UNDER_REVIEW,
  DisputeStatus.AWAITING_CUSTOMER,
  DisputeStatus.AWAITING_PROVIDER,
  DisputeStatus.ESCALATED,
];

/** Report states that are still in the queue. */
const OPEN_REPORT_STATUSES: ReportStatus[] = [
  ReportStatus.OPEN,
  ReportStatus.UNDER_REVIEW,
];

/**
 * admin_actions.target_id is a uuid column, and a platform setting is keyed
 * by name. Settings changes are recorded against this fixed sentinel id, with
 * the key itself in `reason` and in the before/after payloads, so the audit
 * trail stays queryable without widening the column.
 */
const SETTINGS_TARGET_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Checks a submitted setting value against the type the setting declares, and
 * returns it in the shape the JSON column stores. The value_type column is
 * the only description of a setting's type, so this is the one place that can
 * enforce it: class-validator cannot, because it does not know the key.
 */
function coerceSettingValue(
  key: string,
  valueType: SettingValueType,
  raw: unknown,
): Prisma.InputJsonValue {
  switch (valueType) {
    case SettingValueType.STRING: {
      if (typeof raw !== 'string') {
        throw ApiError.badRequest(
          'SETTING_TYPE_MISMATCH',
          `${key} takes text.`,
        );
      }
      if (raw.length > 2000) {
        throw ApiError.badRequest(
          'SETTING_TOO_LONG',
          `${key} is limited to 2000 characters.`,
        );
      }
      return raw;
    }
    case SettingValueType.NUMBER: {
      // A number arriving as a string from a form field is the normal case,
      // not an error, so it is converted rather than rejected. An *empty*
      // string is rejected though: Number('') is 0, which would silently
      // store a cleared field as zero.
      if (typeof raw === 'string' && raw.trim() === '') {
        throw ApiError.badRequest(
          'SETTING_REQUIRED',
          `${key} needs a number. Leaving it empty is not the same as zero.`,
        );
      }
      const value = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw ApiError.badRequest(
          'SETTING_TYPE_MISMATCH',
          `${key} takes a number.`,
        );
      }
      return value;
    }
    case SettingValueType.BOOLEAN: {
      const value = raw === 'true' ? true : raw === 'false' ? false : raw;
      if (typeof value !== 'boolean') {
        throw ApiError.badRequest(
          'SETTING_TYPE_MISMATCH',
          `${key} is on or off.`,
        );
      }
      return value;
    }
    case SettingValueType.JSON: {
      // Must be an object or an array. Accepting a bare string here is how
      // a half-typed editor ends up writing its own raw text into the
      // column, after which everything reading the setting as an object
      // breaks.
      if (typeof raw !== 'object' || raw === null) {
        throw ApiError.badRequest(
          'SETTING_TYPE_MISMATCH',
          `${key} takes a JSON object or array.`,
        );
      }
      return raw;
    }
  }
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Business rule 10. Every admin action goes through here, so the audit row
   * is written by the same transaction as the change it records. If the change
   * rolls back the audit row goes with it, and if the audit insert fails the
   * change does not happen. admin_actions itself is insert-only, enforced by
   * revoked privileges and a trigger.
   */
  private async audit(
    tx: Tx,
    admin: AuthenticatedUser,
    entry: {
      actionType: AdminActionType;
      targetType: AdminActionTargetType;
      targetId: string;
      reason?: string;
      before?: unknown;
      after?: unknown;
    },
    meta: AdminRequestMeta,
  ): Promise<void> {
    await tx.adminAction.create({
      data: {
        adminId: admin.id,
        actionType: entry.actionType,
        targetType: entry.targetType,
        targetId: entry.targetId,
        reason: entry.reason ?? null,
        before: (entry.before as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        after: (entry.after as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });
  }

  // -- overview --------------------------------------------------------------

  /**
   * The counts behind the admin overview. Every figure is a count query rather
   * than a stored total, because a stale dashboard number is worse than a slow
   * one: these drive moderation decisions.
   */
  async stats(admin: AuthenticatedUser): Promise<{
    users: Record<string, number>;
    providers: Record<string, number>;
    bookings: Record<string, number>;
    queue: Record<string, number>;
    catalog: Record<string, number>;
  }> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const [
        usersByRole,
        usersByStatus,
        newUsers,
        providersByVerification,
        suspendedProviders,
        bookingsByStatus,
        bookingsLast30,
        pendingVerifications,
        openDisputes,
        openReports,
        activeServices,
        categories,
      ] = await Promise.all([
        tx.user.groupBy({
          by: ['role'],
          where: { deletedAt: null },
          _count: true,
          orderBy: { role: 'asc' },
        }),
        tx.user.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: true,
          orderBy: { status: 'asc' },
        }),
        tx.user.count({
          where: { deletedAt: null, createdAt: { gte: since } },
        }),
        tx.provider.groupBy({
          by: ['verificationStatus'],
          where: { deletedAt: null },
          _count: true,
          orderBy: { verificationStatus: 'asc' },
        }),
        tx.provider.count({
          where: { deletedAt: null, suspendedAt: { not: null } },
        }),
        tx.booking.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: true,
          orderBy: { status: 'asc' },
        }),
        tx.booking.count({
          where: { deletedAt: null, createdAt: { gte: since } },
        }),
        tx.provider.count({
          where: {
            deletedAt: null,
            verificationStatus: {
              in: [VerificationStatus.UNVERIFIED, VerificationStatus.PENDING],
            },
          },
        }),
        tx.dispute.count({
          where: {
            status: {
              in: [
                DisputeStatus.OPEN,
                DisputeStatus.UNDER_REVIEW,
                DisputeStatus.AWAITING_CUSTOMER,
                DisputeStatus.AWAITING_PROVIDER,
                DisputeStatus.ESCALATED,
              ],
            },
          },
        }),
        tx.report.count({
          where: {
            status: { in: [ReportStatus.OPEN, ReportStatus.UNDER_REVIEW] },
          },
        }),
        tx.service.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
        tx.category.count({ where: { isActive: true } }),
      ]);

      /** Turns a groupBy result into { <enum value>: count }. */
      const tally = <K extends string>(
        rows: ({ _count: number } & Record<K, string>)[],
        key: K,
      ): Record<string, number> =>
        Object.fromEntries(rows.map((row) => [row[key], row._count]));

      const bookings = tally(bookingsByStatus, 'status');
      const users = tally(usersByRole, 'role');

      return {
        users: {
          ...users,
          total: Object.values(users).reduce((a, b) => a + b, 0),
          newLast30Days: newUsers,
          suspended: tally(usersByStatus, 'status')[UserStatus.SUSPENDED] ?? 0,
        },
        providers: {
          ...tally(providersByVerification, 'verificationStatus'),
          suspended: suspendedProviders,
        },
        bookings: {
          ...bookings,
          total: Object.values(bookings).reduce((a, b) => a + b, 0),
          last30Days: bookingsLast30,
          live:
            (bookings[BookingStatus.PENDING_CONFIRMATION] ?? 0) +
            (bookings[BookingStatus.CONFIRMED] ?? 0) +
            (bookings[BookingStatus.IN_PROGRESS] ?? 0),
        },
        queue: {
          pendingVerifications,
          openDisputes,
          openReports,
          disputedBookings: bookings[BookingStatus.DISPUTED] ?? 0,
        },
        catalog: { activeServices, categories },
      };
    });
  }

  // -- users -----------------------------------------------------------------

  async listUsers(
    admin: AuthenticatedUser,
    dto: ListAdminUsersDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const where: Prisma.UserWhereInput = {
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.q
          ? {
              OR: [
                { email: { contains: dto.q, mode: 'insensitive' } },
                { phone: { contains: dto.q } },
              ],
            }
          : {}),
      };

      const [items, total] = await Promise.all([
        tx.user.findMany({
          where,
          select: {
            id: true,
            email: true,
            phone: true,
            role: true,
            status: true,
            failedLoginCount: true,
            lockedUntil: true,
            lastLoginAt: true,
            createdAt: true,
            deletedAt: true,
            profile: {
              select: { firstName: true, lastName: true, city: true },
            },
            provider: {
              select: {
                id: true,
                businessName: true,
                verificationStatus: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.user.count({ where }),
      ]);
      return paginate(items, total, dto);
    });
  }

  async suspendUser(
    admin: AuthenticatedUser,
    userId: string,
    dto: SuspendUserDto,
    meta: AdminRequestMeta,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const before = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true, status: true, role: true },
      });
      if (!before) throw ApiError.notFound('USER_NOT_FOUND');
      if (before.id === admin.id) {
        throw ApiError.badRequest(
          'CANNOT_SUSPEND_SELF',
          'You cannot suspend your own account.',
        );
      }

      const after = await tx.user.update({
        where: { id: userId },
        data: { status: UserStatus.SUSPENDED },
        select: { id: true, status: true },
      });

      // Suspending has to end the sessions, otherwise the existing access
      // token keeps working until it expires.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await tx.provider.updateMany({
        where: { userId },
        data: { suspendedAt: new Date(), isAcceptingBookings: false },
      });

      await this.audit(
        tx,
        admin,
        {
          actionType: AdminActionType.USER_SUSPEND,
          targetType: AdminActionTargetType.USER,
          targetId: userId,
          reason: dto.reason,
          before,
          after,
        },
        meta,
      );

      await this.cache.invalidateLists('providers');
      return after;
    });
  }

  async reinstateUser(
    admin: AuthenticatedUser,
    userId: string,
    dto: SuspendUserDto,
    meta: AdminRequestMeta,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const before = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!before) throw ApiError.notFound('USER_NOT_FOUND');

      const after = await tx.user.update({
        where: { id: userId },
        data: {
          status: UserStatus.ACTIVE,
          failedLoginCount: 0,
          lockedUntil: null,
        },
        select: { id: true, status: true },
      });

      await tx.provider.updateMany({
        where: { userId },
        data: { suspendedAt: null },
      });

      await this.audit(
        tx,
        admin,
        {
          actionType: AdminActionType.USER_REINSTATE,
          targetType: AdminActionTargetType.USER,
          targetId: userId,
          reason: dto.reason,
          before,
          after,
        },
        meta,
      );

      await this.cache.invalidateLists('providers');
      return after;
    });
  }

  // -- provider verification -------------------------------------------------

  async listPendingVerifications(
    admin: AuthenticatedUser,
    dto: PaginationDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const where: Prisma.ProviderWhereInput = {
        deletedAt: null,
        verificationStatus: {
          in: [VerificationStatus.UNVERIFIED, VerificationStatus.PENDING],
        },
      };

      const [items, total] = await Promise.all([
        tx.provider.findMany({
          where,
          select: {
            id: true,
            businessName: true,
            slug: true,
            baseCity: true,
            verificationStatus: true,
            createdAt: true,
            user: { select: { id: true, email: true, phone: true } },
            documents: {
              select: {
                id: true,
                documentType: true,
                status: true,
                originalFilename: true,
                createdAt: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.provider.count({ where }),
      ]);
      return paginate(items, total, dto);
    });
  }

  async verifyProvider(
    admin: AuthenticatedUser,
    providerId: string,
    dto: VerifyProviderDto,
    meta: AdminRequestMeta,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const before = await tx.provider.findFirst({
        where: { id: providerId, deletedAt: null },
        select: {
          id: true,
          verificationStatus: true,
          verifiedAt: true,
          userId: true,
        },
      });
      if (!before) throw ApiError.notFound('PROVIDER_NOT_FOUND');

      const approved = dto.decision === 'APPROVE';

      if (approved) {
        // Approving with nothing on file would defeat the point of verifying.
        const approvedDocs = await tx.providerDocument.count({
          where: { providerId, status: VerificationStatus.APPROVED },
        });
        if (approvedDocs === 0) {
          throw ApiError.conflict(
            'NO_APPROVED_DOCUMENTS',
            'Approve at least one document before verifying this provider.',
          );
        }
      }

      const after = await tx.provider.update({
        where: { id: providerId },
        data: {
          verificationStatus: approved
            ? VerificationStatus.APPROVED
            : VerificationStatus.REJECTED,
          // The CHECK constraint ties this to the status.
          verifiedAt: approved ? new Date() : null,
        },
        select: { id: true, verificationStatus: true, verifiedAt: true },
      });

      await tx.notification.create({
        data: {
          userId: before.userId,
          type: approved
            ? NotificationType.VERIFICATION_APPROVED
            : NotificationType.VERIFICATION_REJECTED,
          title: approved ? 'You are verified' : 'Verification needs more work',
          body:
            dto.reason ??
            (approved
              ? 'Your listings can go live now.'
              : 'Check your documents.'),
          data: { providerId },
        },
      });

      await this.audit(
        tx,
        admin,
        {
          actionType: approved
            ? AdminActionType.PROVIDER_VERIFICATION_APPROVE
            : AdminActionType.PROVIDER_VERIFICATION_REJECT,
          targetType: AdminActionTargetType.PROVIDER,
          targetId: providerId,
          reason: dto.reason,
          before,
          after,
        },
        meta,
      );

      await this.cache.invalidateResource('providers', providerId);
      return after;
    });
  }

  async reviewDocument(
    admin: AuthenticatedUser,
    documentId: string,
    dto: ReviewDocumentDto,
    meta: AdminRequestMeta,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const before = await tx.providerDocument.findUnique({
        where: { id: documentId },
        select: {
          id: true,
          status: true,
          providerId: true,
          documentType: true,
        },
      });
      if (!before) throw ApiError.notFound('DOCUMENT_NOT_FOUND');

      const approved = dto.decision === 'APPROVE';
      if (!approved && !dto.reason) {
        throw ApiError.badRequest(
          'REJECTION_REASON_REQUIRED',
          'Say why the document was rejected so the provider can fix it.',
        );
      }

      const after = await tx.providerDocument.update({
        where: { id: documentId },
        data: {
          status: approved
            ? VerificationStatus.APPROVED
            : VerificationStatus.REJECTED,
          reviewedById: admin.id,
          reviewedAt: new Date(),
          rejectionReason: approved ? null : dto.reason!,
        },
        select: { id: true, status: true, reviewedAt: true },
      });

      await this.audit(
        tx,
        admin,
        {
          actionType: approved
            ? AdminActionType.DOCUMENT_APPROVE
            : AdminActionType.DOCUMENT_REJECT,
          targetType: AdminActionTargetType.PROVIDER_DOCUMENT,
          targetId: documentId,
          reason: dto.reason,
          before,
          after,
        },
        meta,
      );

      return after;
    });
  }

  // -- disputes and reports --------------------------------------------------

  async resolveDispute(
    admin: AuthenticatedUser,
    disputeId: string,
    dto: ResolveDisputeDto,
    meta: AdminRequestMeta,
  ): Promise<unknown> {
    return this.prisma.withUser(
      toAuthContext(admin),
      async (tx) => {
        const before = await tx.dispute.findUnique({
          where: { id: disputeId },
          select: {
            id: true,
            status: true,
            bookingId: true,
            booking: { select: { status: true, customerId: true } },
          },
        });
        if (!before) throw ApiError.notFound('DISPUTE_NOT_FOUND');

        const after = await tx.dispute.update({
          where: { id: disputeId },
          data: {
            status: dto.status,
            resolution: dto.resolution,
            refundAmount: dto.refundAmount ?? null,
            resolvedById: admin.id,
            resolvedAt: new Date(),
          },
          select: {
            id: true,
            status: true,
            resolution: true,
            refundAmount: true,
            resolvedAt: true,
          },
        });

        // Put the booking back into a terminal state that matches the ruling.
        if (before.booking.status === BookingStatus.DISPUTED) {
          const target =
            dto.status === DisputeStatus.RESOLVED_REFUND
              ? BookingStatus.CANCELLED_BY_PROVIDER
              : BookingStatus.COMPLETED;
          await tx.booking.update({
            where: { id: before.bookingId },
            data: {
              status: target,
              ...(target === BookingStatus.COMPLETED
                ? { completedAt: new Date() }
                : {}),
              ...(target === BookingStatus.CANCELLED_BY_PROVIDER
                ? {
                    cancelledAt: new Date(),
                    cancelledById: admin.id,
                    cancellationReason: dto.resolution,
                  }
                : {}),
            },
          });
        }

        await tx.notification.create({
          data: {
            userId: before.booking.customerId,
            type: NotificationType.DISPUTE_UPDATE,
            title: 'Your dispute has been decided',
            body: dto.resolution,
            data: { disputeId },
          },
        });

        await this.audit(
          tx,
          admin,
          {
            actionType: AdminActionType.DISPUTE_RESOLVE,
            targetType: AdminActionTargetType.DISPUTE,
            targetId: disputeId,
            reason: dto.resolution,
            before,
            after,
          },
          meta,
        );

        return after;
      },
      { statusChangeReason: `dispute resolved by admin: ${dto.resolution}` },
    );
  }

  async resolveReport(
    admin: AuthenticatedUser,
    reportId: string,
    dto: ResolveReportDto,
    meta: AdminRequestMeta,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const before = await tx.report.findUnique({
        where: { id: reportId },
        select: { id: true, status: true, targetType: true, targetId: true },
      });
      if (!before) throw ApiError.notFound('REPORT_NOT_FOUND');

      const after = await tx.report.update({
        where: { id: reportId },
        data: {
          status: dto.status ?? ReportStatus.RESOLVED,
          resolutionNotes: dto.notes,
          resolvedById: admin.id,
          resolvedAt: new Date(),
        },
        select: { id: true, status: true, resolvedAt: true },
      });

      // Optionally hide the reported review as part of the same decision.
      if (dto.hideReview && before.targetType === 'REVIEW') {
        await tx.review.update({
          where: { id: before.targetId },
          data: { isHidden: true },
        });
        await this.audit(
          tx,
          admin,
          {
            actionType: AdminActionType.REVIEW_TAKEDOWN,
            targetType: AdminActionTargetType.REVIEW,
            targetId: before.targetId,
            reason: dto.notes,
          },
          meta,
        );
      }

      await this.audit(
        tx,
        admin,
        {
          actionType: AdminActionType.REPORT_RESOLVE,
          targetType: AdminActionTargetType.REPORT,
          targetId: reportId,
          reason: dto.notes,
          before,
          after,
        },
        meta,
      );

      return after;
    });
  }

  // -- audit trail -----------------------------------------------------------

  // -- listing moderation ----------------------------------------------------

  /**
   * Every listing on the platform, at any status and from any provider. The
   * public /services list cannot serve this screen: it shows only ACTIVE rows
   * belonging to approved providers, which is the opposite of what moderation
   * needs to look at.
   */
  async listServices(
    admin: AuthenticatedUser,
    dto: ListAdminServicesDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const where: Prisma.ServiceWhereInput = {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.providerId ? { providerId: dto.providerId } : {}),
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.q
          ? {
              OR: [
                { title: { contains: dto.q, mode: 'insensitive' } },
                {
                  provider: {
                    businessName: { contains: dto.q, mode: 'insensitive' },
                  },
                },
              ],
            }
          : {}),
      };

      const [items, total] = await Promise.all([
        tx.service.findMany({
          where,
          select: {
            id: true,
            title: true,
            slug: true,
            description: true,
            status: true,
            pricingType: true,
            price: true,
            priceUnit: true,
            currency: true,
            createdAt: true,
            updatedAt: true,
            deletedAt: true,
            category: { select: { id: true, name: true } },
            provider: {
              select: {
                id: true,
                businessName: true,
                slug: true,
                baseCity: true,
                verificationStatus: true,
                suspendedAt: true,
                user: { select: { id: true, email: true } },
              },
            },
            _count: { select: { bookings: true } },
          },
          orderBy: { updatedAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.service.count({ where }),
      ]);
      return paginate(items, total, dto);
    });
  }

  /**
   * Takes a listing down, pauses it, or puts it back. A takedown archives and
   * soft-deletes, which is what drops it out of every public read path; the
   * row itself stays, because bookings reference it.
   */
  async moderateService(
    admin: AuthenticatedUser,
    serviceId: string,
    dto: ModerateServiceDto,
    meta: AdminRequestMeta,
  ): Promise<unknown> {
    const result = await this.prisma.withUser(
      toAuthContext(admin),
      async (tx) => {
        const service = await tx.service.findUnique({
          where: { id: serviceId },
          select: {
            id: true,
            providerId: true,
            title: true,
            status: true,
            deletedAt: true,
          },
        });
        if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

        if (dto.action !== 'REINSTATE' && service.deletedAt) {
          throw ApiError.conflict(
            'SERVICE_ALREADY_DOWN',
            'That listing has already been taken down.',
          );
        }

        const next =
          dto.action === 'TAKE_DOWN'
            ? { status: ServiceStatus.ARCHIVED, deletedAt: new Date() }
            : dto.action === 'PAUSE'
              ? { status: ServiceStatus.PAUSED, deletedAt: null }
              : // Back as a draft, so the provider has to republish knowingly.
                { status: ServiceStatus.DRAFT, deletedAt: null };

        const updated = await tx.service.update({
          where: { id: serviceId },
          data: next,
          select: { id: true, title: true, status: true, deletedAt: true },
        });

        await this.audit(
          tx,
          admin,
          {
            actionType: AdminActionType.SERVICE_TAKEDOWN,
            targetType: AdminActionTargetType.SERVICE,
            targetId: serviceId,
            reason: `${dto.action}: ${dto.reason}`,
            before: { status: service.status, deletedAt: service.deletedAt },
            after: { status: updated.status, deletedAt: updated.deletedAt },
          },
          meta,
        );

        return { updated, providerId: service.providerId };
      },
    );

    await this.cache.invalidateLists('services');
    await this.cache.invalidateResource('services', serviceId);
    await this.cache.invalidateResource('providers', result.providerId);
    return result.updated;
  }

  // -- review moderation -----------------------------------------------------

  /**
   * The review moderation queue. filter=reported is the one that matters in
   * practice: it narrows to reviews with an open report against them, so an
   * admin is not reading every five-star review looking for the bad one.
   */
  async listReviews(
    admin: AuthenticatedUser,
    dto: ListAdminReviewsDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      // Reports are polymorphic, so there is no relation to filter on. The
      // ids are fetched first and narrow the review query.
      const reportedIds =
        dto.filter === 'reported'
          ? (
              await tx.report.findMany({
                where: {
                  targetType: ReportTargetType.REVIEW,
                  status: {
                    in: [ReportStatus.OPEN, ReportStatus.UNDER_REVIEW],
                  },
                },
                select: { targetId: true },
                distinct: ['targetId'],
                take: 500,
              })
            ).map((row) => row.targetId)
          : null;

      const where: Prisma.ReviewWhereInput = {
        deletedAt: null,
        ...(dto.providerId ? { providerId: dto.providerId } : {}),
        ...(dto.filter === 'hidden' ? { isHidden: true } : {}),
        ...(dto.filter === 'visible' ? { isHidden: false } : {}),
        ...(reportedIds ? { id: { in: reportedIds } } : {}),
        ...(dto.maxRating !== undefined
          ? { rating: { lte: dto.maxRating } }
          : {}),
      };

      const [items, total] = await Promise.all([
        tx.review.findMany({
          where,
          select: {
            id: true,
            bookingId: true,
            rating: true,
            comment: true,
            providerResponse: true,
            isHidden: true,
            createdAt: true,
            updatedAt: true,
            author: {
              select: {
                id: true,
                email: true,
                profile: { select: { firstName: true, lastName: true } },
              },
            },
            provider: { select: { id: true, businessName: true, slug: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.review.count({ where }),
      ]);

      // Open report counts, for the rows on this page only.
      const ids = items.map((review) => review.id);
      const grouped = ids.length
        ? await tx.report.groupBy({
            by: ['targetId'],
            where: {
              targetType: ReportTargetType.REVIEW,
              targetId: { in: ids },
              status: { in: [ReportStatus.OPEN, ReportStatus.UNDER_REVIEW] },
            },
            _count: true,
            orderBy: { targetId: 'asc' },
          })
        : [];
      const reportsById = new Map(
        grouped.map((row) => [row.targetId, row._count]),
      );

      return paginate(
        items.map((review) => ({
          ...review,
          openReports: reportsById.get(review.id) ?? 0,
        })),
        total,
        dto,
      );
    });
  }

  /**
   * Hides or restores a review. Hiding takes it out of the public listing and
   * out of the provider's rating, which is why it is audited rather than
   * being a plain update.
   */
  async setReviewVisibility(
    admin: AuthenticatedUser,
    reviewId: string,
    dto: ReviewVisibilityDto,
    meta: AdminRequestMeta,
  ): Promise<unknown> {
    const result = await this.prisma.withUser(
      toAuthContext(admin),
      async (tx) => {
        const review = await tx.review.findFirst({
          where: { id: reviewId, deletedAt: null },
          select: { id: true, isHidden: true, providerId: true },
        });
        if (!review) throw ApiError.notFound('REVIEW_NOT_FOUND');

        if (review.isHidden === dto.hidden) {
          throw ApiError.conflict(
            'REVIEW_VISIBILITY_UNCHANGED',
            dto.hidden
              ? 'That review is already hidden.'
              : 'That review is already visible.',
          );
        }

        const updated = await tx.review.update({
          where: { id: reviewId },
          data: { isHidden: dto.hidden },
          select: { id: true, isHidden: true, providerId: true },
        });

        /**
         * providers.rating_avg and rating_count are maintained by the
         * application, not a trigger, and they aggregate over visible
         * reviews only. Without this the hidden review keeps counting: the
         * profile would read "3.2 from 5 reviews" with four on screen.
         *
         * Recomputed inside the same transaction as the visibility change,
         * so the two can never disagree.
         */
        await this.recomputeProviderRating(tx, review.providerId);

        await this.audit(
          tx,
          admin,
          {
            actionType: AdminActionType.REVIEW_TAKEDOWN,
            targetType: AdminActionTargetType.REVIEW,
            targetId: reviewId,
            reason: `${dto.hidden ? 'hidden' : 'restored'}: ${dto.reason}`,
            before: { isHidden: review.isHidden },
            after: { isHidden: updated.isHidden },
          },
          meta,
        );

        return updated;
      },
    );

    await this.cache.invalidateResource('providers', result.providerId);
    await this.cache.invalidateLists('providers');
    return result;
  }

  /**
   * Recomputes a provider's rating aggregate from their visible reviews.
   *
   * Deliberately a copy of the aggregate in ReviewsService rather than a call
   * into it: this one has to run inside an admin transaction that already
   * holds the row, and the two modules would otherwise depend on each other.
   * The `isHidden: false` and `deletedAt: null` filters are the contract —
   * change them here and they have to change there too.
   */
  private async recomputeProviderRating(
    tx: Tx,
    providerId: string,
  ): Promise<void> {
    const aggregate = await tx.review.aggregate({
      where: { providerId, deletedAt: null, isHidden: false },
      _avg: { rating: true },
      _count: { _all: true },
    });

    await tx.provider.update({
      where: { id: providerId },
      data: {
        ratingAvg: aggregate._avg.rating ?? 0,
        ratingCount: aggregate._count._all,
      },
    });
  }

  // -- moderation queues -----------------------------------------------------

  /** Disputes across the platform, with enough booking context to triage. */
  async listDisputes(
    admin: AuthenticatedUser,
    dto: ListAdminDisputesDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const where: Prisma.DisputeWhereInput = dto.status
        ? { status: dto.status }
        : dto.openOnly
          ? { status: { in: OPEN_DISPUTE_STATUSES } }
          : {};

      const [items, total] = await Promise.all([
        tx.dispute.findMany({
          where,
          select: {
            id: true,
            bookingId: true,
            reason: true,
            details: true,
            status: true,
            resolution: true,
            refundAmount: true,
            resolvedAt: true,
            createdAt: true,
            raisedBy: {
              select: {
                id: true,
                email: true,
                role: true,
                profile: { select: { firstName: true, lastName: true } },
              },
            },
            booking: {
              select: {
                id: true,
                status: true,
                totalAmount: true,
                currency: true,
                scheduledStart: true,
                completedAt: true,
                customerId: true,
                provider: {
                  select: { id: true, businessName: true, slug: true },
                },
                service: { select: { id: true, title: true } },
              },
            },
          },
          // Unresolved first, then oldest first. A queue, not a news feed:
          // the thing that has been waiting longest is the thing to do next.
          orderBy: [
            { resolvedAt: { sort: 'asc', nulls: 'first' } },
            { createdAt: 'asc' },
          ],
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.dispute.count({ where }),
      ]);
      return paginate(items, total, dto);
    });
  }

  /**
   * The report queue. Ordered like the dispute queue, and each row's
   * polymorphic target is resolved into something readable.
   */
  async listReports(
    admin: AuthenticatedUser,
    dto: ListAdminReportsDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const where: Prisma.ReportWhereInput = {
        ...(dto.targetType ? { targetType: dto.targetType } : {}),
        ...(dto.status
          ? { status: dto.status }
          : dto.openOnly
            ? { status: { in: OPEN_REPORT_STATUSES } }
            : {}),
      };

      const [items, total] = await Promise.all([
        tx.report.findMany({
          where,
          select: {
            id: true,
            targetType: true,
            targetId: true,
            reason: true,
            details: true,
            status: true,
            resolutionNotes: true,
            resolvedAt: true,
            createdAt: true,
            reporter: {
              select: {
                id: true,
                email: true,
                role: true,
                profile: { select: { firstName: true, lastName: true } },
              },
            },
            resolvedBy: { select: { id: true, email: true } },
          },
          orderBy: [
            { resolvedAt: { sort: 'asc', nulls: 'first' } },
            { createdAt: 'asc' },
          ],
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.report.count({ where }),
      ]);

      return paginate(await this.describeReportTargets(tx, items), total, dto);
    });
  }

  /**
   * Turns each report's (targetType, targetId) pair into something an admin
   * can read. One query per type present on the page, rather than one per row.
   */
  private async describeReportTargets<
    T extends { targetType: ReportTargetType; targetId: string },
  >(tx: Tx, reports: T[]): Promise<(T & { target: ReportTarget | null })[]> {
    const idsByType = new Map<ReportTargetType, string[]>();
    for (const report of reports) {
      const ids = idsByType.get(report.targetType) ?? [];
      ids.push(report.targetId);
      idsByType.set(report.targetType, ids);
    }

    const described = new Map<string, ReportTarget>();

    for (const [type, ids] of idsByType) {
      switch (type) {
        case ReportTargetType.USER: {
          const rows = await tx.user.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              email: true,
              role: true,
              status: true,
              profile: { select: { firstName: true, lastName: true } },
            },
          });
          for (const row of rows) {
            described.set(row.id, {
              kind: type,
              label: row.profile
                ? `${row.profile.firstName} ${row.profile.lastName}`
                : row.email,
              detail: `${row.role} - ${row.status}`,
            });
          }
          break;
        }
        case ReportTargetType.PROVIDER: {
          const rows = await tx.provider.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              businessName: true,
              baseCity: true,
              verificationStatus: true,
            },
          });
          for (const row of rows) {
            described.set(row.id, {
              kind: type,
              label: row.businessName,
              detail: `${row.baseCity} - ${row.verificationStatus}`,
            });
          }
          break;
        }
        case ReportTargetType.SERVICE: {
          const rows = await tx.service.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              title: true,
              status: true,
              provider: { select: { businessName: true } },
            },
          });
          for (const row of rows) {
            described.set(row.id, {
              kind: type,
              label: row.title,
              detail: `${row.provider.businessName} - ${row.status}`,
            });
          }
          break;
        }
        case ReportTargetType.REVIEW: {
          const rows = await tx.review.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              rating: true,
              comment: true,
              isHidden: true,
              provider: { select: { businessName: true } },
            },
          });
          for (const row of rows) {
            described.set(row.id, {
              kind: type,
              label: `${row.rating} stars on ${row.provider.businessName}`,
              detail: row.isHidden
                ? 'already hidden'
                : (row.comment?.slice(0, 140) ?? 'no comment'),
            });
          }
          break;
        }
        case ReportTargetType.BOOKING: {
          const rows = await tx.booking.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              status: true,
              provider: { select: { businessName: true } },
            },
          });
          for (const row of rows) {
            described.set(row.id, {
              kind: type,
              label: `Booking with ${row.provider.businessName}`,
              detail: row.status,
            });
          }
          break;
        }
        case ReportTargetType.MESSAGE: {
          const rows = await tx.message.findMany({
            where: { id: { in: ids } },
            select: { id: true, body: true, createdAt: true },
          });
          for (const row of rows) {
            described.set(row.id, {
              kind: type,
              label: row.body.slice(0, 140),
              detail: row.createdAt.toISOString(),
            });
          }
          break;
        }
      }
    }

    return reports.map((report) => ({
      ...report,
      target: described.get(report.targetId) ?? null,
    }));
  }

  // -- platform settings -----------------------------------------------------

  /** Every setting, ordered the way the settings screen groups them. */
  async listSettings(admin: AuthenticatedUser): Promise<{ items: unknown[] }> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const items = await tx.platformSetting.findMany({
        select: {
          key: true,
          value: true,
          valueType: true,
          label: true,
          description: true,
          group: true,
          position: true,
          isPublic: true,
          isEditable: true,
          updatedAt: true,
          updatedBy: { select: { id: true, email: true } },
        },
        orderBy: [{ group: 'asc' }, { position: 'asc' }, { key: 'asc' }],
      });
      return { items };
    });
  }

  /**
   * Writes a batch of settings in one transaction, one audit row per setting
   * actually changed. A batch rather than a route per key, because the screen
   * saves a whole group at once and a half-applied group is a bad state to
   * leave the platform in.
   */
  async updateSettings(
    admin: AuthenticatedUser,
    dto: UpdateSettingsDto,
    meta: AdminRequestMeta,
  ): Promise<{ updated: { key: string; value: Prisma.JsonValue }[] }> {
    // Two changes to one key in one batch means the caller does not know what
    // it is asking for. Rejected before anything is written.
    const keys = new Set<string>();
    for (const change of dto.changes) {
      if (keys.has(change.key)) {
        throw ApiError.badRequest(
          'DUPLICATE_SETTING_KEY',
          `The key ${change.key} appears twice in this batch.`,
        );
      }
      keys.add(change.key);
    }

    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const existing = await tx.platformSetting.findMany({
        where: { key: { in: [...keys] } },
        select: { key: true, value: true, valueType: true, isEditable: true },
      });
      const byKey = new Map(existing.map((row) => [row.key, row]));

      const missing = [...keys].filter((key) => !byKey.has(key));
      if (missing.length) {
        throw ApiError.notFound(
          'SETTING_NOT_FOUND',
          `No such setting: ${missing.join(', ')}.`,
        );
      }

      const locked = existing.filter((row) => !row.isEditable);
      if (locked.length) {
        throw ApiError.forbidden(
          'SETTING_NOT_EDITABLE',
          `Not editable from here: ${locked.map((row) => row.key).join(', ')}.`,
        );
      }

      const updated: { key: string; value: Prisma.JsonValue }[] = [];

      for (const change of dto.changes) {
        const setting = byKey.get(change.key)!;
        const value = coerceSettingValue(
          change.key,
          setting.valueType,
          change.value,
        );

        // A no-op is not worth an audit row.
        if (JSON.stringify(setting.value) === JSON.stringify(value)) {
          updated.push({ key: setting.key, value: setting.value });
          continue;
        }

        const row = await tx.platformSetting.update({
          where: { key: change.key },
          data: { value, updatedById: admin.id },
          select: { key: true, value: true },
        });

        await this.audit(
          tx,
          admin,
          {
            actionType: AdminActionType.SETTING_UPDATE,
            targetType: AdminActionTargetType.SETTING,
            // admin_actions.target_id is a uuid column and a setting key is
            // not one, so the key travels in the reason and the payloads.
            targetId: SETTINGS_TARGET_ID,
            reason: `setting ${change.key}`,
            before: { key: change.key, value: setting.value },
            after: { key: change.key, value: row.value },
          },
          meta,
        );

        updated.push(row);
      }

      return { updated };
    });
  }

  async listAuditLog(
    admin: AuthenticatedUser,
    dto: PaginationDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(admin), async (tx) => {
      const [items, total] = await Promise.all([
        tx.adminAction.findMany({
          select: {
            id: true,
            actionType: true,
            targetType: true,
            targetId: true,
            reason: true,
            before: true,
            after: true,
            ipAddress: true,
            createdAt: true,
            admin: { select: { id: true, email: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.adminAction.count(),
      ]);
      return paginate(items, total, dto);
    });
  }
}
