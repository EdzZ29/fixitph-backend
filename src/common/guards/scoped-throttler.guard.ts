import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerStorage,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';
import { THROTTLER_OPTIONS } from '@nestjs/throttler/dist/throttler.constants';
import type { Request } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Rate limiting keyed by *who is asking*, not by where they happen to be
 * connecting from.
 *
 * The default tracker is the client IP, which is the wrong unit for this
 * platform. A lot of this traffic arrives through one address: an office, a
 * mall's wifi, a mobile carrier's CGNAT. Under an IP tracker one person
 * loading a dashboard spends everybody else's budget, and the symptom is a
 * 429 on an ordinary read for someone who has done nothing unusual.
 *
 * So: a request carrying a valid access token is tracked against that user.
 * Everyone else is tracked by IP, as before.
 *
 * Two things make this safe to do in a guard that runs *before* authentication
 * (which it must, so a flood is rejected before it costs a database round
 * trip):
 *
 *   - The signature is verified here, with the same secret the JWT strategy
 *     uses. An unverified `sub` would let an attacker mint a fresh bucket per
 *     request simply by editing the payload, which is worse than no
 *     per-user tracking at all.
 *   - Verification is a single HMAC. No database, no async work, nothing that
 *     a flood could exhaust.
 *
 * The token is never trusted for anything beyond choosing a bucket. Deciding
 * who the caller actually is remains the JWT strategy's job, after this.
 */
@Injectable()
export class ScopedThrottlerGuard extends ThrottlerGuard {
  private readonly accessSecret: string;

  constructor(
    @Inject(THROTTLER_OPTIONS) options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService,
  ) {
    super(options, storageService, reflector);
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  // Returns a promise because the framework's signature says so; nothing here
  // needs to wait for anything, which is the point.
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request;

    const subject = this.subjectFromToken(
      request.headers?.authorization ?? undefined,
    );
    if (subject) return Promise.resolve(`user:${subject}`);

    // Falls back to the framework's own IP resolution, which already accounts
    // for the trust-proxy setting the app sets at bootstrap.
    return Promise.resolve(`ip:${request.ip ?? 'unknown'}`);
  }

  /**
   * The `sub` claim of a Bearer token whose signature and expiry both check
   * out, or undefined. Deliberately hand-rolled rather than pulled from
   * JwtService: this runs on every request including unauthenticated ones,
   * and it must not throw, allocate much, or reach outside the process.
   */
  private subjectFromToken(header?: string): string | undefined {
    if (!header?.startsWith('Bearer ')) return undefined;

    const token = header.slice(7).trim();
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;

    const [encodedHeader, encodedPayload, signature] = parts;

    try {
      const expected = createHmac('sha256', this.accessSecret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

      const given = Buffer.from(signature);
      const want = Buffer.from(expected);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        return undefined;
      }

      const payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as { sub?: unknown; exp?: unknown };

      // An expired token gets no per-user bucket; it is about to be rejected
      // anyway and should not be a way to keep a bucket alive.
      if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
        return undefined;
      }

      if (typeof payload.sub !== 'string' || !payload.sub) return undefined;

      // Hashed so a user id never lands in a cache key or a log line.
      return createHash('sha256').update(payload.sub).digest('base64url');
    } catch {
      return undefined;
    }
  }
}
