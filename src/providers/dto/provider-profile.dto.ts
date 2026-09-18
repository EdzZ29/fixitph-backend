import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DayOfWeek } from '@prisma/client';

/** One day's opening hours. */
export class AvailabilityDayDto {
  @IsEnum(DayOfWeek)
  dayOfWeek!: DayOfWeek;

  /**
   * 24-hour HH:MM. A string rather than a date because this is a weekly
   * pattern, not an instant — "Tuesday from 08:00" has no date attached, and
   * giving it one would drag a timezone into a column that has none.
   */
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'Opening time must be HH:MM in 24-hour form.',
  })
  startTime!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'Closing time must be HH:MM in 24-hour form.',
  })
  endTime!: string;

  /** Closed all day. The times are then ignored but still have to parse. */
  @IsOptional()
  @IsBoolean()
  isClosed?: boolean;
}

export class SetAvailabilityDto {
  /**
   * The whole week, replacing whatever was there. At most one entry per day:
   * split shifts are a real thing but the unique index is on
   * (provider, day, start), and supporting them properly means a schema
   * change rather than letting two rows race.
   */
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityDayDto)
  days!: AvailabilityDayDto[];
}

export class UpsertPortfolioItemDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsDateString()
  completedAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  position?: number;

  /**
   * Set by the upload route, not by the client. Accepted here so the service
   * can create a row and attach an image in one step when it has both.
   */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  storageKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  mimeType?: string;
}
