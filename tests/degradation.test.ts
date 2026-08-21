/**
 * Failure-mode tests.
 *
 * These cover the promises that are easy to state and easy to quietly break:
 * a cache outage must not produce a 5xx (NFR-5), a limiter that loses Redis
 * must degrade rather than fail open, and a replica whose database is down must
 * report itself unready so the balancer drains it.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CacheDriver, RateLimitResult } from '../src/cache/driver.js';
import { AppError } from '../src/core/errors.js';
import { nullLogger } from '../src/logger.js';
import { Metrics } from '../src/middleware/metrics.js';
import { registerRateLimit } from '../src/middleware/rate-limit.js';
import { registerRequestContext } from '../src/middleware/request-context.js';
import { buildHarness, createLink } from './helpers.js';
import type { Harness } from './helpers.js';

/** A cache whose limiter calls always fail, as RedisCache does with its breaker open. */
function deadCache(): CacheDriver {
  return {
    name: 'dead-redis',
    healthy: false,
    async get() {
      return null;
    },
    async set() {
      /* dropped while the breaker is open */
    },
    async del() {
      /* dropped */
    },
    async slidingWindow(): Promise<RateLimitResult> {
      throw AppError.unavailable('redis');
    },
    async tokenBucket(): Promise<RateLimitResult> {
      throw AppError.unavailable('redis');
    },
    async ping() {
      return false;
    },
    async close() {
      /* nothing */
    },
  };
}

async function appWithLimiter(cache: CacheDriver, max: number) {
  const app = Fastify({ logger: false });
  const metrics = new Metrics('test');

  registerRequestContext(app, { logger: nullLogger, metrics, trustedProxies: ['127.0.0.1/32'] });
  registerRateLimit(app, {
    cache,
    metrics,
    logger: nullLogger,
    config: {
      enabled: true,
      write: { max, windowMs: 60_000 },
      read: { max, windowMs: 60_000 },
      redirect: { capacity: max, refillPerSecond: 1 },
    },
  });

  app.get('/probe', { config: { rateLimitTier: 'write' } }, async () => ({ ok: true }));
  app.get('/burst', { config: { rateLimitTier: 'redirect' } }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('rate limiting when the cache is unavailable', () => {
  it('degrades to per-replica counters instead of returning 5xx', async () => {
    const app = await appWithLimiter(deadCache(), 3);
    try {
      const results = [];
      for (let i = 0; i < 8; i++) {
        results.push(await app.inject({ method: 'GET', url: '/probe' }));
      }

      // Still limited — a degraded limit, not no limit, and not an error.
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
      expect(results.filter((r) => r.statusCode === 429)).toHaveLength(5);
      expect(results.filter((r) => r.statusCode >= 500)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('degrades the token-bucket tier too', async () => {
    const app = await appWithLimiter(deadCache(), 2);
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => app.inject({ method: 'GET', url: '/burst' })),
      );
      expect(results.filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(3);
      expect(results.filter((r) => r.statusCode >= 500)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('still emits limit headers while degraded', async () => {
    const app = await appWithLimiter(deadCache(), 5);
    try {
      const res = await app.inject({ method: 'GET', url: '/probe' });
      expect(res.headers['x-ratelimit-limit']).toBe('5');
      expect(res.headers['x-ratelimit-remaining']).toBe('4');
    } finally {
      await app.close();
    }
  });

  // A bug in the limiter must not be silently reinterpreted as a cache outage.
  it('does not swallow a non-dependency error', async () => {
    const broken = { ...deadCache(), slidingWindow: async () => {
      throw new TypeError('programming error');
    } } as CacheDriver;

    const app = await appWithLimiter(broken, 5);
    try {
      const res = await app.inject({ method: 'GET', url: '/probe' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.message).toBe('Internal server error');
    } finally {
      await app.close();
    }
  });
});

describe('readiness when a dependency is down', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  it('reports 503 when the database is unreachable', async () => {
    vi.spyOn(h.container.store, 'ping').mockResolvedValue([
      { shard: 0, healthy: false, error: 'connection refused' },
      { shard: 1, healthy: true },
      { shard: 2, healthy: true },
      { shard: 3, healthy: true },
    ]);

    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);

    const body = res.json();
    expect(body.status).toBe('not_ready');
    expect(body.dependencies.database.status).toBe('down');
    expect(body.dependencies.database.healthyShards).toBe(3);
  });

  it('stays ready when only the cache is down, since it is not a hard dependency', async () => {
    vi.spyOn(h.container.cache, 'ping').mockResolvedValue(false);

    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().dependencies.cache.status).toBe('down');
  });

  it('reports not ready rather than throwing when ping itself rejects', async () => {
    vi.spyOn(h.container.store, 'ping').mockRejectedValue(new Error('pool exhausted'));

    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
  });

  it('keeps liveness green regardless — a restart cannot fix a sick database', async () => {
    vi.spyOn(h.container.store, 'ping').mockRejectedValue(new Error('down'));
    expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('redirect input screening', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('rejects a structurally invalid code without querying anything', async () => {
    const before = await h.app.inject({ method: 'GET', url: '/metrics' });
    const res = await h.app.inject({ method: 'GET', url: '/bad%20code' });

    expect(res.statusCode).toBe(404);
    // The shard-query counter must not have moved.
    const after = await h.app.inject({ method: 'GET', url: '/metrics' });
    expect(countQueries(after.body)).toBe(countQueries(before.body));
  });

  it('refuses to treat a reserved word as a code', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/admin' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/dashboard' })).statusCode).toBe(404);
  });

  it('surfaces an unexpected service failure as a 500 with no internal detail', async () => {
    vi.spyOn(h.container.service, 'resolve').mockRejectedValue(
      new Error('connection string postgres://u:p@host/db failed'),
    );
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/anycode',
        headers: { accept: 'application/json' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('postgres://');
      expect(res.json().error.message).toBe('Internal server error');
      expect(res.json().error.requestId).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('malformed requests', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('rejects a body that is not valid JSON with the standard envelope', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().error.requestId).toBeTruthy();
  });

  it('rejects an over-large body', async () => {
    const res = await createLink(h.app, { url: `https://example.com/${'x'.repeat(100_000)}` });
    expect([413, 422]).toContain(res.statusCode);
  });

  it('rejects a wrongly typed field', async () => {
    const res = await createLink(h.app, { url: 12345 });
    expect(res.statusCode).toBe(422);
  });
});

function countQueries(metricsBody: string): number {
  let total = 0;
  for (const line of metricsBody.split('\n')) {
    if (!line.startsWith('kestrel_shard_queries_total')) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}
