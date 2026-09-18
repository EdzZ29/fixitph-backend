import { Injectable, Logger } from '@nestjs/common';
import { OAuthProvider, UserRole, UserStatus } from '@prisma/client';
import { ApiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, type RequestMeta, type TokenPair } from './auth.service';

/**
 * Turning a Google identity into a FixItPH session.
 *
 * The passport strategy's only job is to talk to Google and hand back a
 * profile. Everything that decides *which account that is* happens here,
 * where it can be read in one place and tested without a browser.
 *
 * Three cases, in order:
 *
 *   1. We have seen this Google account before — sign into the account it is
 *      linked to. Matched on Google's subject id, never on the email, because
 *      a Workspace administrator can move an address between people and the
 *      subject id is what survives that.
 *
 *   2. The email belongs to an existing FixItPH account — link the two and
 *      sign in. See the note on linking below.
 *
 *   3. Nobody has that email — create a customer.
 */

/** What the strategy extracts from Google's response. */
export interface GoogleProfile {
  /** Google's stable subject id (`sub`). */
  id: string;
  email: string;
  /** Google's own assertion that the address reaches this person. */
  emailVerified: boolean;
  firstName: string;
  lastName: string;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async signIn(profile: GoogleProfile, meta: RequestMeta): Promise<TokenPair> {
    /**
     * An unverified Google address proves nothing.
     *
     * Everything below rests on "whoever holds this inbox owns this account",
     * so if Google itself will not vouch for the address there is no claim to
     * act on. In practice this only happens on some Workspace domains, and
     * refusing is far better than linking on an assertion nobody made.
     */
    if (!profile.emailVerified) {
      throw ApiError.forbidden(
        'GOOGLE_EMAIL_UNVERIFIED',
        'Google has not verified that email address, so it cannot be used to sign in.',
      );
    }

    const email = profile.email.toLowerCase();

    // -- 1. a returning Google user ------------------------------------------

    const existingLink = await this.prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: OAuthProvider.GOOGLE,
          providerAccountId: profile.id,
        },
      },
      select: {
        id: true,
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

    if (existingLink) {
      const user = existingLink.user;
      this.assertUsable(user);

      await this.prisma.oAuthAccount.update({
        where: { id: existingLink.id },
        data: { lastLoginAt: new Date(), email },
      });

      return this.finish(user, meta);
    }

    // -- 2. an account already has that email --------------------------------

    const byEmail = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        deletedAt: true,
        emailVerifiedAt: true,
        provider: { select: { id: true } },
      },
    });

    if (byEmail) {
      this.assertUsable(byEmail);

      /**
       * Linking, and what it costs.
       *
       * Google has confirmed this person holds the inbox, which is the same
       * evidence our own email verification collects — so they are treated as
       * the owner of the account on that address, and the account's email is
       * marked verified from here.
       *
       * Every other session on the account is revoked at the same moment.
       * The case that matters is an account somebody else created on this
       * address before its real owner ever arrived: the rightful owner has
       * just proved the inbox, and anyone else holding a live session on it
       * loses it immediately. The password is deliberately left in place —
       * clearing it would lock out the large number of people who simply
       * never got round to verifying their email, and that is a worse failure
       * than the one it would prevent.
       */
      await this.prisma.$transaction(async (tx) => {
        await tx.oAuthAccount.create({
          data: {
            userId: byEmail.id,
            provider: OAuthProvider.GOOGLE,
            providerAccountId: profile.id,
            email,
            lastLoginAt: new Date(),
          },
        });

        await tx.user.update({
          where: { id: byEmail.id },
          data: { emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date() },
        });

        await tx.refreshToken.updateMany({
          where: { userId: byEmail.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });

      this.logger.log(
        `Linked Google account to existing user ${byEmail.id}; other sessions revoked`,
      );
      return this.finish(byEmail, meta);
    }

    // -- 3. somebody new -----------------------------------------------------

    /**
     * Always a customer.
     *
     * Becoming a provider means a business profile and documents an
     * administrator has to approve, so it stays a deliberate step taken from
     * inside the account rather than something a sign-in button decides.
     *
     * The account is ACTIVE and its email already verified: Google just
     * proved the address, so asking the person to confirm a code sent to the
     * inbox they signed in with would be asking them to prove it twice.
     */
    const created = await this.prisma.user.create({
      data: {
        email,
        passwordHash: null,
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        profile: {
          create: {
            firstName: profile.firstName,
            lastName: profile.lastName,
          },
        },
        oauthAccounts: {
          create: {
            provider: OAuthProvider.GOOGLE,
            providerAccountId: profile.id,
            email,
            lastLoginAt: new Date(),
          },
        },
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        deletedAt: true,
        provider: { select: { id: true } },
      },
    });

    this.logger.log(`Created account ${created.id} from a Google sign-in`);
    return this.finish(created, meta);
  }

  /** The same refusals login applies, so Google is not a way around them. */
  private assertUsable(user: {
    status: UserStatus;
    deletedAt: Date | null;
  }): void {
    if (user.deletedAt) {
      throw ApiError.forbidden(
        'ACCOUNT_DEACTIVATED',
        'This account is closed.',
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
  }

  private async finish(
    user: {
      id: string;
      email: string;
      role: UserRole;
      provider: { id: string } | null;
    },
    meta: RequestMeta,
  ): Promise<TokenPair> {
    await this.prisma.user.update({
      where: { id: user.id },
      // A Google sign-in clears the lockout counter for the same reason a
      // password sign-in does: the person is demonstrably who they say.
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    return this.auth.issueTokensFor(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        providerId: user.provider?.id ?? null,
      },
      meta,
    );
  }
}
