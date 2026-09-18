import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { DayOfWeek, UserRole } from '@prisma/client';
import { ApiError } from '../common/errors';
import { CacheService } from '../cache/cache.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import { fromTimeOfDay, withTimesOfDay } from './time-of-day';
import {
  SetAvailabilityDto,
  UpsertPortfolioItemDto,
} from './dto/provider-profile.dto';
import {
  approvalsFromDocuments,
  documentsStillNeeded,
  summariseVerification,
} from './verification';

/**
 * The parts of a provider's own profile that are lists rather than fields:
 * the week they work, and the jobs they want to show off.
 *
 * Both had models and both were returned on the public profile, but neither
 * had any way to write them — a provider could not set their opening hours or
 * add a portfolio piece at all. These are the missing halves.
 *
 * Everything here is scoped to the provider on the token. There is no id in
 * any path that identifies *which* provider, so there is nothing to tamper
 * with; the only ids are of rows within the caller's own profile, and each is
 * checked against it before being touched.
 */
@Injectable()
export class ProviderProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private requireProvider(user: AuthenticatedUser): string {
    if (!user.providerId) {
      throw ApiError.forbidden(
        'NO_PROVIDER_PROFILE',
        'Create a provider profile first.',
      );
    }
    return user.providerId;
  }

  // -- availability ----------------------------------------------------------

  async getAvailability(user: AuthenticatedUser): Promise<unknown> {
    const providerId = this.requireProvider(user);
    const slots = await this.prisma.availability.findMany({
      where: { providerId },
      select: {
        id: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        isClosed: true,
      },
      orderBy: { dayOfWeek: 'asc' },
    });
    // "08:00", not a Thursday in 1970. See time-of-day.ts.
    return withTimesOfDay(slots);
  }

  /**
   * Replaces the whole week in one transaction.
   *
   * A weekly schedule is edited as a unit — someone changes Tuesday and
   * Saturday together and saves once — and a partial apply would leave them
   * bookable at hours they had just removed. Replacing wholesale also sidesteps
   * the unique index on (provider, day, start) that piecemeal edits keep
   * colliding with.
   */
  async setAvailability(
    user: AuthenticatedUser,
    dto: SetAvailabilityDto,
  ): Promise<unknown> {
    const providerId = this.requireProvider(user);

    for (const slot of dto.days) {
      if (!slot.isClosed && slot.startTime >= slot.endTime) {
        throw ApiError.badRequest(
          'AVAILABILITY_ENDS_BEFORE_IT_STARTS',
          `${slot.dayOfWeek.toLowerCase()} closes before it opens.`,
        );
      }
    }

    const seen = new Set<DayOfWeek>();
    for (const slot of dto.days) {
      if (seen.has(slot.dayOfWeek)) {
        throw ApiError.badRequest(
          'DUPLICATE_DAY',
          `${slot.dayOfWeek.toLowerCase()} appears twice.`,
        );
      }
      seen.add(slot.dayOfWeek);
    }

    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.availability.deleteMany({ where: { providerId } });

      if (dto.days.length) {
        await tx.availability.createMany({
          data: dto.days.map((slot) => ({
            providerId,
            dayOfWeek: slot.dayOfWeek,
            // Time-only columns: the date part is discarded by Postgres, and
            // a fixed epoch day keeps the parse unambiguous.
            startTime: fromTimeOfDay(slot.startTime),
            endTime: new Date(`1970-01-01T${slot.endTime}:00Z`),
            isClosed: slot.isClosed ?? false,
          })),
        });
      }

      const slots = await tx.availability.findMany({
        where: { providerId },
        select: {
          id: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
          isClosed: true,
        },
        orderBy: { dayOfWeek: 'asc' },
      });
      return withTimesOfDay(slots);
    });

    await this.cache.invalidateResource('providers', providerId);
    return rows;
  }

  // -- portfolio -------------------------------------------------------------

  async listPortfolio(user: AuthenticatedUser): Promise<unknown> {
    const providerId = this.requireProvider(user);
    return this.prisma.portfolioItem.findMany({
      where: { providerId },
      select: {
        id: true,
        title: true,
        description: true,
        completedAt: true,
        position: true,
        storageKey: true,
      },
      orderBy: { position: 'asc' },
    });
  }

  async addPortfolioItem(
    user: AuthenticatedUser,
    dto: UpsertPortfolioItemDto,
  ): Promise<unknown> {
    const providerId = this.requireProvider(user);

    const count = await this.prisma.portfolioItem.count({
      where: { providerId },
    });
    if (count >= 24) {
      throw ApiError.conflict(
        'PORTFOLIO_FULL',
        'A profile can show 24 pieces of work. Remove one to add another.',
      );
    }

    // The DTO is shared with the update route, where every field is optional.
    // On a create a title is the one thing that has to be there.
    if (!dto.title?.trim()) {
      throw ApiError.badRequest(
        'PORTFOLIO_TITLE_REQUIRED',
        'Give the piece of work a title.',
      );
    }

    const item = await this.prisma.portfolioItem.create({
      data: {
        providerId,
        title: dto.title.trim(),
        description: dto.description ?? null,
        completedAt: dto.completedAt ? new Date(dto.completedAt) : null,
        position: dto.position ?? count,
        // The image is attached by the upload route; a piece of work can be
        // described before there is a photo of it.
        storageKey: dto.storageKey ?? '',
        mimeType: dto.mimeType ?? 'application/octet-stream',
      },
      select: {
        id: true,
        title: true,
        description: true,
        completedAt: true,
        position: true,
      },
    });

    await this.cache.invalidateResource('providers', providerId);
    return item;
  }

  async updatePortfolioItem(
    user: AuthenticatedUser,
    id: string,
    dto: UpsertPortfolioItemDto,
  ): Promise<unknown> {
    const providerId = this.requireProvider(user);
    await this.assertOwnPortfolioItem(providerId, id);

    const item = await this.prisma.portfolioItem.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.completedAt !== undefined
          ? { completedAt: dto.completedAt ? new Date(dto.completedAt) : null }
          : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
      },
      select: {
        id: true,
        title: true,
        description: true,
        completedAt: true,
        position: true,
      },
    });

    await this.cache.invalidateResource('providers', providerId);
    return item;
  }

  async removePortfolioItem(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ id: string }> {
    const providerId = this.requireProvider(user);
    await this.assertOwnPortfolioItem(providerId, id);

    await this.prisma.portfolioItem.delete({ where: { id } });
    await this.cache.invalidateResource('providers', providerId);
    return { id };
  }

  private async assertOwnPortfolioItem(
    providerId: string,
    id: string,
  ): Promise<void> {
    const item = await this.prisma.portfolioItem.findUnique({
      where: { id },
      select: { providerId: true },
    });
    if (!item) throw ApiError.notFound('PORTFOLIO_ITEM_NOT_FOUND');
    if (item.providerId !== providerId) {
      throw ApiError.forbidden(
        'NOT_RESOURCE_OWNER',
        'That is not your portfolio item.',
      );
    }
  }

  // -- verification ----------------------------------------------------------

  /**
   * The provider's own view of their verification: which badges they hold,
   * what each one means, and what is still outstanding.
   *
   * Richer than the public one deliberately. This is the only place a rejected
   * document and its reason are visible, because the person who has to act on
   * it is the one who uploaded it.
   */
  async myVerification(user: AuthenticatedUser): Promise<unknown> {
    const providerId = this.requireProvider(user);

    /**
     * Read under the caller's session, because provider_documents is under
     * row level security: without it the policy hides the rows rather than
     * raising, and this screen told a provider their approved documents did
     * not exist.
     */
    const provider = await this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.provider.findUnique({
        where: { id: providerId },
        select: {
          providerType: true,
          verificationStatus: true,
          verifiedAt: true,
          user: { select: { emailVerifiedAt: true } },
          documents: {
            select: {
              id: true,
              documentType: true,
              status: true,
              originalFilename: true,
              rejectionReason: true,
              reviewedAt: true,
              expiresAt: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
    );
    if (!provider) throw ApiError.notFound('PROVIDER_NOT_FOUND');

    // The owner can see their own documents, so the conclusion is derived
    // from them directly rather than from the public view.
    const summary = summariseVerification({
      providerType: provider.providerType,
      emailVerifiedAt: provider.user.emailVerifiedAt,
      approvals: approvalsFromDocuments(provider.documents),
    });

    return {
      ...summary,
      providerType: provider.providerType,
      overallStatus: provider.verificationStatus,
      verifiedAt: provider.verifiedAt,
      outstanding: documentsStillNeeded(provider.providerType, summary),
      documents: provider.documents,
    };
  }
}

@Controller('providers/me')
@UseGuards(RolesGuard)
@Roles(UserRole.PROVIDER, UserRole.ADMIN)
export class ProviderProfileController {
  constructor(private readonly profile: ProviderProfileService) {}

  @Get('availability')
  getAvailability(@CurrentUser() user: AuthenticatedUser) {
    return this.profile.getAvailability(user);
  }

  /** Replaces the whole week. PUT, because it is not a partial edit. */
  @Put('availability')
  @HttpCode(HttpStatus.OK)
  setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetAvailabilityDto,
  ) {
    return this.profile.setAvailability(user, dto);
  }

  @Get('portfolio')
  listPortfolio(@CurrentUser() user: AuthenticatedUser) {
    return this.profile.listPortfolio(user);
  }

  @Post('portfolio')
  addPortfolioItem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertPortfolioItemDto,
  ) {
    return this.profile.addPortfolioItem(user, dto);
  }

  @Patch('portfolio/:id')
  updatePortfolioItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertPortfolioItemDto,
  ) {
    return this.profile.updatePortfolioItem(user, id, dto);
  }

  @Delete('portfolio/:id')
  removePortfolioItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.profile.removePortfolioItem(user, id);
  }

  @Get('verification')
  myVerification(@CurrentUser() user: AuthenticatedUser) {
    return this.profile.myVerification(user);
  }
}
