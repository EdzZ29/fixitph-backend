import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { ttlToSeconds } from '../config/configuration';
import { ApiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../common/types';
import type { RegisterDto } from './dto/register.dto';
import type { LoginDto } from './dto/login.dto';

/**
 * Argon2id with parameters in the range OWASP suggests for interactive logins.
 * 64 MiB and 3 passes is roughly 50 to 100 ms on a modest server, which is
 * slow enough to matter offline and fast enough for a login form.
 */
const ARGON2_OPTIONS: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

/** A dummy verify target so a login for an unknown email costs the same. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly maxAttempts: number;
  private readonly lockoutMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.maxAttempts = this.config.get<number>('LOGIN_MAX_ATTEMPTS', 5);
    this.lockoutMinutes = this.config.get<number>('LOGIN_LOCKOUT_MINUTES', 15);
  }

  // -- registration ----------------------------------------------------------

  async register(
    dto: RegisterDto,
    meta: RequestMeta,
  ): Promise<TokenPair & { userId: string }> {
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    // A customer signing up can be active immediately. A provider account is
    // created but cannot list anything until documents are approved, which the
    // providers module enforces.
    const user = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: dto.email.toLowerCase(),
            phone: dto.phone ?? null,
            passwordHash,
            role: dto.role ?? UserRole.CUSTOMER,
            status: UserStatus.ACTIVE,
            passwordChangedAt: new Date(),
            profile: {
              create: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                city: dto.city ?? null,
                barangay: dto.barangay ?? null,
              },
            },
          },
          select: { id: true, email: true, role: true },
        });
        return created;
      })
      .catch((e: unknown) => {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          const target =
            (e.meta?.target as string[] | undefined)?.join(', ') ?? 'account';
          throw ApiError.conflict(
            'ACCOUNT_EXISTS',
            `An account with that ${target.includes('phone') ? 'phone number' : 'email'} already exists.`,
          );
        }
        throw e;
      });

    const tokens = await this.issueTokens(
      { id: user.id, email: user.email, role: user.role, providerId: null },
      meta,
    );
    return { ...tokens, userId: user.id };
  }

  // -- login -----------------------------------------------------------------

  async login(dto: LoginDto, meta: RequestMeta): Promise<TokenPair> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        passwordHash: true,
        failedLoginCount: true,
        lockedUntil: true,
        provider: { select: { id: true } },
      },
    });

    // Always spend the hashing time, so timing does not reveal whether the
    // address is registered.
    if (!user) {
      await argon2.verify(DUMMY_HASH, dto.password).catch(() => false);
      throw ApiError.unauthenticated(
        'INVALID_CREDENTIALS',
        'Email or password is incorrect.',
      );
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw ApiError.forbidden(
        'ACCOUNT_LOCKED',
        `Too many failed attempts. Try again after ${user.lockedUntil.toISOString()}.`,
      );
    }

    /**
     * An account with no password is one that only signs in through Google.
     *
     * The dummy hash is still verified against, for the same reason an
     * unknown address is: skipping the work here would make a Google-only
     * account answer measurably faster than one with a password, which turns
     * login into an oracle for how somebody signed up.
     *
     * The message stays the generic one. Saying "this account uses Google"
     * would confirm the address is registered, which nothing else on this
     * route does — the login page carries that hint instead, where it is
     * shown to everyone and reveals nothing.
     */
    const valid = user.passwordHash
      ? await argon2.verify(user.passwordHash, dto.password).catch(() => false)
      : await argon2
          .verify(DUMMY_HASH, dto.password)
          .catch(() => false)
          .then(() => false);

    if (!valid) {
      await this.registerFailedAttempt(user.id, user.failedLoginCount);
      throw ApiError.unauthenticated(
        'INVALID_CREDENTIALS',
        'Email or password is incorrect.',
      );
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw ApiError.forbidden(
        'ACCOUNT_SUSPENDED',
        'This account is suspended.',
      );
    }
    if (user.status === UserStatus.DEACTIVATED) {
      throw ApiError.forbidden(
        'ACCOUNT_DEACTIVATED',
        'This account has been deactivated.',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    return this.issueTokens(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        providerId: user.provider?.id ?? null,
      },
      meta,
    );
  }

  /** Counts the failure and locks the account once the threshold is crossed. */
  private async registerFailedAttempt(
    userId: string,
    current: number,
  ): Promise<void> {
    const next = current + 1;
    const locked = next >= this.maxAttempts;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: next,
        lockedUntil: locked
          ? new Date(Date.now() + this.lockoutMinutes * 60_000)
          : null,
      },
    });
    if (locked) {
      this.logger.warn(
        `Account ${userId} locked after ${next} failed attempts`,
      );
    }
  }

  // -- tokens ----------------------------------------------------------------

  /**
   * A session for a caller that has already established who the person is by
   * some other means — today, a completed Google sign-in.
   *
   * A thin public door onto issueTokens rather than making that method public:
   * everything it can be used for still runs through one implementation, so a
   * second way in cannot end up with a subtly different token, a different
   * refresh family, or no refresh row at all.
   */
  async issueTokensFor(
    user: {
      id: string;
      email: string;
      role: UserRole;
      providerId: string | null;
    },
    meta: RequestMeta,
  ): Promise<TokenPair> {
    return this.issueTokens(user, meta);
  }

  private async issueTokens(
    user: {
      id: string;
      email: string;
      role: UserRole;
      providerId: string | null;
    },
    meta: RequestMeta,
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const sessionId = randomUUID();

    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        providerId: user.providerId,
        sid: sessionId,
      },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.parseSeconds(
          this.config.get<string>('JWT_ACCESS_TTL', '15m'),
        ),
        issuer: this.config.get<string>('JWT_ISSUER', 'fixitph'),
      },
    );

    // The refresh token is opaque random bytes, not a JWT. Only its SHA-256
    // digest is stored, so a database leak does not hand over live sessions.
    const refreshToken = randomBytes(48).toString('base64url');
    const ttlDays = this.parseDays(
      this.config.get<string>('JWT_REFRESH_TTL', '30d'),
    );

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ip ?? null,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.parseSeconds(
        this.config.get<string>('JWT_ACCESS_TTL', '15m'),
      ),
    };
  }

  /**
   * Rotation with reuse detection. A refresh token is single use. If one that
   * has already been rotated is presented again, the whole family is revoked,
   * because the only ways that happens are a stolen token or a replay.
   */
  async refresh(presented: string, meta: RequestMeta): Promise<TokenPair> {
    const hash = sha256(presented);

    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        revokedAt: true,
        replacedBy: true,
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            deletedAt: true,
            provider: { select: { id: true } },
          },
        },
      },
    });

    if (!record) {
      throw ApiError.unauthenticated(
        'INVALID_REFRESH_TOKEN',
        'Please sign in again.',
      );
    }

    if (record.revokedAt || record.replacedBy) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Refresh token reuse detected for user ${record.userId}; family ${record.familyId} revoked`,
      );
      throw ApiError.unauthenticated(
        'REFRESH_TOKEN_REUSED',
        'Please sign in again.',
      );
    }

    if (record.expiresAt <= new Date()) {
      throw ApiError.unauthenticated(
        'REFRESH_TOKEN_EXPIRED',
        'Please sign in again.',
      );
    }

    const user = record.user;
    if (user.deletedAt || user.status !== UserStatus.ACTIVE) {
      throw ApiError.forbidden(
        'ACCOUNT_UNAVAILABLE',
        'This account can no longer sign in.',
      );
    }

    const tokens = await this.issueTokens(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        providerId: user.provider?.id ?? null,
      },
      meta,
      record.familyId,
    );

    const replacement = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(tokens.refreshToken) },
      select: { id: true },
    });

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedBy: replacement?.id ?? null },
    });

    return tokens;
  }

  /** Revokes the presented token, and everything in its rotation family. */
  async logout(presented: string | undefined): Promise<void> {
    if (!presented) return;
    const hash = sha256(presented);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      select: { familyId: true },
    });
    if (!record) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // -- me --------------------------------------------------------------------

  async me(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        lastLoginAt: true,
        createdAt: true,
        profile: {
          select: {
            firstName: true,
            lastName: true,
            displayName: true,
            city: true,
            barangay: true,
            province: true,
            locale: true,
          },
        },
        provider: {
          select: {
            id: true,
            slug: true,
            businessName: true,
            verificationStatus: true,
          },
        },
      },
    });
    if (!user) throw ApiError.notFound('USER_NOT_FOUND');
    return user;
  }

  /** Used by the JWT strategy to confirm the account is still usable. */
  async validateAccessToken(payload: {
    sub: string;
    email: string;
    role: UserRole;
    providerId: string | null;
    sid: string;
    typ?: string;
  }): Promise<AuthenticatedUser | null> {
    /**
     * Only a token minted as a session token gets in.
     *
     * Other tokens are signed with the same secret and issuer — the event
     * stream ticket is one — and every one of them carries a subject. Without
     * this check, any of them would be spendable here as an access token,
     * which would make a ticket handed out in a URL exactly as dangerous as
     * the token it was introduced to avoid putting there. A session id is
     * what an access token has and the others do not.
     */
    if (payload.typ !== undefined || !payload.sid) return null;

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        provider: { select: { id: true } },
      },
    });

    if (!user || user.status !== UserStatus.ACTIVE) return null;

    return {
      id: user.id,
      email: user.email,
      // Read from the database, not the token: a role change must take effect
      // without waiting for the access token to expire.
      role: user.role,
      providerId: user.provider?.id ?? null,
      sessionId: payload.sid,
    };
  }

  // -- helpers ---------------------------------------------------------------

  private parseDays(ttl: string): number {
    return ttlToSeconds(ttl, 30 * 86400) / 86400;
  }

  private parseSeconds(ttl: string): number {
    return ttlToSeconds(ttl, 900);
  }
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison, for anywhere a secret is compared in memory. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
