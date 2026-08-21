/**
 * The cache-strategy tests.
 *
 * These assert the system-design claims directly rather than by proxy: the
 * database is wrapped in a counting driver, so "the cache hit did not touch the
 * database" is a measured fact, not an inference from a header.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryCache } from '../src/cache/memory.js';
import type { CacheDriver, RateLimitResult } from '../src/cache/driver.js';
import { AppError } from '../src/core/errors.js';
import { IdGenerator } from '../src/core/idgen.js';
import { LruCache } from '../src/core/lru.js';
import { MemoryDriver } from '../src/db/memory.js';
import type { DatabaseDriver } from '../src/db/driver.js';
import { ShardedStore } from '../src/db/store.js';
import { nullLogger } from '../src/logger.js';
import { Metrics } from '../src/middleware/metrics.js';
import { LinkService } from '../src/services/link-service.js';
import type { ClickDelta, LinkRecord, ListOptions, NewLink, ShardHealth } from '../src/types.js';

/** Wraps a driver and counts calls, so cache effectiveness can be asserted. */
class CountingDriver implements DatabaseDriver {
  readonly name = 'counting';
  readonly counts = { insert: 0, findByCode: 0, delete: 0, list: 0, clicks: 0 };
  /** Set to make every read fail, simulating a database outage. */
  failReads = false;

  constructor(private readonly inner: DatabaseDriver) {}

  get shardCount(): number {
    return this.inner.shardCount;
  }

  async init(): Promise<void> {
    await this.inner.init();
  }

  async insert(shard: number, link: NewLink): Promise<LinkRecord> {
    this.counts.insert++;
    return this.inner.insert(shard, link);
  }

  async findByCode(shard: number, code: string): Promise<LinkRecord | null> {
    this.counts.findByCode++;
    if (this.failReads) throw AppError.unavailable('database');
    return this.inner.findByCode(shard, code);
  }

  async deleteByCode(shard: number, code: string): Promise<boolean> {
    this.counts.delete++;
    return this.inner.deleteByCode(shard, code);
  }

  async listShard(shard: number, options: ListOptions): Promise<LinkRecord[]> {
    this.counts.list++;
    return this.inner.listShard(shard, options);
  }

  async incrementClicks(shard: number, deltas: ClickDelta[]): Promise<void> {
    this.counts.clicks++;
    return this.inner.incrementClicks(shard, deltas);
  }

  async countShard(shard: number): Promise<number> {
    return this.inner.countShard(shard);
  }

  async ping(): Promise<ShardHealth[]> {
    return this.inner.ping();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

interface Fixture {
  service: LinkService;
  driver: CountingDriver;
  cache: MemoryCache;
  l1: LruCache<string>;
  clock: { now: number };
}

function makeService(overrides: { l1TtlMs?: number; negativeTtlSeconds?: number } = {}): Fixture {
  const clock = { now: 1_800_000_000_000 };
  const now = () => clock.now;

  const driver = new CountingDriver(new MemoryDriver(4));
  const store = new ShardedStore(driver);
  const cache = new MemoryCache({ now });
  const l1 = new LruCache<string>({ maxEntries: 100, ttlMs: overrides.l1TtlMs ?? 30_000, now });

  const service = new LinkService({
    store,
    cache,
    l1,
    idgen: new IdGenerator({ nodeId: 1, now }),
    metrics: new Metrics('test'),
    logger: nullLogger,
    ttlSeconds: 3600,
    negativeTtlSeconds: overrides.negativeTtlSeconds ?? 60,
    l1TtlMs: overrides.l1TtlMs ?? 30_000,
    allowPrivateHosts: false,
    now,
  });

  return { service, driver, cache, l1, clock };
}

describe('LinkService — cache-aside', () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeService();
  });

  it('writes through on create, so the first read never reaches the database', async () => {
    const link = await f.service.create({ url: 'https://example.com/a' });
    const before = f.driver.counts.findByCode;

    const result = await f.service.resolve(link.code);

    expect(result.tier).toBe('l1');
    expect(result.link.url).toBe('https://example.com/a');
    expect(f.driver.counts.findByCode).toBe(before);
  });

