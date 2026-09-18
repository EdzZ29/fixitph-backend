import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Observable, finalize, interval, map, merge } from 'rxjs';
import { ApiError } from '../common/errors';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../common/types';
import { ChangeFeedService, type ChangeEvent } from './change-feed.service';

/**
 * The live connection a page holds open so it updates itself.
 *
 * Two steps, and the first one is the interesting part.
 *
 * EventSource cannot set an Authorization header — it is the one fetch in the
 * browser that takes a URL and nothing else. The usual answers are to put the
 * access token in the query string, where it lands in every access log and
 * referrer, or to authenticate the stream with a cookie, which means the
 * stream is reachable by any page that can make the browser issue a request.
 *
 * So the client spends its ordinary access token on a ticket: a token that is
 * good for sixty seconds, for this one purpose, and for nothing else. If it
 * leaks through a log it has almost certainly expired already, and even fresh
 * it opens a stream that carries no data.
 */

/** How long a ticket is good for. Long enough to open a connection, no more. */
const TICKET_TTL_SECONDS = 60;

/** Marks a token as usable for the stream and nothing else. */
const TICKET_TYPE = 'sse';

/**
 * A comment line every so often, to stop a proxy deciding an idle connection
 * has been abandoned. Most give up somewhere around a minute.
 */
const HEARTBEAT_MS = 25_000;

/**
 * One frame, as the browser sees it.
 *
 * Deliberately a flat object with a `kind` rather than an SSE event name.
 * Nest serialises whatever the observable emits into the `data:` field and
 * does not lift a `type` property out into an `event:` line, so naming the
 * event that way produced frames whose name never reached the wire. A
 * discriminator inside the payload works on every client and is one thing to
 * read instead of two.
 */
type StreamFrame =
  ({ kind: 'change' } & ChangeEvent) | { kind: 'ping'; at: number };

@Controller('events')
export class EventsController {
  constructor(
    private readonly feed: ChangeFeedService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Spends a session for a short-lived ticket to open the stream with. */
  @Post('ticket')
  @HttpCode(HttpStatus.OK)
  ticket(@CurrentUser() user: AuthenticatedUser): {
    ticket: string;
    expiresIn: number;
  } {
    const ticket = this.jwt.sign(
      { sub: user.id, typ: TICKET_TYPE },
      { expiresIn: TICKET_TTL_SECONDS },
    );
    return { ticket, expiresIn: TICKET_TTL_SECONDS };
  }

  /**
   * Public only in the sense that the usual guard does not run: the ticket is
   * checked here instead, because the guard reads an Authorization header
   * that EventSource cannot send.
   */
  @Public()
  @Sse('stream')
  stream(@Query('ticket') ticket?: string): Observable<StreamFrame> {
    this.verifyTicket(ticket);
    this.feed.opened();

    const changes = this.feed
      .observe()
      .pipe(map((event): StreamFrame => ({ kind: 'change', ...event })));

    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): StreamFrame => ({ kind: 'ping', at: Date.now() })),
    );

    return merge(changes, heartbeat).pipe(finalize(() => this.feed.closed()));
  }

  private verifyTicket(ticket?: string): void {
    if (!ticket) {
      throw ApiError.unauthenticated('EVENTS_TICKET_REQUIRED');
    }

    try {
      const claims = this.jwt.verify<{ sub?: string; typ?: string }>(ticket, {
        issuer: this.config.get<string>('JWT_ISSUER', 'fixitph'),
      });

      /**
       * An access token must not work here, and a ticket must not work
       * anywhere else. Without this check the ticket is simply a second
       * access token with a shorter life, handed out in a URL.
       */
      if (claims.typ !== TICKET_TYPE || !claims.sub) {
        throw ApiError.unauthenticated('EVENTS_TICKET_INVALID');
      }
    } catch (thrown) {
      if (thrown instanceof ApiError) throw thrown;
      throw ApiError.unauthenticated(
        'EVENTS_TICKET_INVALID',
        'That connection ticket is not valid any more. Ask for another.',
      );
    }
  }
}
