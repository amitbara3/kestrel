/**
 * Dependency wiring.
 *
 * Construction is separated from the HTTP layer so tests can build a container
 * with in-process drivers and an injected clock, and `server.ts` stays a pure
 * function of its dependencies.
 */

import { createCache } from './cache/index.js';
import type { CacheDriver } from './cache/driver.js';
import type { Config } from './config.js';
import { IdGenerator } from './core/idgen.js';
import { LruCache } from './core/lru.js';
import { createStore } from './db/index.js';
import type { ShardedStore } from './db/index.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import { Metrics } from './middleware/metrics.js';
import { ClickTracker } from './services/analytics.js';
import { LinkService } from './services/link-service.js';

export interface Container {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  cache: CacheDriver;
  store: ShardedStore;
  service: LinkService;
  clicks: ClickTracker;
  startedAt: number;
  shutdown(): Promise<void>;
}

export const VERSION = '1.0.0';

export async function createContainer(config: Config): Promise<Container> {
  const logger = createLogger({
    level: config.logLevel,
    bindings: { instance: config.instanceId, version: VERSION },
  });

  const metrics = new Metrics(config.instanceId);
  const cache = await createCache(config, logger);
  const store = await createStore(config, logger);

  const l1 = new LruCache<string>({
    maxEntries: config.cache.l1MaxEntries,
    ttlMs: config.cache.l1TtlSeconds * 1000,
  });

  const idgen = new IdGenerator({ nodeId: config.nodeId });

  const clicks = new ClickTracker({
    store,
    logger,
    metrics,
    flushIntervalMs: config.analytics.flushIntervalMs,
    bufferMax: config.analytics.bufferMax,
  });
  clicks.start();

  const service = new LinkService({
    store,
    cache,
    l1,
    idgen,
    metrics,
    logger,
    ttlSeconds: config.cache.ttlSeconds,
    negativeTtlSeconds: config.cache.negativeTtlSeconds,
    l1TtlMs: config.cache.l1TtlSeconds * 1000,
    // Shortening a localhost URL is normal in development and a security bug in
    // production, so the allowance follows NODE_ENV rather than a separate flag.
    allowPrivateHosts: !config.isProduction,
  });

  logger.info('Container ready', {
    cacheDriver: cache.name,
    dbDriver: store.driverName,
    shards: store.shardCount,
    nodeId: config.nodeId,
    rateLimiting: config.rateLimit.enabled,
  });

  return {
    config,
    logger,
    metrics,
    cache,
    store,
    service,
    clicks,
    startedAt: Date.now(),
    /** Ordered so buffered clicks reach the database before its pools close. */
    async shutdown() {
      await clicks.stop();
      await Promise.allSettled([cache.close(), store.close()]);
    },
  };
}