  it('serves from L2 and promotes into L1 when L1 has expired', async () => {
    const link = await f.service.create({ url: 'https://example.com/b' });

    // Advance past the L1 TTL but well inside the L2 TTL.
    f.clock.now += 31_000;
    const before = f.driver.counts.findByCode;

    const first = await f.service.resolve(link.code);
    expect(first.tier).toBe('l2');
    expect(f.driver.counts.findByCode).toBe(before);

    // The L2 hit should have back-filled L1.
    const second = await f.service.resolve(link.code);
    expect(second.tier).toBe('l1');
  });

  it('falls through to the shard when both cache tiers are cold', async () => {
    const link = await f.service.create({ url: 'https://example.com/c' });

    // Evict both tiers without deleting the row.
    f.l1.clear();
    await f.cache.del(`link:${link.code}`);

    const before = f.driver.counts.findByCode;
    const result = await f.service.resolve(link.code);

    expect(result.tier).toBe('l3');
    expect(f.driver.counts.findByCode).toBe(before + 1);

    // And the L3 read repopulates, so the next one is free.
    expect((await f.service.resolve(link.code)).tier).toBe('l1');
  });

  it('serves a hot key from cache no matter how many times it is read', async () => {
    const link = await f.service.create({ url: 'https://example.com/hot' });
    const before = f.driver.counts.findByCode;

    for (let i = 0; i < 1000; i++) await f.service.resolve(link.code);

    expect(f.driver.counts.findByCode).toBe(before);
  });
});

