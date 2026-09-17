import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MessageType } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class SendMessageDto {
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @IsOptional()
  @IsUUID()
  serviceRequestId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsEnum([MessageType.TEXT, MessageType.IMAGE, MessageType.FILE], {
    message: 'SYSTEM messages are written by the platform, not by users.',
  })
  messageType?:
    | typeof MessageType.TEXT
    | typeof MessageType.IMAGE
    | typeof MessageType.FILE;
}

export class ListMessagesDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @IsOptional()
  @IsUUID()
  serviceRequestId?: string;
}
