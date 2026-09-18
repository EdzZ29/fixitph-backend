import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ApiError } from '../../common/errors';

/**
 * Turns anything that goes wrong during the Google handshake into a page.
 *
 * These two routes are browser navigations, not API calls. A JSON error body
 * is useless there — the person is looking at a blank tab showing
 * {"success":false}, with no way back. So every failure, expected or not,
 * ends up on /login carrying a code the page can put into words.
 *
 * It catches everything rather than just ApiError deliberately. Passport
 * throws its own errors when Google rejects a code, the network drops
 * mid-exchange, or the client secret is wrong, and every one of those is a
 * person stranded on a blank page if it is allowed through.
 */
@Catch()
export class OAuthRedirectFilter implements ExceptionFilter {
  private readonly logger = new Logger(OAuthRedirectFilter.name);

  constructor(private readonly config: ConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    const code =
      exception instanceof ApiError
        ? exception.code.toLowerCase()
        : 'oauth_failed';

    // Logged in full here, because the redirect deliberately tells the
    // browser almost nothing.
    this.logger.warn(
      `Google sign-in failed (${code}): ${
        exception instanceof Error ? exception.message : String(exception)
      }`,
    );

    if (res.headersSent) return;

    res.redirect(
      `${frontendOrigin(this.config)}/login?error=${encodeURIComponent(code)}`,
    );
  }
}

/**
 * Where to send somebody back to.
 *
 * The first entry in the CORS allow-list, never anything from the request. A
 * redirect target that a query parameter could set is an open redirect, and
 * an open redirect on a sign-in route is a phishing tool: the link genuinely
 * starts at fixitph, which is exactly what makes it convincing.
 */
export function frontendOrigin(config: ConfigService): string {
  return config
    .getOrThrow<string>('CORS_ORIGIN')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
}
