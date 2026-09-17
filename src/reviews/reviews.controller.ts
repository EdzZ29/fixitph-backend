import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WRITE_THROTTLE } from '../common/throttle';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  OwnershipGuard,
  RequireOwnership,
} from '../common/guards/ownership.guard';
import type { AuthenticatedUser } from '../common/types';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReportReviewDto } from './dto/report-review.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { ReviewsService } from './reviews.service';

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post()
  @Throttle({ write: WRITE_THROTTLE.review })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReviewDto) {
    return this.reviews.create(user, dto);
  }

  /**
   * Either party may reach this route: the author to edit, the provider to
   * respond. Which fields each may touch is decided in the service and again
   * by the reviews_guard_update trigger.
   */
  @Patch(':id')
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'review' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.reviews.update(user, id, dto);
  }

  @Post(':id/report')
  @HttpCode(HttpStatus.OK)
  @Throttle({ write: WRITE_THROTTLE.report })
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportReviewDto,
  ) {
    return this.reviews.report(user, id, dto);
  }
}
