import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ApiError } from '../errors';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Applied globally in AppModule, so authentication is opt-out (@Public) rather
 * than opt-in. Forgetting a guard cannot open a route by accident.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw ApiError.unauthenticated('UNAUTHENTICATED', 'Sign in to continue.');
    }
    return user;
  }
}
