import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { ChangeFeedService, type ChangeResource } from './change-feed.service';

/**
 * Announces that something changed, so open pages can refetch it.
 *
 * This sits at the edge rather than in each service on purpose. A publish()
 * call in every write method is a second list of every write method, kept by
 * hand, and it is wrong the first time somebody adds an endpoint and forgets.
 * A successful non-GET request to /bookings is, by definition, a change to
 * bookings — the router already knows what was written, so it is the router
 * that should say so.
 *
 * It fires only on success. A rejected write changed nothing, and telling
 * every connected client to refetch because somebody failed validation would
 * hand anyone a way to make the whole site reload.
 */

/**
 * Path segment to the name a client listens for. Anything not listed is not
 * announced, which is the safe direction: an unlisted write simply behaves as
 * it did before this existed.
 */
const RESOURCE_BY_SEGMENT: Record<string, ChangeResource> = {
  bookings: 'bookings',
  categories: 'categories',
  disputes: 'disputes',
  favorites: 'providers',
  messages: 'messages',
  notifications: 'notifications',
  providers: 'providers',
  quotes: 'quotes',
  reports: 'reports',
  requests: 'requests',
  reviews: 'reviews',
  services: 'services',
  settings: 'settings',
  users: 'users',
};

/**
 * Writes that ripple.
 *
 * Accepting a quote creates a booking and closes the request; approving a
 * document changes what a profile shows. A client watching bookings has no
 * reason to know that the request came in on /quotes, so the fan-out belongs
 * here rather than in every page.
 */
const ALSO: Partial<Record<ChangeResource, ChangeResource[]>> = {
  quotes: ['requests', 'bookings', 'notifications'],
  requests: ['quotes', 'notifications'],
  bookings: ['notifications', 'messages'],
  messages: ['notifications'],
  reviews: ['providers', 'notifications'],
  disputes: ['bookings', 'notifications'],
  reports: ['notifications'],
};

/**
 * An administrator acting on someone is still a change to that thing, so the
 * segment after /admin is what matters. Verification is called out because it
 * has its own screen on the provider's side.
 */
const ADMIN_RESOURCE: Record<string, ChangeResource[]> = {
  providers: ['providers', 'verification', 'notifications'],
  documents: ['verification', 'providers', 'notifications'],
  verification: ['verification', 'providers', 'notifications'],
  users: ['users', 'notifications'],
  listings: ['services'],
  services: ['services'],
  reviews: ['reviews', 'providers'],
  reports: ['reports', 'notifications'],
  disputes: ['disputes', 'notifications'],
  categories: ['categories'],
  settings: ['settings'],
  bookings: ['bookings'],
};

/** Nothing here is worth waking a page up for. */
const IGNORED = new Set(['auth', 'uploads', 'events', 'health']);

@Injectable()
export class ChangePublishInterceptor implements NestInterceptor {
  constructor(private readonly feed: ChangeFeedService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const request = ctx.switchToHttp().getRequest<Request>();
    const method = request.method.toUpperCase();

    // A read changes nothing. HEAD and OPTIONS likewise.
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next.handle();
    }

    const resources = this.resourcesFor(request.path);
    if (!resources.length) return next.handle();

    return next
      .handle()
      .pipe(tap(() => resources.forEach((r) => this.feed.publish(r))));
  }

  private resourcesFor(path: string): ChangeResource[] {
    // "/api/admin/providers/123/verify" -> ["admin", "providers", ...]
    const segments = path.split('/').filter(Boolean);
    const apiIndex = segments.indexOf('api');
    const parts = apiIndex >= 0 ? segments.slice(apiIndex + 1) : segments;

    const [first, second] = parts;
    if (!first || IGNORED.has(first)) return [];

    if (first === 'admin') {
      return second ? (ADMIN_RESOURCE[second] ?? []) : [];
    }

    const resource = RESOURCE_BY_SEGMENT[first];
    if (!resource) return [];

    return [resource, ...(ALSO[resource] ?? [])];
  }
}
