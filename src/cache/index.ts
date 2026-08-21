/**
 * Cache driver selection.
 *
 * REDIS_URL present -> Redis. Absent -> in-process memory. There is no separate
 * "mode" flag, because a flag and a URL can disagree and then the boot log lies.
 *
 * A degraded selection is always logged at warn (Rules.md §7).
 */

import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { CacheDriver } from './driver.js';
import { MemoryCache } from './memory.js';
import { RedisCache } from './redis.js';

export type { CacheDriver, RateLimitResult } from './driver.js';
export { MemoryCache } from './memory.js';
export { RedisCache } from './redis.js';
export { CircuitBreaker } from './circuit-breaker.js';

export async function createCache(config: Config, logger: Logger): Promise<CacheDriver> {
  if (config.cache.redisUrl === undefined) {
    logger.warn('No REDIS_URL set — using the in-process cache', {
      driver: 'memory',
      consequence: 'cache and rate limits are per-replica, not shared',
    });
    return new MemoryCache();
  }

  const cache = new RedisCache({
    url: config.cache.redisUrl,
    keyPrefix: config.cache.keyPrefix,
    logger,
  });

  try {
    await cache.connect();
    logger.info('Connected to Redis', { driver: 'redis' });
  } catch (err) {
    // Boot proceeds: the breaker will keep probing, and the service is designed
    // to serve correctly (if slower) with the cache down. Refusing to start
    // would turn a cache outage into a total outage, which NFR-5 forbids.
    logger.error('Redis unreachable at startup — starting in degraded mode', {
      error: err instanceof Error ? err.message : String(err),
      degraded: true,
    });
  }

  return cache;
}

/**
 * Spread TTLs by +/-10%.
 *
 * Without this, a batch of keys written together expires together and the
 * database sees a periodic spike — the cache avalanche in Architecture.md §4.
 * The jitter is per-write, so a popular key naturally desynchronises from its
 * cohort over time.
 */
export function jitterTtl(baseSeconds: number, spread = 0.1): number {
  const delta = baseSeconds * spread;
  return Math.max(1, Math.round(baseSeconds - delta + Math.random() * delta * 2));
}
