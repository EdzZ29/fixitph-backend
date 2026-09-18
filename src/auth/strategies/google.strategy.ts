import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import {
  Strategy,
  type Profile,
  type VerifyCallback,
} from 'passport-google-oauth20';
import type { GoogleProfile } from '../google-auth.service';

/**
 * The conversation with Google, and nothing else.
 *
 * This deliberately does no account work. It reads Google's answer, reduces
 * it to the handful of fields FixItPH actually uses, and hands that on —
 * every decision about which account the person is belongs in
 * GoogleAuthService, where it can be read in one place.
 *
 * The app keeps no server-side session to park a half-finished login in, so
 * the guard authenticates with `session: false`. That also rules out
 * passport's own state store, which is why the CSRF state is minted by the
 * guard and checked in the controller instead.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: config.getOrThrow<string>('GOOGLE_CALLBACK_URL'),
      // The minimum that answers "who is this and where do we reach them".
      // Asking for more would mean a longer consent screen for data no part
      // of FixItPH reads.
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0];

    if (!email?.value) {
      // Without an address there is nothing to match an account on.
      done(new Error('Google did not return an email address'));
      return;
    }

    /**
     * `verified` is typed as string | boolean because Google has sent both
     * over the years. Anything that is not an explicit yes is treated as no:
     * the whole linking rule rests on this flag, so a shape we do not
     * recognise must fail closed.
     */
    const verified = email.verified as string | boolean | undefined;
    const emailVerified = verified === true || verified === 'true';

    const result: GoogleProfile = {
      id: profile.id,
      email: email.value,
      emailVerified,
      firstName: profile.name?.givenName?.trim() || 'FixItPH',
      lastName: profile.name?.familyName?.trim() || 'Customer',
    };

    done(null, result);
  }
}
