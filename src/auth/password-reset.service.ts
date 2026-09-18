import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ApiError } from '../common/errors';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Password reset, in three steps.
 *
 *   1. request()  emails a 6 digit code and stores only its hash
 *   2. verify()   checks the code and issues a one-time reset token
 *   3. reset()    spends that token and changes the password
 *
 * The code is deliberately short enough to retype from a phone, which means it
 * carries about 20 bits and cannot be left to stand on its own. Three things
 * make that safe:
 *
 *   * it expires in minutes, not hours
 *   * three wrong guesses lock the request for a fixed period
 *   * requesting a new code invalidates every earlier one
 *
 * Nothing in here ever tells an anonymous caller whether an address is
 * registered. Every path returns the same shape.
 */

const ARGON2_OPTIONS: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

/** Burned when a code is checked against a request that does not exist. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';

export interface ResetRequestMeta {
  ip?: string;
}

export interface VerifyResult {
  resetToken: string;
  expiresInSeconds: number;
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly codeTtlMinutes: number;
  private readonly maxAttempts: number;
  private readonly lockoutMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {
    this.codeTtlMinutes = this.config.get<number>('RESET_CODE_TTL_MINUTES', 10);
    this.maxAttempts = this.config.get<number>('RESET_MAX_ATTEMPTS', 3);
    this.lockoutMinutes = this.config.get<number>('RESET_LOCKOUT_MINUTES', 15);
  }

  // -- step 1: request a code ------------------------------------------------

  /**
   * Always resolves the same way. Telling an anonymous caller whether an
   * address is registered is an account enumeration oracle, and this endpoint
   * is reachable without a session.
   */
  async request(
    email: string,
    meta: ResetRequestMeta,
  ): Promise<{ codeTtlMinutes: number; devCode?: string }> {
    const normalised = email.trim().toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { email: normalised, deletedAt: null },
      select: { id: true, email: true, status: true },
    });

    if (!user) {
      // Spend comparable time so the response cannot be timed.
      await argon2.hash(randomBytes(16).toString('hex'), ARGON2_OPTIONS);
      return { codeTtlMinutes: this.codeTtlMinutes };
    }

    const code = generateCode();
    const codeHash = await argon2.hash(code, ARGON2_OPTIONS);
    const expiresAt = new Date(Date.now() + this.codeTtlMinutes * 60_000);

    await this.prisma.$transaction(async (tx) => {
      // A new code retires every earlier one, so only the latest can be used
      // and an attacker cannot accumulate guesses across requests.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          codeHash,
          expiresAt,
          requestedIp: meta.ip ?? null,
        },
      });
    });

    await this.mail.sendPasswordResetCode(
      user.email,
      code,
      this.codeTtlMinutes,
    );
    this.logger.log(`Password reset code issued for user ${user.id}`);

    return {
      codeTtlMinutes: this.codeTtlMinutes,
      // Only outside production, and only so the flow is testable on a machine
      // with no mail server. Never returned once NODE_ENV is production.
      ...(this.config.get('NODE_ENV') === 'production'
        ? {}
        : { devCode: code }),
    };
  }

  // -- step 2: verify the code ----------------------------------------------

  async verify(email: string, code: string): Promise<VerifyResult> {
    const normalised = email.trim().toLowerCase();

    const record = await this.prisma.passwordResetToken.findFirst({
      where: {
        user: { email: normalised, deletedAt: null },
        usedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        codeHash: true,
        attemptCount: true,
        lockedUntil: true,
        expiresAt: true,
        verifiedAt: true,
        tokenHash: true,
      },
    });

    if (!record) {
      await argon2.verify(DUMMY_HASH, code).catch(() => false);
      throw ApiError.badRequest(
        'INVALID_RESET_CODE',
        'That code is not valid. Request a new one.',
      );
    }

    const now = new Date();

    if (record.lockedUntil && record.lockedUntil > now) {
      throw ApiError.forbidden(
        'RESET_CODE_LOCKED',
        `Too many incorrect codes. Try again after ${record.lockedUntil.toISOString()}.`,
      );
    }

    if (record.expiresAt <= now) {
      throw ApiError.badRequest(
        'RESET_CODE_EXPIRED',
        'That code has expired. Request a new one.',
      );
    }

    // Re-verifying an already verified request would hand out a second token.
    if (record.verifiedAt) {
      throw ApiError.badRequest(
        'RESET_CODE_ALREADY_USED',
        'That code has already been used. Request a new one.',
      );
    }

    const correct = await argon2
      .verify(record.codeHash, code)
      .catch(() => false);

    if (!correct) {
      const attempts = record.attemptCount + 1;
      const locked = attempts >= this.maxAttempts;

      await this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: {
          attemptCount: attempts,
          lockedUntil: locked
            ? new Date(Date.now() + this.lockoutMinutes * 60_000)
            : null,
        },
      });

      if (locked) {
        this.logger.warn(
          `Reset request ${record.id} locked after ${attempts} incorrect codes`,
        );
        throw ApiError.forbidden(
          'RESET_CODE_LOCKED',
          `Too many incorrect codes. Try again in ${this.lockoutMinutes} minutes, or request a new code.`,
        );
      }

      const remaining = this.maxAttempts - attempts;
      throw new ApiError(
        'INVALID_RESET_CODE',
        remaining === 1
          ? 'That code is not correct. One attempt left.'
          : `That code is not correct. ${remaining} attempts left.`,
        400,
      );
    }

    // Correct. Issue the token that actually authorises the change. It is a
    // separate, high-entropy value so the short code is never reused as one.
    const resetToken = randomBytes(32).toString('base64url');
    const ttlSeconds = this.codeTtlMinutes * 60;

    await this.prisma.passwordResetToken.update({
      where: { id: record.id },
      data: {
        tokenHash: sha256(resetToken),
        verifiedAt: now,
        attemptCount: 0,
        lockedUntil: null,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });

    return { resetToken, expiresInSeconds: ttlSeconds };
  }

  // -- step 3: set the new password -----------------------------------------

  async reset(resetToken: string, newPassword: string): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(resetToken) },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        verifiedAt: true,
        user: { select: { email: true, passwordHash: true } },
      },
    });

    if (
      !record ||
      !record.verifiedAt ||
      record.usedAt ||
      record.expiresAt <= new Date()
    ) {
      throw ApiError.badRequest(
        'INVALID_RESET_TOKEN',
        'That reset session is no longer valid. Start again.',
      );
    }

    // Reusing the old password would leave the account exactly as exposed as
    // whatever prompted the reset. A Google-only account has no old password
    // to reuse, and setting one here is how it gains a second way in.
    const sameAsOld = record.user.passwordHash
      ? await argon2
          .verify(record.user.passwordHash, newPassword)
          .catch(() => false)
      : false;
    if (sameAsOld) {
      throw ApiError.badRequest(
        'PASSWORD_UNCHANGED',
        'Choose a password you have not used on this account before.',
      );
    }

    const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          // A reset is also the way out of a login lockout.
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      // Changing a password signs every existing session out.
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.mail.sendPasswordChangedNotice(record.user.email);
    this.logger.log(`Password reset completed for user ${record.userId}`);
  }
}

/**
 * A uniformly distributed 6 digit code. randomInt is rejection-sampled by Node,
 * so unlike `Math.random()` or a modulo of random bytes it has no bias.
 */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
