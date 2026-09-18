import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaymentMethod, ProviderType } from '@prisma/client';

export class CreateProviderDto {
  /**
   * Whether they trade as a person or a registered business. Decides which
   * documents verification asks for, so it is worth getting right up front —
   * but it can be changed later, and defaults to the commoner case.
   */
  @IsOptional()
  @IsEnum(ProviderType)
  providerType?: ProviderType;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  businessName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  headline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  bio?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(80)
  yearsExperience?: number;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  baseCity!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  baseBarangay?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  serviceRadiusKm?: number;

  @IsOptional()
  @IsBoolean()
  acceptsEmergency?: boolean;

  @IsOptional()
  @IsArray()
  @IsEnum(PaymentMethod, { each: true })
  paymentMethods?: PaymentMethod[];
}
