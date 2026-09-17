import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  /** Philippine mobile format, stored E.164. */
  @IsOptional()
  @Matches(/^\+63\d{10}$/, {
    message: 'Phone must be in +63 format, for example +639171234567.',
  })
  phone?: string;

  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters.' })
  @MaxLength(128)
  @Matches(/[a-z]/, { message: 'Password must contain a lowercase letter.' })
  @Matches(/[A-Z]/, { message: 'Password must contain an uppercase letter.' })
  @Matches(/\d/, { message: 'Password must contain a number.' })
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  barangay?: string;

  /**
   * Only CUSTOMER and PROVIDER can be chosen at signup. ADMIN is granted out
   * of band; accepting it here would be a privilege escalation hole.
   */
  @IsOptional()
  @IsEnum([UserRole.CUSTOMER, UserRole.PROVIDER], {
    message: 'Role must be CUSTOMER or PROVIDER.',
  })
  role?: typeof UserRole.CUSTOMER | typeof UserRole.PROVIDER;
}
