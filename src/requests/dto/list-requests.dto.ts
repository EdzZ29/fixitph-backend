import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { RequestStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class ListRequestsDto extends PaginationDto {
  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;
}
