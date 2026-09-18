import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes, randomInt } from 'node:crypto';
import { ApiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { toAuthContext, type AuthenticatedUser } from '../common/types';

/**
 * Proving that an email address reaches the person using the account.
 *
 * This is the first rung of provider verification, and until now it did not
 * exist: users.email_verified_at was a column nothing ever wrote, so the
 * "Email Verified" badge could only come from a seed.
 *
 * Modelled on the password reset flow, with one deliberate difference. Reset
 * is anonymous, so it has to be careful never to reveal whether an address is
 * registered. This one requires a session — you are verifying *your own*
 * address — so there is no enumeration oracle to protect and the errors can
 * say what actually went wrong, which makes it a far better experience.
 *
 * What it keeps from that flow: the code is stored only as an argon2id hash,
 * wrong guesses are counted, and exceeding the budget locks that request
 * rather than the account. Locking the account would hand anyone who knows
 * your address a way to keep you out of it.
 */

const ARGON2_OPTIONS: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

/** Burned when a code is checked against a request that is not there. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';

export interface SendResult {
  message: string;
  codeTtlMinutes: number;
  /** Only outside production, so local development does not need a mailbox. */
  devCode?: string;
}

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly codeTtlMinutes: number;
  private readonly maxAttempts: number;
  private readonly lockoutMinutes: number;
  private readonly resendCooldownSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {
    this.codeTtlMinutes = config.get<number>('EMAIL_CODE_TTL_MINUTES', 15);
    this.maxAttempts = config.get<number>('EMAIL_MAX_ATTEMPTS', 5);
    this.lockoutMinutes = config.get<number>('EMAIL_LOCKOUT_MINUTES', 15);
    this.resendCooldownSeconds = config.get<number>(
      'EMAIL_RESEND_COOLDOWN_SECONDS',
      60,
    );
  }

  // -- step 1: send the code -------------------------------------------------

  async send(
    user: AuthenticatedUser,
    meta: { ip?: string } = {},
  ): Promise<SendResult> {
    const account = await this.prisma.user.findFirst({
      where: { id: user.id, deletedAt: null },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!account) throw ApiError.notFound('USER_NOT_FOUND');

    if (account.emailVerifiedAt) {
      throw ApiError.conflict(
        'EMAIL_ALREADY_VERIFIED',
        'That address is already verified.',
      );
    }

    // Hashed before the transaction opens: argon2 is deliberately slow, and
    // holding a database connection through it would be a waste of one.
    const code = generateCode();
    const codeHash = await argon2.hash(code, ARGON2_OPTIONS);

    /**
     * Everything that touches the table runs inside withUser.
     *
     * Not optional: email_verification_tokens is under row level security and
     * the API connects as a role that cannot bypass it, so a read without the
     * session context set does not fail — it silently returns nothing. The
     * cooldown check below would then never fire, and confirm() would report
     * that no code had been requested seconds after sending one.
     *
     * The check also belongs in the same transaction as the insert, so two
     * requests arriving together cannot both find the coast clear.
     */
    await this.prisma.withUser(toAuthContext(user), async (tx) => {
      /**
       * A cooldown between sends, on top of the route's rate limit.
       *
       * The limiter counts requests; this stops a stream of emails landing in
       * someone's inbox from a button being pressed repeatedly, which is the
       * thing that gets a sending domain reported.
       */
      const recent = await tx.emailVerificationToken.findFirst({
        where: { userId: account.id, usedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      if (recent) {
        const waited = (Date.now() - recent.createdAt.getTime()) / 1000;
        if (waited < this.resendCooldownSeconds) {
          throw ApiError.conflict(
            'EMAIL_CODE_TOO_SOON',
            `A code was just sent. Wait ${Math.ceil(
              this.resendCooldownSeconds - waited,
            )} seconds before asking for another.`,
          );
        }
      }

      // Any earlier code is spent: only the newest one should work, or a
      // stale code from an old email sits there as a second way in.
      await tx.emailVerificationToken.updateMany({
        where: { userId: account.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.emailVerificationToken.create({
        data: {
          userId: account.id,
          email: account.email,
          codeHash,
          expiresAt: new Date(Date.now() + this.codeTtlMinutes * 60_000),
          requestedIp: meta.ip ?? null,
        },
      });
    });

    await this.mail.sendEmailVerificationCode(
      account.email,
      code,
      this.codeTtlMinutes,
    );

    return {
      message: `We sent a code to ${account.email}.`,
      codeTtlMinutes: this.codeTtlMinutes,
      // Development convenience only. Never in production, where it would
      // put the code in a response body and in every access log.
      ...(this.config.get('NODE_ENV') !== 'production'
        ? { devCode: code }
        : {}),
    };
  }

  // -- step 2: confirm it ----------------------------------------------------

  async confirm(
    user: AuthenticatedUser,
    code: string,
  ): Promise<{ verifiedAt: Date }> {
    const account = await this.prisma.user.findFirst({
      where: { id: user.id, deletedAt: null },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!account) throw ApiError.notFound('USER_NOT_FOUND');

    if (account.emailVerifiedAt) {
      return { verifiedAt: account.emailVerifiedAt };
    }

    // Read under the caller's session, for the reason described in send():
    // without it row level security hides the row rather than raising.
    const record = await this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.emailVerificationToken.findFirst({
        where: { userId: account.id, usedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
    );

    if (!record) {
      // Spend the same work as a real check, so a missing request and a wrong
      // code take the same time.
      await argon2.verify(DUMMY_HASH, code).catch(() => false);
      throw ApiError.badRequest(
        'EMAIL_CODE_NOT_REQUESTED',
        'Ask for a code first.',
      );
    }

    if (record.lockedUntil && record.lockedUntil > new Date()) {
      throw ApiError.conflict(
        'EMAIL_CODE_LOCKED',
        'Too many wrong codes. Ask for a new one in a few minutes.',
      );
    }

    if (record.expiresAt <= new Date()) {
      throw ApiError.badRequest(
        'EMAIL_CODE_EXPIRED',
        'That code has expired. Ask for a new one.',
      );
    }

    /**
     * The address is checked against the one the code was issued for.
     * Otherwise changing your email after requesting a code would let the old
     * code confirm the new address — proving nothing about the new inbox.
     */
    if (record.email.toLowerCase() !== account.email.toLowerCase()) {
      throw ApiError.badRequest(
        'EMAIL_CHANGED',
        'Your email address changed after that code was sent. Ask for a new one.',
      );
    }

    const correct = await argon2
      .verify(record.codeHash, code)
      .catch(() => false);

    if (!correct) {
      const attempts = record.attemptCount + 1;
      const locked = attempts >= this.maxAttempts;

      await this.prisma.withUser(toAuthContext(user), (tx) =>
        tx.emailVerificationToken.update({
          where: { id: record.id },
          data: {
            attemptCount: attempts,
            ...(locked
              ? {
                  lockedUntil: new Date(
                    Date.now() + this.lockoutMinutes * 60_000,
                  ),
                }
              : {}),
          },
        }),
      );

      if (locked) {
        throw ApiError.conflict(
          'EMAIL_CODE_LOCKED',
          'Too many wrong codes. Ask for a new one in a few minutes.',
        );
      }

      throw ApiError.badRequest(
        'EMAIL_CODE_INVALID',
        `That code is not right. ${this.maxAttempts - attempts} ${
          this.maxAttempts - attempts === 1 ? 'try' : 'tries'
        } left.`,
      );
    }

    const verifiedAt = new Date();

    await this.prisma.withUser(toAuthContext(user), async (tx) => {
      await tx.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: verifiedAt },
      });

      await tx.user.update({
        where: { id: account.id },
        data: { emailVerifiedAt: verifiedAt },
      });
    });

    this.logger.log(`Email verified for user ${account.id}`);
    return { verifiedAt };
  }

  /** What the UI needs to decide which step to show. */
  async status(user: AuthenticatedUser): Promise<{
    email: string;
    verified: boolean;
    verifiedAt: Date | null;
    codePending: boolean;
    codeExpiresAt: Date | null;
  }> {
    const account = await this.prisma.user.findFirst({
      where: { id: user.id, deletedAt: null },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!account) throw ApiError.notFound('USER_NOT_FOUND');

    const pending = account.emailVerifiedAt
      ? null
      : await this.prisma.withUser(toAuthContext(user), (tx) =>
          tx.emailVerificationToken.findFirst({
            where: {
              userId: user.id,
              usedAt: null,
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
            select: { expiresAt: true },
          }),
        );

    return {
      email: account.email,
      verified: account.emailVerifiedAt !== null,
      verifiedAt: account.emailVerifiedAt,
      codePending: pending !== null,
      codeExpiresAt: pending?.expiresAt ?? null,
    };
  }
}

/**
 * Six digits, uniformly drawn. randomInt is the CSPRNG, and padding keeps a
 * leading zero rather than quietly making the code five digits.
 */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Kept for parity with the reset flow's token generation. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}
