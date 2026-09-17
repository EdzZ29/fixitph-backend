import { Injectable } from '@nestjs/common';
import {
  AdminActionTargetType,
  AdminActionType,
  BookingStatus,
  DisputeStatus,
  NotificationType,
  Prisma,
  ReportStatus,
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
  ListAdminUsersDto,
  ResolveDisputeDto,
  ResolveReportDto,
  ReviewDocumentDto,
  SuspendUserDto,
  VerifyProviderDto,
} from './dto/admin.dto';

/** Request details worth keeping alongside an audit row. */
export interface AdminRequestMeta {
  ip?: string;
  userAgent?: string;
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
