import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  DisputeStatus,
  ReportStatus,
  ReportTargetType,
  ServiceStatus,
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

// ---------------------------------------------------------------------------
// Listing moderation
// ---------------------------------------------------------------------------

export class ListAdminServicesDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ServiceStatus)
  status?: ServiceStatus;

  @IsOptional()
  @IsUUID()
  providerId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** Matches the title or the provider's business name. */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  q?: string;
}

export class ModerateServiceDto {
  /**
   * TAKE_DOWN archives the listing and hides it everywhere. PAUSE leaves it
   * recoverable by the provider. REINSTATE puts a taken-down listing back as
   * a draft, so the provider has to publish it deliberately.
   */
  @IsIn(['TAKE_DOWN', 'PAUSE', 'REINSTATE'])
  action!: 'TAKE_DOWN' | 'PAUSE' | 'REINSTATE';

  @IsString()
  @MinLength(10, {
    message: 'Give a reason of at least 10 characters for the audit log.',
  })
  @MaxLength(1000)
  reason!: string;
}

// ---------------------------------------------------------------------------
// Review moderation
// ---------------------------------------------------------------------------

export class ListAdminReviewsDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  providerId?: string;

  /** 'hidden', 'visible' or 'reported'. Defaults to every review. */
  @IsOptional()
  @IsIn(['hidden', 'visible', 'reported'])
  filter?: 'hidden' | 'visible' | 'reported';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxRating?: number;
}

export class ReviewVisibilityDto {
  @IsBoolean()
  hidden!: boolean;

  @IsString()
  @MinLength(10, {
    message: 'Give a reason of at least 10 characters for the audit log.',
  })
  @MaxLength(1000)
  reason!: string;
}

// ---------------------------------------------------------------------------
// Moderation queues
// ---------------------------------------------------------------------------

export class ListAdminDisputesDto extends PaginationDto {
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;

  /** Shorthand for every status that still needs an admin. */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : value === 'true' || value === true,
  )
  @IsBoolean()
  openOnly?: boolean;
}

export class ListAdminReportsDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @IsOptional()
  @IsEnum(ReportTargetType)
  targetType?: ReportTargetType;

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : value === 'true' || value === true,
  )
  @IsBoolean()
  openOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Platform settings
// ---------------------------------------------------------------------------

export class SettingChangeDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_.]{1,79}$/, {
    message:
      'A setting key is lowercase letters, digits, dots and underscores.',
  })
  key!: string;

  /**
   * Whatever the setting's declared type accepts. Validated against
   * value_type in the service, which is the only place that knows it.
   */
  @IsDefined()
  value!: unknown;
}

export class UpdateSettingsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SettingChangeDto)
  changes!: SettingChangeDto[];
}
