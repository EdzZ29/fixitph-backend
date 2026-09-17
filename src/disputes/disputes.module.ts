import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { BookingStatus, DisputeStatus, UserRole } from '@prisma/client';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiError } from '../common/errors';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  PaginationDto,
  paginate,
  type Paginated,
} from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthContext, type AuthenticatedUser } from '../common/types';

export class CreateDisputeDto {
  @IsUUID()
  bookingId!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(200)
  reason!: string;

  @IsString()
  @MinLength(20, {
    message: 'Explain what went wrong in at least 20 characters.',
  })
  @MaxLength(4000)
  details!: string;
}

@Injectable()
export class DisputesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Either party to a booking may raise a dispute. Resolving one is an admin
   * action and lives in the admin module, where it writes admin_actions in the
   * same transaction.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateDisputeDto,
  ): Promise<unknown> {
    return this.prisma.withUser(
      toAuthContext(user),
      async (tx) => {
        const booking = await tx.booking.findFirst({
          where: { id: dto.bookingId, deletedAt: null },
          select: {
            id: true,
            status: true,
            customerId: true,
            providerId: true,
          },
        });
        if (!booking) throw ApiError.notFound('BOOKING_NOT_FOUND');

        const isParty =
          booking.customerId === user.id ||
          (!!user.providerId && booking.providerId === user.providerId);
        if (!isParty && user.role !== UserRole.ADMIN) {
          throw ApiError.forbidden(
            'NOT_A_PARTY',
            'You are not party to that booking.',
          );
        }

        // Disputing something that never got underway is not a dispute.
        const disputable: BookingStatus[] = [
          BookingStatus.IN_PROGRESS,
          BookingStatus.COMPLETED,
          BookingStatus.NO_SHOW_CUSTOMER,
          BookingStatus.NO_SHOW_PROVIDER,
        ];
        if (!disputable.includes(booking.status)) {
          throw ApiError.conflict(
            'BOOKING_NOT_DISPUTABLE',
            `A ${booking.status.toLowerCase()} booking cannot be disputed.`,
          );
        }

        const open = await tx.dispute.findFirst({
          where: {
            bookingId: dto.bookingId,
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
          select: { id: true },
        });
        if (open) {
          throw ApiError.conflict(
            'DISPUTE_ALREADY_OPEN',
            'There is already an open dispute on this booking.',
          );
        }

        const dispute = await tx.dispute.create({
          data: {
            bookingId: dto.bookingId,
            raisedById: user.id,
            reason: dto.reason,
            details: dto.details,
          },
          select: { id: true, status: true, reason: true, createdAt: true },
        });

        if (
          booking.status !== BookingStatus.NO_SHOW_CUSTOMER &&
          booking.status !== BookingStatus.NO_SHOW_PROVIDER
        ) {
          await tx.booking.update({
            where: { id: dto.bookingId },
            data: { status: BookingStatus.DISPUTED },
          });
        }

        return dispute;
      },
      { statusChangeReason: `dispute raised: ${dto.reason}` },
    );
  }

  async listMine(
    user: AuthenticatedUser,
    dto: PaginationDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const where =
        user.role === UserRole.ADMIN
          ? {}
          : {
              OR: [
                { raisedById: user.id },
                { booking: { customerId: user.id } },
                ...(user.providerId
                  ? [{ booking: { providerId: user.providerId } }]
                  : []),
              ],
            };

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
          },
          orderBy: { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.dispute.count({ where }),
      ]);
      return paginate(items, total, dto);
    });
  }

  async findOne(user: AuthenticatedUser, id: string): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const dispute = await tx.dispute.findUnique({
        where: { id },
        select: {
          id: true,
          bookingId: true,
          raisedById: true,
          reason: true,
          details: true,
          status: true,
          resolution: true,
          refundAmount: true,
          resolvedAt: true,
          createdAt: true,
          booking: {
            select: { customerId: true, providerId: true, status: true },
          },
        },
      });
      if (!dispute) throw ApiError.notFound('DISPUTE_NOT_FOUND');

      const isParty =
        dispute.booking.customerId === user.id ||
        (!!user.providerId && dispute.booking.providerId === user.providerId);
      if (!isParty && user.role !== UserRole.ADMIN) {
        throw ApiError.forbidden(
          'NOT_A_PARTY',
          'You are not party to that dispute.',
        );
      }
      return dispute;
    });
  }
}

@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDisputeDto,
  ) {
    return this.disputes.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() dto: PaginationDto) {
    return this.disputes.listMine(user, dto);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.disputes.findOne(user, id);
  }
}

@Module({
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
