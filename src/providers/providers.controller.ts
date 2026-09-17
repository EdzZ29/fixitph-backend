import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  OwnershipGuard,
  RequireOwnership,
} from '../common/guards/ownership.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AuthenticatedUser } from '../common/types';
import { CreateProviderDto } from './dto/create-provider.dto';
import { SearchProvidersDto } from './dto/search-providers.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';
import { ProvidersService } from './providers.service';
import { ReviewsService } from '../reviews/reviews.service';
import { ListReviewsDto } from '../reviews/dto/list-reviews.dto';

@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly reviews: ReviewsService,
  ) {}

  @Public()
  @Get()
  search(@Query() dto: SearchProvidersDto) {
    return this.providers.search(dto);
  }

  /** Accepts a uuid or a slug, so a public profile can be linked by name. */
  @Public()
  @Get(':idOrSlug')
  findOne(@Param('idOrSlug') idOrSlug: string) {
    return this.providers.findOne(idOrSlug);
  }

  /** Public: a provider's rating history is the point of the platform. */
  @Public()
  @Get(':id/reviews')
  listReviews(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: ListReviewsDto,
  ) {
    return this.reviews.listForProvider(id, dto);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.PROVIDER)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProviderDto,
  ) {
    return this.providers.create(user, dto);
  }

  @Patch(':id')
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'provider', side: 'provider' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProviderDto,
  ) {
    return this.providers.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'provider', side: 'provider' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.providers.remove(user, id);
  }
}
