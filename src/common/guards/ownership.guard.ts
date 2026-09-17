import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  mixin,
  type Type,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { ApiError } from '../errors';
import { PrismaService } from '../../prisma/prisma.service';
import { toAuthContext, type AuthenticatedUser } from '../types';

/**
 * Resources whose ownership can be checked from the URL parameter alone.
 * Row level security already prevents reading someone else's row, but a guard
 * is a second, independent line: it rejects the request before any service
 * code runs, and it distinguishes "not yours" (403) from "does not exist"
 * (404) deliberately rather than by accident.
 */
export type OwnedResource =
  'provider' | 'service' | 'serviceRequest' | 'quote' | 'booking' | 'review';

export const OWNERSHIP_KEY = 'ownership';

export interface OwnershipOptions {
  resource: OwnedResource;
  /** Route parameter holding the resource id. Defaults to 'id'. */
  param?: string;
  /** Roles that skip the check entirely. Defaults to [ADMIN]. */
  bypassRoles?: UserRole[];
  /**
   * For resources with two legitimate parties (a booking has a customer and a
   * provider), which side is allowed. Defaults to 'any'.
   */
  side?: 'customer' | 'provider' | 'any';
}

/** Declares that the route may only be used by the owner of the resource. */
export const RequireOwnership = (options: OwnershipOptions) =>
  SetMetadata(OWNERSHIP_KEY, options);

@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<
      OwnershipOptions | undefined
    >(OWNERSHIP_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) throw ApiError.unauthenticated('UNAUTHENTICATED');

    const bypass = options.bypassRoles ?? [UserRole.ADMIN];
    if (bypass.includes(user.role)) return true;

    const id = String(req.params[options.param ?? 'id'] ?? '');
    if (!id)
      throw ApiError.badRequest(
        'MISSING_RESOURCE_ID',
        'Resource id is missing.',
      );

    const owner = await this.resolveOwner(options.resource, id, user);
    if (!owner) throw ApiError.notFound('NOT_FOUND');

    const side = options.side ?? 'any';
    const isCustomer = owner.customerId != null && owner.customerId === user.id;
    const isProvider =
      owner.providerId != null && owner.providerId === user.providerId;

    const allowed =
      side === 'customer'
        ? isCustomer
        : side === 'provider'
          ? isProvider
          : isCustomer || isProvider;

    if (!allowed) {
      throw ApiError.forbidden(
        'NOT_RESOURCE_OWNER',
        'You do not own that resource.',
      );
    }
    return true;
  }

  /**
   * Resolved with the elevated (migration-owner) client deliberately: the guard
   * Runs in the caller's own row level security context, which is the only
   * context this client has: there is no elevated connection, by design.
   *
   * The consequence is worth stating plainly. Four of these tables are under
   * RLS, so a row the caller has no claim on is invisible here and comes back
   * as "no such row" — a 404 where a 403 would read better. That is a worse
   * message, not a weaker check, and it is strictly better than the
   * alternative this replaced: reading with *no* context at all, which made
   * every policy clause compare against NULL and hid the row from its own
   * owner. Every route behind this guard answered 404 to the person who
   * owned the resource.
   *
   * Only ownership columns are read, whichever way it goes.
   */
  private async resolveOwner(
    resource: OwnedResource,
    id: string,
    user: AuthenticatedUser,
  ): Promise<{
    customerId?: string | null;
    providerId?: string | null;
  } | null> {
    return this.prisma.withUser(toAuthContext(user), async (tx) => {
      switch (resource) {
        case 'provider': {
          const row = await tx.provider.findFirst({
            where: { id, deletedAt: null },
            select: { id: true },
          });
          return row ? { providerId: row.id } : null;
        }
        case 'service': {
          const row = await tx.service.findFirst({
            where: { id, deletedAt: null },
            select: { providerId: true },
          });
          return row ? { providerId: row.providerId } : null;
        }
        case 'serviceRequest': {
          const row = await tx.serviceRequest.findUnique({
            where: { id },
            select: { customerId: true, providerId: true },
          });
          return row
            ? { customerId: row.customerId, providerId: row.providerId }
            : null;
        }
        case 'quote': {
          const row = await tx.quote.findUnique({
            where: { id },
            select: {
              providerId: true,
              serviceRequest: { select: { customerId: true } },
            },
          });
          return row
            ? {
                providerId: row.providerId,
                customerId: row.serviceRequest.customerId,
              }
            : null;
        }
        case 'booking': {
          const row = await tx.booking.findFirst({
            where: { id, deletedAt: null },
            select: { customerId: true, providerId: true },
          });
          return row
            ? { customerId: row.customerId, providerId: row.providerId }
            : null;
        }
        case 'review': {
          const row = await tx.review.findFirst({
            where: { id, deletedAt: null },
            select: { authorId: true, providerId: true },
          });
          return row
            ? { customerId: row.authorId, providerId: row.providerId }
            : null;
        }
      }
    });
  }
}

/**
 * Inline variant for the handful of routes that need a different parameter or
 * side than the decorator default.
 */
export function OwnsResource(options: OwnershipOptions): Type<CanActivate> {
  @Injectable()
  class InlineOwnershipGuard extends OwnershipGuard {
    override async canActivate(context: ExecutionContext): Promise<boolean> {
      Reflect.defineMetadata(OWNERSHIP_KEY, options, context.getHandler());
      return super.canActivate(context);
    }
  }
  return mixin(InlineOwnershipGuard);
}
