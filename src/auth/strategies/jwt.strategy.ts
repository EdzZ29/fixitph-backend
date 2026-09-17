import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from '../auth.service';
import type { AuthenticatedUser } from '../../common/types';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  providerId: string | null;
  sid: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly auth: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      issuer: config.get<string>('JWT_ISSUER', 'fixitph'),
    });
  }

  /**
   * The signature only proves the token was ours. Whether the account is still
   * active, and what role it holds now, is re-read from the database on every
   * request, so a suspension takes effect immediately rather than when the
   * access token happens to expire.
   */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const user = await this.auth.validateAccessToken(payload);
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
