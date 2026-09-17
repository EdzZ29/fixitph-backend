import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WRITE_THROTTLE } from '../common/throttle';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  OwnershipGuard,
  RequireOwnership,
} from '../common/guards/ownership.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AuthenticatedUser } from '../common/types';
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { UpdateRequestStatusDto } from './dto/update-request-status.dto';
import { RequestsService } from './requests.service';

@Controller('service-requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  /** Rate limited: posting jobs is the most abusable write on the platform. */
  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.PROVIDER, UserRole.ADMIN)
  @Throttle({ default: WRITE_THROTTLE.serviceRequest })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRequestDto,
  ) {
    return this.requests.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() dto: ListRequestsDto) {
    return this.requests.list(user, dto);
  }

  /** Broadcast requests available to quote. Carries no customer PII. */
  @Get('feed')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  feed(@CurrentUser() user: AuthenticatedUser, @Query() dto: ListRequestsDto) {
    return this.requests.feed(user, dto);
  }

  @Get(':id')
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'serviceRequest' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.requests.findOne(user, id);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRequestStatusDto,
  ) {
    return this.requests.updateStatus(user, id, dto);
  }
}
