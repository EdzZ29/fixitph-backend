import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The refresh token normally arrives in an httpOnly cookie. The body is a
 * fallback for non-browser clients.
 */
export class RefreshDto {
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(256)
  refreshToken?: string;
}
