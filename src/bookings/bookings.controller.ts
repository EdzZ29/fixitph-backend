import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  OwnershipGuard,
  RequireOwnership,
} from '../common/guards/ownership.guard';
import type { AuthenticatedUser } from '../common/types';
import {
  CancelBookingDto,
  CompleteBookingDto,
  CreateBookingDto,
  ListBookingsDto,
  UpdateBookingDto,
} from './dto/booking.dto';
import { BookingsService } from './bookings.service';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() dto: ListBookingsDto) {
    return this.bookings.list(user, dto);
  }

  @Get(':id')
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'booking' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookings.findOne(user, id);
  }

  /** Admin only. The normal path is POST /api/quotes/:id/accept. */
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookings.create(user, dto.quoteId, dto.scheduledStart);
  }

  @Patch(':id')
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'booking' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBookingDto,
  ) {
    return this.bookings.update(user, id, dto);
  }

  /** Releases the customer's exact address to the provider. */
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'booking', side: 'provider' })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookings.confirm(user, id);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'booking', side: 'provider' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookings.start(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'booking' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelBookingDto,
  ) {
    return this.bookings.cancel(user, id, dto);
  }

  /** Writes booking_status_history via the database trigger. */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'booking', side: 'provider' })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteBookingDto,
  ) {
    return this.bookings.complete(user, id, dto);
  }
}
