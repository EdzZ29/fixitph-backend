import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createKeyv } from '@keyv/redis';
import { Keyv } from 'keyv';
import { CacheService } from './cache.service';

/**
 * Redis-backed cache, with an in-memory fallback.
 *
 * Package note: the brief named `cache-manager-redis-store`. That package
 * targets cache-manager v5 and is incompatible with @nestjs/cache-manager v12,
 * which requires cache-manager >= 6 and Keyv >= 5. `@keyv/redis` is the
 * maintained store for that combination and is wired through the same
 * CacheModule API, so nothing else about the strategy changes.
 *
 * Leaving REDIS_URL empty selects an in-process store instead. That is there so
 * the API runs on a machine without Docker or a Redis install. It is fine for
 * one developer and wrong for anything else: the cache is per process, so two
 * instances would disagree, and an invalidation on one would not reach the
 * other. The API says so loudly at boot.
 */
@Global()
@Module({
  imports: [
    NestCacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('Cache');
        const url = config.get<string>('REDIS_URL')?.trim();

        let store: Keyv;

        if (url) {
          store = createKeyv(url, { namespace: 'fixitph' });
          logger.log(`Using Redis at ${redactCredentials(url)}`);
        } else {
          store = new Keyv({ namespace: 'fixitph' });
          logger.warn(
            'REDIS_URL is empty, using an in-memory cache. Single process only: ' +
              'do not run more than one instance against it.',
          );
        }

        // Redis going away must degrade to "no cache", never take the API with
        // it. Without a listener an emitted error is an unhandled exception.
        store.on('error', (err: Error) => {
          logger.warn(`Cache store error: ${err.message}`);
        });

        return {
          stores: [store],
          // Per-entry TTLs are always passed explicitly; this is only a floor.
          ttl: 60_000,
          nonBlocking: true,
        };
      },
    }),
  ],
  providers: [CacheService],
  exports: [CacheService, NestCacheModule],
})
export class CacheModule {}

/** Keeps a password out of the startup log. */
function redactCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return 'redis';
  }
}
