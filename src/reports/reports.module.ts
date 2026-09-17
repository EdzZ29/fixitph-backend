import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WRITE_THROTTLE } from '../common/throttle';
import { ReportReason, ReportTargetType, UserRole } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiError } from '../common/errors';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  PaginationDto,
  paginate,
  type Paginated,
} from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthContext, type AuthenticatedUser } from '../common/types';

export class CreateReportDto {
  @IsEnum(ReportTargetType)
  targetType!: ReportTargetType;

  @IsUUID()
  targetId!: string;

  @IsEnum(ReportReason)
  reason!: ReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  details?: string;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The target is polymorphic, so there is no foreign key to lean on. Existence
   * is checked here instead, which also stops the table filling with reports
   * against ids that were never real.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateReportDto,
  ): Promise<unknown> {
    const exists = await this.targetExists(dto.targetType, dto.targetId);
    if (!exists)
      throw ApiError.notFound(
        'TARGET_NOT_FOUND',
        'There is nothing to report there.',
      );

    const duplicate = await this.prisma.report.findFirst({
      where: {
        reporterId: user.id,
        targetType: dto.targetType,
        targetId: dto.targetId,
      },
      select: { id: true },
    });
    if (duplicate) {
      throw ApiError.conflict(
        'ALREADY_REPORTED',
        'You have already reported this.',
      );
    }

    return this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.report.create({
        data: {
          reporterId: user.id,
          targetType: dto.targetType,
          targetId: dto.targetId,
          reason: dto.reason,
          details: dto.details ?? null,
        },
        select: { id: true, status: true, createdAt: true },
      }),
    );
  }

  /** A reporter sees their own reports. Admins see everything, via /api/admin. */
  async listMine(
    user: AuthenticatedUser,
    dto: PaginationDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const where = user.role === UserRole.ADMIN ? {} : { reporterId: user.id };

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
            resolvedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.report.count({ where }),
      ]);
      return paginate(items, total, dto);
    });
  }

  private async targetExists(
    type: ReportTargetType,
    id: string,
  ): Promise<boolean> {
    switch (type) {
      case ReportTargetType.USER:
        return !!(await this.prisma.user.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        }));
      case ReportTargetType.PROVIDER:
        return !!(await this.prisma.provider.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        }));
      case ReportTargetType.SERVICE:
        return !!(await this.prisma.service.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        }));
      case ReportTargetType.REVIEW:
        return !!(await this.prisma.review.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        }));
      case ReportTargetType.MESSAGE:
        return !!(await this.prisma.message.findUnique({
          where: { id },
          select: { id: true },
        }));
      case ReportTargetType.BOOKING:
        return !!(await this.prisma.booking.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        }));
      default:
        return false;
    }
  }
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @Throttle({ write: WRITE_THROTTLE.report })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReportDto) {
    return this.reports.create(user, dto);
  }

  @Get()
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: PaginationDto,
  ) {
    return this.reports.listMine(user, dto);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
