import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, UserStatus } from '@prisma/client';
import type { Request } from 'express';
import { ApiError } from '../errors';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) throw ApiError.unauthenticated('UNAUTHENTICATED');

    if (!required.includes(user.role)) {
      throw ApiError.forbidden(
        'INSUFFICIENT_ROLE',
        `This action is for ${required.join(' or ').toLowerCase()} accounts.`,
      );
    }
    return true;
  }
}

export { UserStatus };