describe('LinkService — cache penetration', () => {
  it('caches a miss so repeated probes for one bad code hit the database once', async () => {
    const f = makeService();

    await expect(f.service.resolve('nosuch')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const afterFirst = f.driver.counts.findByCode;
    expect(afterFirst).toBe(1);

    for (let i = 0; i < 100; i++) {
      await expect(f.service.resolve('nosuch')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    // Every subsequent probe was answered by the negative cache.
    expect(f.driver.counts.findByCode).toBe(afterFirst);
  });

  it('lets the negative entry expire so a later create becomes visible', async () => {
    const f = makeService({ negativeTtlSeconds: 60 });

    await expect(f.service.resolve('later')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    f.clock.now += 61_000;
    await f.service.create({ url: 'https://example.com/later', alias: 'later' });

    const result = await f.service.resolve('later');
    expect(result.link.url).toBe('https://example.com/later');
  });

  it('drops the negative entry immediately when the code is claimed', async () => {
    const f = makeService();

    await expect(f.service.resolve('claimed')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await f.service.create({ url: 'https://example.com/claimed', alias: 'claimed' });

    // Create writes through, so the stale negative entry must not win.
    const result = await f.service.resolve('claimed');
    expect(result.link.url).toBe('https://example.com/claimed');
  });
});

describe('LinkService — cache stampede', () => {
  it('collapses 200 concurrent misses into a single database query', async () => {
    const f = makeService();
    const link = await f.service.create({ url: 'https://example.com/stampede' });

    f.l1.clear();
    await f.cache.del(`link:${link.code}`);
    const before = f.driver.counts.findByCode;

    const results = await Promise.all(
      Array.from({ length: 200 }, () => f.service.resolve(link.code)),
    );

    expect(results).toHaveLength(200);
    expect(results.every((r) => r.link.url === 'https://example.com/stampede')).toBe(true);
    expect(f.driver.counts.findByCode).toBe(before + 1);
  });

  it('collapses concurrent misses on a code that does not exist too', async () => {
    const f = makeService();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, () => f.service.resolve('ghost')),
    );

    expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
    expect(f.driver.counts.findByCode).toBe(1);
  });

  it('does not let one failed query poison later attempts', async () => {
    const f = makeService();
    await f.service.create({ url: 'https://example.com/flaky', alias: 'flaky' });
    f.l1.clear();
    await f.cache.del('link:flaky');

    f.driver.failReads = true;
    await expect(f.service.resolve('flaky')).rejects.toBeInstanceOf(AppError);

    f.driver.failReads = false;
    const result = await f.service.resolve('flaky');
    expect(result.link.url).toBe('https://example.com/flaky');
  });
});

describe('LinkService — expiry', () => {
  it('returns GONE once past the expiry, from cache as well as from storage', async () => {
    const f = makeService();
    const link = await f.service.create({ url: 'https://example.com/exp', expiresIn: 60 });

    expect((await f.service.resolve(link.code)).link.code).toBe(link.code);

    f.clock.now += 61_000;
    await expect(f.service.resolve(link.code)).rejects.toMatchObject({ code: 'GONE' });

    // Also GONE on a cold cache, i.e. the policy is applied at use, not at write.
    f.l1.clear();
    await f.cache.del(`link:${link.code}`);
    await expect(f.service.resolve(link.code)).rejects.toMatchObject({ code: 'GONE' });
  });

  it('never caches a record for longer than it stays valid', async () => {
    const f = makeService();
    const link = await f.service.create({ url: 'https://example.com/shortlived', expiresIn: 10 });

    // Base TTL is 3600s but the record dies in 10s, so L2 must expire with it.
    f.clock.now += 11_000;
    expect(await f.cache.get(`link:${link.code}`)).toBeNull();
  });

  it('rejects an implausible expiry', async () => {
    const f = makeService();
    await expect(f.service.create({ url: 'https://example.com', expiresIn: 0 })).rejects.toThrow();
    await expect(
      f.service.create({ url: 'https://example.com', expiresIn: 1e12 }),
    ).rejects.toThrow(/may not exceed/);
  });
});

describe('LinkService — invalidation', () => {
  it('evicts every local tier on delete', async () => {
    const f = makeService();
    const link = await f.service.create({ url: 'https://example.com/gone' });
    await f.service.resolve(link.code); // warm every tier

    await f.service.remove(link.code);

    expect(await f.cache.get(`link:${link.code}`)).toBeNull();
    await expect(f.service.resolve(link.code)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports NOT_FOUND when deleting something that is not there', async () => {
    const f = makeService();
    await expect(f.service.remove('absent')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('treats a corrupt cache entry as a miss rather than a 500', async () => {
    const f = makeService();
    const link = await f.service.create({ url: 'https://example.com/corrupt' });

    f.l1.set(`link:${link.code}`, '{not valid json');

    await expect(f.service.resolve(link.code)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The bad entry is dropped, so the next read recovers from L2.
    expect((await f.service.resolve(link.code)).link.url).toBe('https://example.com/corrupt');
  });
});

describe('LinkService — degradation when the cache is unavailable', () => {
  /** A cache that fails every operation the way a dead Redis behind a breaker does. */
  const deadCache: CacheDriver = {
    name: 'dead',
    healthy: false,
    async get() {
      return null;
    },
    async set() {
      /* silently dropped, as RedisCache does while its breaker is open */
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

  it('still resolves correctly, just from the database each time (NFR-5)', async () => {
    const driver = new CountingDriver(new MemoryDriver(4));
    const store = new ShardedStore(driver);
    const l1 = new LruCache<string>({ maxEntries: 0, ttlMs: 0 }); // L1 disabled too

    const service = new LinkService({
      store,
      cache: deadCache,
      l1,
      idgen: new IdGenerator({ nodeId: 2 }),
      metrics: new Metrics('test'),
      logger: nullLogger,
      ttlSeconds: 3600,
      negativeTtlSeconds: 60,
      l1TtlMs: 0,
      allowPrivateHosts: false,
    });

    const link = await service.create({ url: 'https://example.com/degraded' });

    for (let i = 0; i < 5; i++) {
      const result = await service.resolve(link.code);
      expect(result.tier).toBe('l3');
      expect(result.link.url).toBe('https://example.com/degraded');
    }

    // Correct answers, at the cost of a query per read — the documented trade.
    expect(driver.counts.findByCode).toBe(5);
  });
});

describe('LinkService — creation rules', () => {
  it('derives the code from the ID, so distinct creates never collide', async () => {
    const f = makeService();
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) {
      codes.add((await f.service.create({ url: `https://example.com/${i}` })).code);
    }
    expect(codes.size).toBe(500);
  });

  it('normalises the stored URL', async () => {
    const f = makeService();
    const link = await f.service.create({ url: '  HTTPS://Example.COM/Path?b=2  ' });
    expect(link.url).toBe('https://example.com/Path?b=2');
  });

  it('rejects unsafe targets', async () => {
    const f = makeService();
    await expect(f.service.create({ url: 'http://127.0.0.1:8080/admin' })).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    });
  });

  it('rejects a reserved alias before writing anything', async () => {
    const f = makeService();
    await expect(
      f.service.create({ url: 'https://example.com', alias: 'health' }),
    ).rejects.toMatchObject({ code: 'RESERVED_ALIAS' });
    expect(f.driver.counts.insert).toBe(0);
  });
});
