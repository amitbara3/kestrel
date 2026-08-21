/**
 * The DatabaseDriver contract, plus the sharding layer on top of it.
 *
 * As with the cache, both implementations run the same tests. Postgres cases
 * run only when INTEGRATION=1 and a server is reachable.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../src/core/errors.js';
import type { DatabaseDriver } from '../src/db/driver.js';
import { MemoryDriver } from '../src/db/memory.js';
import { PostgresDriver } from '../src/db/postgres.js';
import { ShardRouter } from '../src/db/shard-router.js';
import { ShardedStore } from '../src/db/store.js';
import { nullLogger } from '../src/logger.js';
import type { LinkRecord, NewLink } from '../src/types.js';
import { decodeCursor, encodeCursor, isExpired } from '../src/types.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://kestrel:kestrel@127.0.0.1:5432/kestrel';
const RUN_PG = process.env.INTEGRATION === '1';
const SHARDS = 4;

let seq = 0;
function link(overrides: Partial<NewLink> = {}): NewLink {
  seq++;
  return {
    id: String(1_000_000_000_000 + seq),
    code: `code${seq}_${process.pid}`,
    url: `https://example.com/${seq}`,
    createdAt: 1_700_000_000_000 + seq,
    expiresAt: null,
    ...overrides,
  };
}

function contract(label: string, make: () => DatabaseDriver, cleanup?: (d: DatabaseDriver) => Promise<void>) {
  describe(`DatabaseDriver contract: ${label}`, () => {
    let driver: DatabaseDriver;
    let store: ShardedStore;

    beforeEach(async () => {
      driver = make();
      await driver.init();
      store = new ShardedStore(driver);
    });

    afterAll(async () => {
      await cleanup?.(driver);
    });

    it('inserts and reads back through the router', async () => {
      const l = link();
      const created = await store.insert(l);
      expect(created.code).toBe(l.code);
      expect(created.clicks).toBe(0);
      expect(created.lastAccessedAt).toBeNull();

      const found = await store.findByCode(l.code);
      expect(found?.url).toBe(l.url);
      expect(found?.id).toBe(l.id);
    });

    it('returns null for an unknown code', async () => {
      expect(await store.findByCode(`absent_${process.pid}_${seq++}`)).toBeNull();
    });

    // The alias race: the unique index, not application logic, decides the winner.
    it('rejects a duplicate code with ALIAS_TAKEN', async () => {
      const l = link();
      await store.insert(l);
      await expect(store.insert({ ...l, id: String(Number(l.id) + 1) })).rejects.toMatchObject({
        code: 'ALIAS_TAKEN',
      });
    });

    it('resolves a concurrent race on the same code to exactly one winner', async () => {
      const l = link();
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => store.insert({ ...l, id: String(Number(l.id) + i) })),
      );
      expect(attempts.filter((a) => a.status === 'fulfilled').length).toBe(1);
      for (const a of attempts.filter((x) => x.status === 'rejected')) {
        expect((a as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      }
    });

    it('deletes and reports whether anything was removed', async () => {
      const l = link();
      await store.insert(l);
      expect(await store.deleteByCode(l.code)).toBe(true);
      expect(await store.findByCode(l.code)).toBeNull();
      expect(await store.deleteByCode(l.code)).toBe(false);
    });

    it('preserves expiry as stored, without applying it', async () => {
      const expiresAt = Date.now() - 1000;
      const l = link({ expiresAt });
      await store.insert(l);
      const found = await store.findByCode(l.code);
      expect(found?.expiresAt).toBe(expiresAt);
      // Expiry is a service-layer policy decision, not a storage one.
      expect(isExpired(found!)).toBe(true);
    });

    it('applies batched clicks across shards', async () => {
      const a = link();
      const b = link();
      await store.insert(a);
      await store.insert(b);

      const at = Date.now();
      await store.applyClicks([
        { code: a.code, count: 3, lastAccessedAt: at },
        { code: b.code, count: 7, lastAccessedAt: at },
      ]);

      expect((await store.findByCode(a.code))?.clicks).toBe(3);
      expect((await store.findByCode(b.code))?.clicks).toBe(7);
      expect((await store.findByCode(a.code))?.lastAccessedAt).toBe(at);

      await store.applyClicks([{ code: a.code, count: 2, lastAccessedAt: at + 5 }]);
      expect((await store.findByCode(a.code))?.clicks).toBe(5);
    });

    it('ignores clicks for a code deleted between the click and the flush', async () => {
      const l = link();
      await store.insert(l);
      await store.deleteByCode(l.code);
      await expect(
        store.applyClicks([{ code: l.code, count: 1, lastAccessedAt: Date.now() }]),
      ).resolves.toBeUndefined();
    });

    it('is a no-op for an empty click batch', async () => {
      await expect(store.applyClicks([])).resolves.toBeUndefined();
    });

    it('lists newest first across every shard', async () => {
      const created: LinkRecord[] = [];
      for (let i = 0; i < 12; i++) created.push(await store.insert(link()));

      const page = await store.list({ limit: 20 });
      const ours = page.items.filter((r) => created.some((c) => c.code === r.code));
      expect(ours.length).toBe(12);
      for (let i = 1; i < ours.length; i++) {
        expect(ours[i - 1]!.createdAt).toBeGreaterThanOrEqual(ours[i]!.createdAt);
      }
    });

    it('paginates by cursor without repeating or dropping a row', async () => {
      const inserted: LinkRecord[] = [];
      for (let i = 0; i < 10; i++) inserted.push(await store.insert(link()));
      const codes = new Set(inserted.map((r) => r.code));

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await store.list({ limit: 3, cursor });
        seen.push(...result.items.map((r) => r.code));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }

      const ourSeen = seen.filter((c) => codes.has(c));
      expect(new Set(ourSeen).size).toBe(ourSeen.length); // no duplicates
      expect(new Set(ourSeen).size).toBe(10); // nothing dropped
    });

    it('reports per-shard row counts', async () => {
      for (let i = 0; i < 40; i++) await store.insert(link());
      const dist = await store.shardDistribution();
      expect(dist.length).toBe(SHARDS);
      expect(dist.reduce((sum, s) => sum + s.count, 0)).toBeGreaterThanOrEqual(40);
      // Hash routing should use every shard, not pile everything on one.
      expect(dist.every((s) => s.count > 0)).toBe(true);
    });

    it('reports health per shard', async () => {
      const health = await store.ping();
      expect(health.length).toBe(SHARDS);
      expect(health.every((h) => h.healthy)).toBe(true);
    });

    it('routes a code to the same shard every time', async () => {
      const code = 'stable-code';
      const first = store.shardFor(code);
      for (let i = 0; i < 100; i++) expect(store.shardFor(code)).toBe(first);
    });
  });
}

contract('MemoryDriver', () => new MemoryDriver(SHARDS));

if (RUN_PG) {
  let reachable = false;
  const probe = new PostgresDriver({
    urls: [DATABASE_URL],
    shardCount: SHARDS,
    poolMax: 2,
    logger: nullLogger,
  });
  try {
    await probe.init();
    reachable = (await probe.ping()).every((h) => h.healthy);
  } catch {
    reachable = false;
  }
  await probe.close();

  if (reachable) {
    contract(
      'PostgresDriver',
      () =>
        new PostgresDriver({
          urls: [DATABASE_URL],
          shardCount: SHARDS,
          poolMax: 4,
          logger: nullLogger,
        }),
      async (d) => d.close(),
    );
  } else {
    describe.skip('DatabaseDriver contract: PostgresDriver (unreachable)', () => {
      it('skipped', () => undefined);
    });
  }
} else {
  describe.skip('DatabaseDriver contract: PostgresDriver (set INTEGRATION=1 to run)', () => {
    it('skipped', () => undefined);
  });
}

describe('ShardRouter', () => {
  it('is deterministic and in range', () => {
    const r = new ShardRouter(8);
    for (let i = 0; i < 1000; i++) {
      const code = `c${i}`;
      const shard = r.shardFor(code);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(8);
      expect(r.shardFor(code)).toBe(shard);
    }
  });

  it('collapses to shard 0 for a single shard', () => {
    const r = new ShardRouter(1);
    expect(r.shardFor('anything')).toBe(0);
    expect(r.allShards()).toEqual([0]);
  });

  it('rejects an invalid shard count', () => {
    expect(() => new ShardRouter(0)).toThrow(RangeError);
    expect(() => new ShardRouter(2.5)).toThrow(RangeError);
  });

  it('maps logical shards onto fewer physical servers', () => {
    const r = new ShardRouter(8);
    expect(r.serverFor(0, 2)).toBe(0);
    expect(r.serverFor(1, 2)).toBe(1);
    expect(r.serverFor(7, 2)).toBe(1);
    expect(r.serverFor(7, 1)).toBe(0);
    expect(() => r.serverFor(0, 0)).toThrow(RangeError);
  });

  it('refuses a router whose shard count disagrees with the driver', () => {
    expect(() => new ShardedStore(new MemoryDriver(4), new ShardRouter(8))).toThrow(RangeError);
  });
});

describe('cursor encoding', () => {
  it('round-trips', () => {
    const record = {
      id: '123456789',
      code: 'abc',
      url: 'https://example.com',
      createdAt: 1_700_000_000_000,
      expiresAt: null,
      clicks: 0,
      lastAccessedAt: null,
    };
    const decoded = decodeCursor(encodeCursor(record));
    expect(decoded).toEqual({ createdAt: 1_700_000_000_000, id: '123456789' });
  });

  it('returns null on malformed input rather than throwing', () => {
    expect(decodeCursor('not-base64!!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(Buffer.from('nocolon').toString('base64url'))).toBeNull();
  });
});

describe('isExpired', () => {
  const base = {
    id: '1',
    code: 'a',
    url: 'https://example.com',
    createdAt: 0,
    clicks: 0,
    lastAccessedAt: null,
  };

  it('treats a null expiry as permanent', () => {
    expect(isExpired({ ...base, expiresAt: null }, 1e15)).toBe(false);
  });

  it('expires at the boundary, not after it', () => {
    expect(isExpired({ ...base, expiresAt: 1000 }, 999)).toBe(false);
    expect(isExpired({ ...base, expiresAt: 1000 }, 1000)).toBe(true);
  });
});
