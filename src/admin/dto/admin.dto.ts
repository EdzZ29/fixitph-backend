import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  DisputeStatus,
  ReportStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class ListAdminUsersDto extends PaginationDto {
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  q?: string;
}

export class SuspendUserDto {
  /** Required. An audit row with no stated reason is close to worthless. */
  @IsString()
  @MinLength(10, {
    message: 'Give a reason of at least 10 characters for the audit log.',
  })
  @MaxLength(1000)
  reason!: string;
}

export class VerifyProviderDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ReviewDocumentDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ResolveDisputeDto {
  @IsEnum([
    DisputeStatus.RESOLVED_REFUND,
    DisputeStatus.RESOLVED_PARTIAL_REFUND,
    DisputeStatus.RESOLVED_NO_ACTION,
  ])
  status!:
    | typeof DisputeStatus.RESOLVED_REFUND
    | typeof DisputeStatus.RESOLVED_PARTIAL_REFUND
    | typeof DisputeStatus.RESOLVED_NO_ACTION;

  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  resolution!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  refundAmount?: number;
}

export class ResolveReportDto {
  @IsOptional()
  @IsEnum([
    ReportStatus.RESOLVED,
    ReportStatus.DISMISSED,
    ReportStatus.UNDER_REVIEW,
  ])
  status?:
    | typeof ReportStatus.RESOLVED
    | typeof ReportStatus.DISMISSED
    | typeof ReportStatus.UNDER_REVIEW;

  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  notes!: string;

  @IsOptional()
  @IsBoolean()
  hideReview?: boolean;
}
