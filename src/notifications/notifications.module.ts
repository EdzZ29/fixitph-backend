import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  PaginationDto,
  paginate,
  type Paginated,
} from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthContext, type AuthenticatedUser } from '../common/types';

export class ListNotificationsDto extends PaginationDto {
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : value === 'true' || value === true,
  )
  @IsBoolean()
  unreadOnly?: boolean;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Never cached. A notification list is the definition of auth-scoped. */
  async list(
    user: AuthenticatedUser,
    dto: ListNotificationsDto,
  ): Promise<Paginated<unknown>> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const where = {
        userId: user.id,
        ...(dto.unreadOnly ? { readAt: null } : {}),
      };

      const [items, total, unread] = await Promise.all([
        tx.notification.findMany({
          where,
          select: {
            id: true,
            type: true,
            channel: true,
            title: true,
            body: true,
            data: true,
            readAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          skip: dto.skip,
          take: dto.limit,
        }),
        tx.notification.count({ where }),
        tx.notification.count({ where: { userId: user.id, readAt: null } }),
      ]);

      return { ...paginate(items, total, dto), unread };
    });
  }

  async markRead(
    user: AuthenticatedUser,
    ids?: string[],
  ): Promise<{ updated: number }> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      const result = await tx.notification.updateMany({
        // Scoped to the caller, so passing someone else's id does nothing.
        where: {
          userId: user.id,
          readAt: null,
          ...(ids && ids.length ? { id: { in: ids } } : {}),
        },
        data: { readAt: new Date() },
      });
      return { updated: result.count };
    });
  }
}

export class MarkReadDto {
  /** Omit to mark everything read. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  ids?: string[];
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ListNotificationsDto,
  ) {
    return this.notifications.list(user, dto);
  }

  @Patch('read')
  markRead(@CurrentUser() user: AuthenticatedUser, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(user, dto.ids);
  }
}

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
