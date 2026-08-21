/**
 * /health, /ready, /metrics.
 *
 * The distinction matters in a load-balanced deployment:
 *   /health  liveness  — "the process is running". Never touches a dependency,
 *                        because a restart cannot fix a sick database and
 *                        restart loops make an outage worse.
 *   /ready   readiness — "this replica can serve". Checks dependencies and
 *                        returns 503 so the balancer drains it while it stays up.
 *
 * All three are exempt from rate limiting; a limiter that blocks the scraper
 * blinds you exactly when you need the data.
 */

import type { FastifyInstance } from 'fastify';

import type { CacheDriver } from '../cache/driver.js';
import type { ShardedStore } from '../db/index.js';
import type { Metrics } from '../middleware/metrics.js';

export interface SystemRouteOptions {
  cache: CacheDriver;
  store: ShardedStore;
  metrics: Metrics;
  instanceId: string;
  version: string;
  startedAt: number;
}

export function registerSystemRoutes(app: FastifyInstance, options: SystemRouteOptions): void {
  const { cache, store, metrics, instanceId, version, startedAt } = options;

  app.get('/health', { config: { rateLimitTier: 'exempt' } }, async (_request, reply) =>
    reply.send({
      status: 'ok',
      instance: instanceId,
      version,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  app.get('/ready', { config: { rateLimitTier: 'exempt' } }, async (_request, reply) => {
    const [shards, cacheUp] = await Promise.all([
      store.ping().catch(() => []),
      cache.ping().catch(() => false),
    ]);

    const healthyShards = shards.filter((s) => s.healthy).length;
    const dbUp = shards.length > 0 && healthyShards === shards.length;

    metrics.dependencyUp.set(cacheUp ? 1 : 0, metrics.withInstance({ dependency: 'cache' }));
    metrics.dependencyUp.set(dbUp ? 1 : 0, metrics.withInstance({ dependency: 'database' }));

    // The database is a hard dependency; the cache is not. A replica with a
    // cold cache still serves correct answers, just slower (NFR-5).
    const ready = dbUp;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      instance: instanceId,
      dependencies: {
        database: {
          driver: store.driverName,
          status: dbUp ? 'up' : 'down',
          shards: shards.length,
          healthyShards,
          required: true,
        },
        cache: {
          driver: cache.name,
          status: cacheUp ? 'up' : 'down',
          degraded: !cache.healthy,
          required: false,
        },
      },
    });
  });

  app.get('/metrics', { config: { rateLimitTier: 'exempt' } }, async (_request, reply) =>
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render()),
  );

  /** Evidence that hash routing actually spreads rows — useful in a demo and in review. */
  app.get('/api/shards', { config: { rateLimitTier: 'read' } }, async (_request, reply) => {
    const distribution = await store.shardDistribution();
    const total = distribution.reduce((sum, s) => sum + s.count, 0);
    return reply.send({
      driver: store.driverName,
      shardCount: store.shardCount,
      total,
      shards: distribution.map((s) => ({
        ...s,
        share: total === 0 ? 0 : Math.round((s.count / total) * 1000) / 10,
      })),
    });
  });
}
