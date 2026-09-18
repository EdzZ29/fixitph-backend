import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { ChangeFeedService } from '../events/change-feed.service';
import { createHash } from 'node:crypto';

/** Cache windows, in milliseconds, exactly as the caching strategy specifies. */
export const TTL = {
  /** Search and browse listings. */
  LIST: 60_000,
  /** A single provider or service. */
  DETAIL: 5 * 60_000,
  /** The category tree. */
  CATEGORY_TREE: 60 * 60_000,
} as const;

/**
 * Namespaces that carry a version counter. Bumping the counter makes every
 * previously cached list key unreachable in one write, which is how a list
 * whose key includes an arbitrary query string gets invalidated without
 * scanning Redis for a pattern.
 */
export type CacheNamespace =
  'providers' | 'services' | 'categories' | 'reviews';

/**
 * A cache call that has not answered in this long is treated as a miss.
 *
 * Without this, an unreachable Redis does not fail: the client queues the
 * command and waits for a reconnection that may never come, so every cached
 * endpoint hangs instead of simply losing its cache. Falling back to the
 * database after a few hundred milliseconds is always the better trade.
 */
const CACHE_TIMEOUT_MS = 250;

/** Sentinel, so a legitimately cached null is never read as a timeout. */
const TIMED_OUT = Symbol('cache-timeout');

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  /** Logged once per process, not once per request, during an outage. */
  private degraded = false;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly feed: ChangeFeedService,
  ) {}

  /** Resolves to `fallback` if the cache does not answer in time or throws. */
  private async guard<T>(
    operation: string,
    run: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        run(),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), CACHE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);

      if (result === TIMED_OUT) {
        this.noteDegraded(`${operation} timed out after ${CACHE_TIMEOUT_MS}ms`);
        return fallback;
      }
      this.degraded = false;
      return result;
    } catch (e) {
      this.noteDegraded(`${operation} failed: ${(e as Error).message}`);
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private noteDegraded(detail: string): void {
    if (!this.degraded) {
      this.degraded = true;
      this.logger.warn(
        `Cache unavailable, serving from the database. ${detail}`,
      );
    }
  }

  // -- keys ------------------------------------------------------------------

  private versionKey(ns: CacheNamespace): string {
    return `v:${ns}`;
  }

  detailKey(ns: CacheNamespace, id: string): string {
    return `${ns}:detail:${id}`;
  }

  /**
   * List keys embed the namespace version and a hash of the full query, so two
   * different filter combinations never collide and a version bump orphans all
   * of them at once.
   */
  async listKey(
    ns: CacheNamespace,
    query: Record<string, unknown>,
  ): Promise<string> {
    const version = await this.version(ns);
    const canonical = JSON.stringify(
      Object.keys(query)
        .filter((k) => query[k] !== undefined && query[k] !== '')
        .sort()
        .map((k) => [k, query[k]]),
    );
    const digest = createHash('sha1')
      .update(canonical)
      .digest('hex')
      .slice(0, 16);
    return `${ns}:v${version}:list:${digest}`;
  }

  private async version(ns: CacheNamespace): Promise<number> {
    const current = await this.guard(
      `get ${this.versionKey(ns)}`,
      () => this.cache.get<number>(this.versionKey(ns)),
      null,
    );
    if (typeof current === 'number') return current;
    await this.guard(
      `set ${this.versionKey(ns)}`,
      () => this.cache.set(this.versionKey(ns), 1, 0), // 0 = no expiry
      undefined,
    );
    return 1;
  }

  // -- read through ----------------------------------------------------------

  /** Returns the cached value, or computes, stores and returns a fresh one. */
  async wrap<T>(
    key: string,
    ttlMs: number,
    produce: () => Promise<T>,
  ): Promise<T> {
    const hit = await this.guard<T | null | undefined>(
      `get ${key}`,
      () => this.cache.get<T>(key),
      null,
    );
    if (hit !== undefined && hit !== null) return hit;

    const value = await produce();
    await this.guard(
      `set ${key}`,
      () => this.cache.set(key, value, ttlMs),
      undefined,
    );
    return value;
  }

  // -- invalidation ----------------------------------------------------------

  /** Drops one exact key. Used on PATCH and DELETE of a single resource. */
  async invalidateDetail(ns: CacheNamespace, id: string): Promise<void> {
    await this.guard(
      `del ${this.detailKey(ns, id)}`,
      () => this.cache.del(this.detailKey(ns, id)),
      undefined,
    );
  }

  /** Orphans every list key in the namespace by moving the version forward. */
  async invalidateLists(ns: CacheNamespace): Promise<void> {
    const next = (await this.version(ns)) + 1;
    await this.guard(
      `bump ${this.versionKey(ns)}`,
      () => this.cache.set(this.versionKey(ns), next, 0),
      undefined,
    );

    /**
     * Anyone reading this resource is now looking at something out of date.
     *
     * This is the right place to say so, and it is the reason the change feed
     * needed no new call sites for the public data: every write that makes a
     * cached listing stale already calls this, because it had to. A separate
     * set of publish() calls would be a second list of the same thing, and
     * the two would drift the first time somebody added an endpoint.
     */
    this.feed.publish(ns);
  }

  /**
   * The usual case after a write: this resource's detail entry is gone and
   * every listing that might have contained it is stale.
   */
  async invalidateResource(ns: CacheNamespace, id?: string): Promise<void> {
    if (id) await this.invalidateDetail(ns, id);
    await this.invalidateLists(ns);
  }
}
