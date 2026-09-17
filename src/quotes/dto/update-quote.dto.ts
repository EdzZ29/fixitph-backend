import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { QuoteStatus } from '@prisma/client';

export class UpdateQuoteDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(10_000_000)
  amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  laborCost?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  partsCost?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(10080)
  estimatedDurationMinutes?: number;

  @IsOptional()
  @IsDateString()
  validUntil?: string;

  /**
   * The only status a provider may set here is WITHDRAWN. Accepting and
   * rejecting belong to the customer and have their own endpoints.
   */
  @IsOptional()
  @IsEnum([QuoteStatus.WITHDRAWN], {
    message: 'A provider can only withdraw a quote.',
  })
  status?: typeof QuoteStatus.WITHDRAWN;
}
