import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class AcceptQuoteDto {
  @IsDateString()
  scheduledStart!: string;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;
}

export class RejectQuoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
