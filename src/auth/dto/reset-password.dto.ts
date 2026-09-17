import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Step 2: exchange the emailed code for a reset token. */
export class VerifyResetCodeDto {
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  /** Exactly six digits. Spaces are stripped so "123 456" is accepted. */
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
  )
  @Matches(/^\d{6}$/, { message: 'The code is six digits.' })
  code!: string;
}

/** Step 3: spend the reset token and set the new password. */
export class ResetPasswordDto {
  @IsString()
  @MinLength(20)
  @MaxLength(256)
  resetToken!: string;

  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters.' })
  @MaxLength(128)
  @Matches(/[a-z]/, { message: 'Password must contain a lowercase letter.' })
  @Matches(/[A-Z]/, { message: 'Password must contain an uppercase letter.' })
  @Matches(/\d/, { message: 'Password must contain a number.' })
  password!: string;
}
