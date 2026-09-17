import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Patch,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiError } from '../common/errors';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthContext, type AuthenticatedUser } from '../common/types';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  barangay?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  province?: string;

  @IsOptional()
  @Matches(/^\d{4}$/, {
    message: 'Postal code is 4 digits in the Philippines.',
  })
  postalCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A user only ever reads and writes their own profile here. There is no
   * "get user by id" route: a customer has no business fetching another
   * customer's record, and provider details are served by /api/providers.
   */
  async myProfile(user: AuthenticatedUser): Promise<unknown> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId: user.id },
      select: {
        firstName: true,
        lastName: true,
        displayName: true,
        bio: true,
        addressLine1: true,
        addressLine2: true,
        barangay: true,
        city: true,
        province: true,
        postalCode: true,
        latitude: true,
        longitude: true,
        locale: true,
        updatedAt: true,
      },
    });
    if (!profile) throw ApiError.notFound('PROFILE_NOT_FOUND');
    return profile;
  }

  async updateMyProfile(
    user: AuthenticatedUser,
    dto: UpdateProfileDto,
  ): Promise<unknown> {
    return this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.profile.update({
        where: { userId: user.id },
        data: { ...dto },
        select: {
          firstName: true,
          lastName: true,
          displayName: true,
          city: true,
          barangay: true,
          updatedAt: true,
        },
      }),
    );
  }
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me/profile')
  myProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.users.myProfile(user);
  }

  @Patch('me/profile')
  updateMyProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.users.updateMyProfile(user, dto);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
