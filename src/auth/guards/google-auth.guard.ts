import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { ApiError } from '../../common/errors';

/**
 * Passport's Google guard, with two things added.
 *
 * First, it answers usefully when Google is not set up. The strategy is only
 * registered when credentials are present — a passport strategy built with an
 * empty client id throws on construction and would take the whole API down at
 * boot over an optional feature. Without this check the route would instead
 * fail with "Unknown authentication strategy: google", which tells whoever is
 * reading the log nothing about what to do.
 *
 * Second, it owns the CSRF state.
 *
 * Without state, an attacker can complete a Google login on their own account,
 * hold on to the resulting callback URL, and get a victim's browser to follow
 * it — the victim silently ends up signed into the attacker's account, and
 * anything they do next happens in it. So the outbound leg mints a nonce,
 * pins it to the browser in a short-lived httpOnly cookie, and hands it to
 * Google, which echoes it back. The callback only proceeds if the value Google
 * returned matches the cookie on the browser that started the flow.
 *
 * `session: false` matches the rest of the app and rules out passport's own
 * state store, which is why this is here rather than a one-line option.
 */

export const OAUTH_STATE_COOKIE = 'fixitph_oauth';

/** Long enough to read a consent screen, short enough to be worthless later. */
const STATE_TTL_MS = 10 * 60_000;

/** Constant time, so the nonce cannot be guessed a character at a time. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService) {
    super();
  }

  canActivate(context: ExecutionContext) {
    if (!this.config.get<string>('GOOGLE_CLIENT_ID')) {
      throw ApiError.unprocessable(
        'GOOGLE_SIGN_IN_UNAVAILABLE',
        'Signing in with Google is not configured on this server.',
      );
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { oauthState?: string }>();
    const response = http.getResponse<Response>();

    // The outbound leg is the one with no authorisation code on it.
    if (!request.query.code) {
      const nonce = randomBytes(16).toString('base64url');
      request.oauthState = nonce;

      response.cookie(OAUTH_STATE_COOKIE, nonce, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.config.get('COOKIE_SECURE') === 'true',
        domain: this.config.get<string>('COOKIE_DOMAIN') || undefined,
        path: '/',
        maxAge: STATE_TTL_MS,
      });

      return super.canActivate(context);
    }

    /**
     * On the way back, before anything else.
     *
     * This has to happen ahead of super.canActivate, because that is what
     * exchanges the authorisation code with Google. Checking afterwards would
     * still reject the request, but only after spending a round trip to
     * Google on a code an attacker chose — and it would mean the handler was
     * the first thing able to refuse, which is too late to be the guard's
     * job.
     */
    const cookies = request.cookies as Record<string, string> | undefined;
    const expected = cookies?.[OAUTH_STATE_COOKIE];
    const returned =
      typeof request.query.state === 'string' ? request.query.state : undefined;

    response.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

    /**
     * A missing cookie fails just as hard as a mismatched one: it means this
     * browser did not start the flow, which is the exact shape of the attack
     * the state exists to stop.
     */
    if (!expected || !returned || !safeEqual(expected, returned)) {
      throw ApiError.forbidden(
        'OAUTH_STATE',
        'That sign-in did not start in this browser.',
      );
    }

    return super.canActivate(context);
  }

  getAuthenticateOptions(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { oauthState?: string }>();

    return { session: false, state: request.oauthState };
  }
}
