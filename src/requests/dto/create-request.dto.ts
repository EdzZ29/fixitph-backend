import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RequestUrgency } from '@prisma/client';

export class CreateRequestDto {
  @IsUUID()
  categoryId!: string;

  /** Omit to broadcast to the area; set to send to one provider directly. */
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @IsString()
  @MinLength(5)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(20, { message: 'Describe the problem in at least 20 characters.' })
  @MaxLength(5000)
  description!: string;

  @IsEnum(RequestUrgency)
  urgency!: RequestUrgency;

  @IsOptional()
  @IsDateString()
  preferredAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  budgetMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  budgetMax?: number;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  city!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  barangay?: string;

  /**
   * The exact address. Stored, but never returned to a provider until the
   * booking is confirmed; see the booking_contact_for_provider view.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine1?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}
