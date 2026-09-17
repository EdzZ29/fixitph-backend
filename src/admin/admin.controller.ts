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
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CategoriesService } from '../categories/categories.service';
import type { AuthenticatedUser } from '../common/types';
import { AdminService, type AdminRequestMeta } from './admin.service';
import {
  ListAdminDisputesDto,
  ListAdminReportsDto,
  ListAdminReviewsDto,
  ListAdminServicesDto,
  ListAdminUsersDto,
  ModerateServiceDto,
  ResolveDisputeDto,
  ResolveReportDto,
  ReviewDocumentDto,
  ReviewVisibilityDto,
  SuspendUserDto,
  UpdateSettingsDto,
  VerifyProviderDto,
} from './dto/admin.dto';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
} from '../categories/dto/category.dto';

/**
 * Every route here is behind the ADMIN role guard, applied at the class level
 * so a new route cannot be added without it.
 */
@Controller('admin')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly categories: CategoriesService,
  ) {}

  // -- overview --------------------------------------------------------------

  @Get('stats')
  stats(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.stats(user);
  }

  // -- users -----------------------------------------------------------------

  @Get('users')
  listUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ListAdminUsersDto,
  ) {
    return this.admin.listUsers(user, dto);
  }

  @Post('users/:id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendUserDto,
    @Req() req: Request,
  ) {
    return this.admin.suspendUser(user, id, dto, meta(req));
  }

  @Post('users/:id/reinstate')
  @HttpCode(HttpStatus.OK)
  reinstate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendUserDto,
    @Req() req: Request,
  ) {
    return this.admin.reinstateUser(user, id, dto, meta(req));
  }

  // -- provider verification -------------------------------------------------

  @Get('verification/pending')
  pendingVerifications(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: PaginationDto,
  ) {
    return this.admin.listPendingVerifications(user, dto);
  }

  @Post('providers/:id/verification')
  @HttpCode(HttpStatus.OK)
  verifyProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyProviderDto,
    @Req() req: Request,
  ) {
    return this.admin.verifyProvider(user, id, dto, meta(req));
  }

  @Post('documents/:id/review')
  @HttpCode(HttpStatus.OK)
  reviewDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDocumentDto,
    @Req() req: Request,
  ) {
    return this.admin.reviewDocument(user, id, dto, meta(req));
  }

  // -- listing moderation ----------------------------------------------------

  @Get('services')
  listServices(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ListAdminServicesDto,
  ) {
    return this.admin.listServices(user, dto);
  }

  @Post('services/:id/moderate')
  @HttpCode(HttpStatus.OK)
  moderateService(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateServiceDto,
    @Req() req: Request,
  ) {
    return this.admin.moderateService(user, id, dto, meta(req));
  }

  // -- review moderation -----------------------------------------------------

  @Get('reviews')
  listReviews(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ListAdminReviewsDto,
  ) {
    return this.admin.listReviews(user, dto);
  }

  @Post('reviews/:id/visibility')
  @HttpCode(HttpStatus.OK)
  setReviewVisibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewVisibilityDto,
    @Req() req: Request,
  ) {
    return this.admin.setReviewVisibility(user, id, dto, meta(req));
  }

  // -- moderation ------------------------------------------------------------

  @Get('disputes')
  listDisputes(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ListAdminDisputesDto,
  ) {
    return this.admin.listDisputes(user, dto);
  }

  @Get('reports')
  listReports(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ListAdminReportsDto,
  ) {
    return this.admin.listReports(user, dto);
  }

  @Post('disputes/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolveDispute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
    @Req() req: Request,
  ) {
    return this.admin.resolveDispute(user, id, dto, meta(req));
  }

  @Post('reports/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolveReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveReportDto,
    @Req() req: Request,
  ) {
    return this.admin.resolveReport(user, id, dto, meta(req));
  }

  // -- categories ------------------------------------------------------------

  /** The whole tree, hidden categories included. */
  @Get('categories')
  listCategories() {
    return this.categories.adminTree();
  }

  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch('categories/:id')
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categories.update(id, dto);
  }

  // -- platform settings -----------------------------------------------------

  @Get('settings')
  listSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.listSettings(user);
  }

  @Patch('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateSettingsDto,
    @Req() req: Request,
  ) {
    return this.admin.updateSettings(user, dto, meta(req));
  }

  // -- audit -----------------------------------------------------------------

  @Get('audit-log')
  auditLog(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: PaginationDto,
  ) {
    return this.admin.listAuditLog(user, dto);
  }
}

function meta(req: Request): AdminRequestMeta {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}
