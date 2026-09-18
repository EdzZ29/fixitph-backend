import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * The non-file half of a message attachment upload.
 *
 * Multipart, so every field arrives as a string — there is no JSON body to
 * coerce from. That is why the thread anchor is validated as a uuid here
 * rather than trusted: it is the value that decides which thread the photo
 * lands in, and the only thing standing between a typo and somebody else's
 * conversation is the row level security policy underneath.
 */
export class SendAttachmentDto {
  @IsUUID()
  @IsOptional()
  bookingId?: string;

  @IsUUID()
  @IsOptional()
  serviceRequestId?: string;

  /** An optional caption. Without one the message says "Sent a photo". */
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  body?: string;
}
