/**
 * The CacheDriver contract.
 *
 * Every implementation runs these same tests. That is what makes the fallback
 * driver trustworthy rather than merely present: if MemoryCache and RedisCache
 * both pass, swapping them cannot change observable behaviour.
 *
 * Redis cases run only when INTEGRATION=1 and a server is reachable; otherwise
 * they skip rather than fail, so `npm test` is green on a bare machine (NFR-7).
 */

import { afterAll, describe, expect, it } from 'vitest';

import type { CacheDriver } from '../src/cache/driver.js';
import { CircuitBreaker } from '../src/cache/circuit-breaker.js';
import { MemoryCache } from '../src/cache/memory.js';
import { RedisCache } from '../src/cache/redis.js';
import { jitterTtl } from '../src/cache/index.js';
import { nullLogger } from '../src/logger.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const RUN_REDIS = process.env.INTEGRATION === '1';

function uniqueKey(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(36).slice(2)}`;
}

/** The shared suite. `make` returns a fresh driver per test. */
function contract(label: string, make: () => CacheDriver, teardown?: (d: CacheDriver) => Promise<void>) {
  describe(`CacheDriver contract: ${label}`, () => {
    const created: CacheDriver[] = [];
    const build = () => {
      const d = make();
      created.push(d);
      return d;
    };

    afterAll(async () => {
      for (const d of created) await teardown?.(d);
    });

    it('returns null for a missing key', async () => {
      const c = build();
      expect(await c.get(uniqueKey('missing'))).toBeNull();
    });

    it('round-trips a value', async () => {
      const c = build();
      const k = uniqueKey('rt');
      await c.set(k, 'hello', 60);
      expect(await c.get(k)).toBe('hello');
    });

    it('overwrites an existing value', async () => {
      const c = build();
      const k = uniqueKey('ow');
      await c.set(k, 'first', 60);
      await c.set(k, 'second', 60);
      expect(await c.get(k)).toBe('second');
    });

    it('deletes keys, including several at once', async () => {
      const c = build();
      const a = uniqueKey('d');
      const b = uniqueKey('d');
      await c.set(a, '1', 60);
      await c.set(b, '2', 60);
      await c.del(a, b);
      expect(await c.get(a)).toBeNull();
      expect(await c.get(b)).toBeNull();
    });

    it('tolerates deleting a key that does not exist', async () => {
      const c = build();
      await expect(c.del(uniqueKey('nope'))).resolves.toBeUndefined();
    });

    it('ignores a non-positive TTL', async () => {
      const c = build();
      const k = uniqueKey('ttl0');
      await c.set(k, 'x', 0);
      expect(await c.get(k)).toBeNull();
    });

    it('stores values containing JSON and unicode intact', async () => {
      const c = build();
      const k = uniqueKey('json');
      const payload = JSON.stringify({ url: 'https://example.com/ünïcode?a=1&b=2', n: 42 });
      await c.set(k, payload, 60);
      expect(await c.get(k)).toBe(payload);
    });

    describe('slidingWindow', () => {
      it('allows up to the limit then rejects', async () => {
        const c = build();
        const k = uniqueKey('sw');
        const results = [];
        for (let i = 0; i < 5; i++) results.push(await c.slidingWindow(k, 3, 60_000));

        expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
        expect(results[0]!.remaining).toBe(2);
        expect(results[2]!.remaining).toBe(0);
        expect(results[3]!.remaining).toBe(0);
        expect(results[3]!.limit).toBe(3);
      });

      it('reports a reset time and a retry delay when rejecting', async () => {
        const c = build();
        const k = uniqueKey('sw-reset');
        await c.slidingWindow(k, 1, 60_000);
        const denied = await c.slidingWindow(k, 1, 60_000);

        expect(denied.allowed).toBe(false);
        expect(denied.retryAfterMs).toBeGreaterThan(0);
        expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
        expect(denied.resetAt).toBeGreaterThan(Date.now());
      });

      it('keeps separate budgets per key', async () => {
        const c = build();
        const a = uniqueKey('sw-a');
        const b = uniqueKey('sw-b');
        await c.slidingWindow(a, 1, 60_000);
        expect((await c.slidingWindow(a, 1, 60_000)).allowed).toBe(false);
        expect((await c.slidingWindow(b, 1, 60_000)).allowed).toBe(true);
      });

      it('frees capacity once the window elapses', async () => {
        const c = build();
        const k = uniqueKey('sw-elapse');
        expect((await c.slidingWindow(k, 2, 60)).allowed).toBe(true);
        expect((await c.slidingWindow(k, 2, 60)).allowed).toBe(true);
        expect((await c.slidingWindow(k, 2, 60)).allowed).toBe(false);

        await new Promise((r) => setTimeout(r, 90));
        expect((await c.slidingWindow(k, 2, 60)).allowed).toBe(true);
      });

      // The cross-replica guarantee: concurrent callers must not both squeeze in.
      it('admits exactly `limit` requests under concurrency', async () => {
        const c = build();
        const k = uniqueKey('sw-race');
        const outcomes = await Promise.all(
          Array.from({ length: 50 }, () => c.slidingWindow(k, 10, 60_000)),
        );
        expect(outcomes.filter((r) => r.allowed).length).toBe(10);
      });
    });

    describe('tokenBucket', () => {
      it('allows a full burst then rejects', async () => {
        const c = build();
        const k = uniqueKey('tb');
        const results = [];
        for (let i = 0; i < 4; i++) results.push(await c.tokenBucket(k, 3, 1));

        expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
        expect(results[3]!.retryAfterMs).toBeGreaterThan(0);
        expect(results[3]!.limit).toBe(3);
      });

      it('refills over time', async () => {
        const c = build();
        const k = uniqueKey('tb-refill');
        // Capacity 1, 50/s => a token returns in ~20 ms.
        expect((await c.tokenBucket(k, 1, 50)).allowed).toBe(true);
        expect((await c.tokenBucket(k, 1, 50)).allowed).toBe(false);

        await new Promise((r) => setTimeout(r, 80));
        expect((await c.tokenBucket(k, 1, 50)).allowed).toBe(true);
      });

      it('never exceeds capacity however long it idles', async () => {
        const c = build();
        const k = uniqueKey('tb-cap');
        const first = await c.tokenBucket(k, 5, 1000);
        expect(first.remaining).toBeLessThanOrEqual(5);

        await new Promise((r) => setTimeout(r, 50));
        const second = await c.tokenBucket(k, 5, 1000);
        expect(second.remaining).toBeLessThanOrEqual(5);
      });

      it('honours a cost greater than one', async () => {
        const c = build();
        const k = uniqueKey('tb-cost');
        expect((await c.tokenBucket(k, 10, 1, 6)).allowed).toBe(true);
        expect((await c.tokenBucket(k, 10, 1, 6)).allowed).toBe(false);
      });

      it('admits at most `capacity` requests under concurrency', async () => {
        const c = build();
        const k = uniqueKey('tb-race');
        const outcomes = await Promise.all(Array.from({ length: 40 }, () => c.tokenBucket(k, 8, 1)));
        const allowed = outcomes.filter((r) => r.allowed).length;
        expect(allowed).toBeGreaterThanOrEqual(8);
        expect(allowed).toBeLessThanOrEqual(9); // +1 tolerance for refill during the run
      });
    });

    it('responds to ping', async () => {
      const c = build();
      expect(await c.ping()).toBe(true);
    });
  });
}

contract('MemoryCache', () => new MemoryCache(), async (d) => d.close());

if (RUN_REDIS) {
  let reachable = false;
  const probe = new RedisCache({ url: REDIS_URL, keyPrefix: 'kestrel:test:', logger: nullLogger });
  try {
    await probe.connect();
    reachable = await probe.ping();
  } catch {
    reachable = false;
  }
  await probe.close();

  if (reachable) {
    contract(
      'RedisCache',
      () => new RedisCache({ url: REDIS_URL, keyPrefix: `kestrel:test:${Date.now()}:`, logger: nullLogger }),
      async (d) => d.close(),
    );
  } else {
    describe.skip('CacheDriver contract: RedisCache (unreachable)', () => {
      it('skipped', () => undefined);
    });
  }
} else {
  describe.skip('CacheDriver contract: RedisCache (set INTEGRATION=1 to run)', () => {
    it('skipped', () => undefined);
  });
}

describe('MemoryCache specifics', () => {
  it('expires values on an injected clock without sleeping', async () => {
    let now = 1_000_000;
    const c = new MemoryCache({ now: () => now });
    await c.set('k', 'v', 10);
    now += 9_999;
    expect(await c.get('k')).toBe('v');
    now += 2;
    expect(await c.get('k')).toBeNull();
  });

  it('evicts the oldest key when the safety cap is reached', async () => {
    const c = new MemoryCache({ maxKeys: 2 });
    await c.set('a', '1', 60);
    await c.set('b', '2', 60);
    await c.set('c', '3', 60);
    expect(await c.get('a')).toBeNull();
    expect(await c.get('c')).toBe('3');
  });
});

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and rejects immediately', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => now });

    expect(b.canAttempt()).toBe(true);
    b.recordFailure();
    b.recordFailure();
    expect(b.current).toBe('closed');
    b.recordFailure();
    expect(b.current).toBe('open');
    expect(b.canAttempt()).toBe(false);
  });

  it('half-opens after the cooldown and closes on a successful probe', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
    b.recordFailure();
    expect(b.current).toBe('open');

    now = 1000;
    expect(b.canAttempt()).toBe(true);
    expect(b.current).toBe('half-open');
    b.recordSuccess();
    expect(b.current).toBe('closed');
    expect(b.isClosed).toBe(true);
  });

  it('re-opens when the probe fails', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
    b.recordFailure();
    now = 1000;
    b.canAttempt();
    b.recordFailure();
    expect(b.current).toBe('open');
    expect(b.canAttempt()).toBe(false);
  });

  it('allows only one probe at a time while half-open', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => now });
    b.recordFailure();
    now = 100;
    expect(b.canAttempt()).toBe(true);
    expect(b.canAttempt()).toBe(false);
  });

  it('resets the failure count on success', () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    expect(b.failures).toBe(0);
    b.recordFailure();
    b.recordFailure();
    expect(b.current).toBe('closed');
  });

  it('reports state transitions', () => {
    const seen: string[] = [];
    let now = 0;
    const b = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      now: () => now,
      onStateChange: (from, to) => seen.push(`${from}->${to}`),
    });
    b.recordFailure();
    now = 10;
    b.canAttempt();
    b.recordSuccess();
    expect(seen).toEqual(['closed->open', 'open->half-open', 'half-open->closed']);
  });
});

describe('jitterTtl', () => {
  it('stays within +/-10% of the base', () => {
    for (let i = 0; i < 500; i++) {
      const t = jitterTtl(1000);
      expect(t).toBeGreaterThanOrEqual(900);
      expect(t).toBeLessThanOrEqual(1100);
    }
  });

  it('never returns a non-positive TTL', () => {
    expect(jitterTtl(1)).toBeGreaterThanOrEqual(1);
  });

  it('actually varies, so a write cohort desynchronises', () => {
    const values = new Set(Array.from({ length: 100 }, () => jitterTtl(3600)));
    expect(values.size).toBeGreaterThan(10);
  });
});
