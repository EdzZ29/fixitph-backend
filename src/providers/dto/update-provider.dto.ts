import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateProviderDto } from './create-provider.dto';

/**
 * Note what is absent: verificationStatus, ratingAvg, completedJobsCount and
 * suspendedAt. Those are set by the platform, never by the provider, and
 * forbidNonWhitelisted rejects the request outright if one is sent.
 */
export class UpdateProviderDto extends PartialType(CreateProviderDto) {
  @IsOptional()
  @IsBoolean()
  isAcceptingBookings?: boolean;
}
