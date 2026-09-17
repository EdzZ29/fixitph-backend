import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiError } from '../common/errors';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  PaginationDto,
  paginate,
  type Paginated,
} from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthContext, type AuthenticatedUser } from '../common/types';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    user: AuthenticatedUser,
    dto: PaginationDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const where = { customerId: user.id, provider: { deletedAt: null } };

      const [items, total] = await Promise.all([
        tx.favorite.findMany({
          where,
          select: {
            createdAt: true,
            provider: {
              select: {
                id: true,
                slug: true,
                businessName: true,
                headline: true,
                baseCity: true,
                baseBarangay: true,
                ratingAvg: true,
                ratingCount: true,
                verificationStatus: true,
                isAcceptingBookings: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.favorite.count({ where }),
      ]);

      return paginate(items, total, dto);
    });
  }

  /** Idempotent: favouriting twice is not an error, it is a no-op. */
  async add(
    user: AuthenticatedUser,
    providerId: string,
  ): Promise<{ providerId: string }> {
    const provider = await this.prisma.provider.findFirst({
      where: { id: providerId, deletedAt: null },
      select: { id: true },
    });
    if (!provider) throw ApiError.notFound('PROVIDER_NOT_FOUND');

    await this.prisma.favorite.upsert({
      where: { customerId_providerId: { customerId: user.id, providerId } },
      create: { customerId: user.id, providerId },
      update: {},
    });
    return { providerId };
  }

  async remove(
    user: AuthenticatedUser,
    providerId: string,
  ): Promise<{ providerId: string }> {
    await this.prisma.favorite.deleteMany({
      where: { customerId: user.id, providerId },
    });
    return { providerId };
  }
}

@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() dto: PaginationDto) {
    return this.favorites.list(user, dto);
  }

  @Post(':providerId')
  @HttpCode(HttpStatus.OK)
  add(
    @CurrentUser() user: AuthenticatedUser,
    @Param('providerId', ParseUUIDPipe) providerId: string,
  ) {
    return this.favorites.add(user, providerId);
  }

  @Delete(':providerId')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('providerId', ParseUUIDPipe) providerId: string,
  ) {
    return this.favorites.remove(user, providerId);
  }
}

@Module({
  controllers: [FavoritesController],
  providers: [FavoritesService],
  exports: [FavoritesService],
})
export class FavoritesModule {}
