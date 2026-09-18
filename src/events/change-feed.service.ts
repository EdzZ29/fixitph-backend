import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/**
 * A feed of "this kind of thing changed", so pages do not have to be
 * refreshed by hand.
 *
 * The events carry a resource name and nothing else. That is the design, not
 * a shortcut: a payload would have to be filtered per recipient, and getting
 * that wrong on a table under row level security means sending somebody
 * another person's booking. Instead the client hears that bookings changed
 * and refetches through the ordinary endpoint, which is already scoped to
 * whoever is asking. The worst an eavesdropper learns is that the site is
 * being used.
 *
 * It is in-process. One API instance serves its own connections, which is
 * what this deployment is; more than one would need Redis pub/sub in place of
 * the subject below, and nothing else would change.
 */

/**
 * The names a client can listen for. They match the sections of the API a
 * page reads from rather than table names, because that is what the client
 * needs to decide whether a refetch is worth making.
 */
export type ChangeResource =
  | 'bookings'
  | 'categories'
  | 'disputes'
  | 'messages'
  | 'notifications'
  | 'providers'
  | 'quotes'
  | 'reports'
  | 'requests'
  | 'reviews'
  | 'services'
  | 'settings'
  | 'users'
  | 'verification';

export interface ChangeEvent {
  resource: ChangeResource;
  at: number;
}

/**
 * The shortest gap between two events for the same resource.
 *
 * A single action often writes several rows — accepting a quote touches the
 * quote, the request and the booking — and without this each write would be
 * its own event and every listening page would refetch three times for one
 * thing happening. Half a second is below what anyone reads as a delay.
 */
const COALESCE_MS = 500;

@Injectable()
export class ChangeFeedService {
  private readonly logger = new Logger(ChangeFeedService.name);
  private readonly changes = new Subject<ChangeEvent>();

  /** Last emission per resource, for the coalescing window. */
  private readonly lastEmitted = new Map<ChangeResource, number>();
  /** A pending trailing emission, so the last write in a burst is not lost. */
  private readonly trailing = new Map<ChangeResource, NodeJS.Timeout>();

  /** Open connections, so a leak shows up somewhere other than memory usage. */
  private listeners = 0;

  publish(resource: ChangeResource): void {
    const now = Date.now();
    const last = this.lastEmitted.get(resource) ?? 0;
    const waited = now - last;

    if (waited >= COALESCE_MS) {
      this.emit(resource, now);
      return;
    }

    /**
     * Inside the window. Schedule one emission for the end of it rather than
     * dropping this write: dropping it would mean a change that happened just
     * after an event never reached anyone, and the page would sit there stale
     * until something else happened.
     */
    if (this.trailing.has(resource)) return;
    this.trailing.set(
      resource,
      setTimeout(() => {
        this.trailing.delete(resource);
        this.emit(resource, Date.now());
      }, COALESCE_MS - waited).unref(),
    );
  }

  private emit(resource: ChangeResource, at: number): void {
    this.lastEmitted.set(resource, at);
    this.changes.next({ resource, at });
  }

  /** One stream per connected client. */
  observe(): Observable<ChangeEvent> {
    return this.changes.asObservable();
  }

  opened(): void {
    this.listeners += 1;
  }

  closed(): void {
    this.listeners = Math.max(0, this.listeners - 1);
  }

  get connections(): number {
    return this.listeners;
  }
}
