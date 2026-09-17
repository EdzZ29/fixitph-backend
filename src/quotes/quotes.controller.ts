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
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  OwnershipGuard,
  RequireOwnership,
} from '../common/guards/ownership.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AuthenticatedUser } from '../common/types';
import { AcceptQuoteDto, RejectQuoteDto } from './dto/accept-quote.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';
import { QuotesService } from './quotes.service';

@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateQuoteDto) {
    return this.quotes.create(user, dto);
  }

  @Get(':id')
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'quote' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.quotes.findOne(user, id);
  }

  @Patch(':id')
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'quote', side: 'provider' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuoteDto,
  ) {
    return this.quotes.update(user, id, dto);
  }

  /** Customer only, enforced by the ownership guard and again in the service. */
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'quote', side: 'customer' })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptQuoteDto,
  ) {
    return this.quotes.accept(user, id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ resource: 'quote', side: 'customer' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectQuoteDto,
  ) {
    return this.quotes.reject(user, id, dto.reason);
  }
}
