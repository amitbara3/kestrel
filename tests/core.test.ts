import { describe, expect, it } from 'vitest';

import { validateAlias, isReservedAlias, isPlausibleCode } from '../src/core/alias.js';
import { decodeBase62, encodeBase62, isValidBase62, BASE62_ALPHABET } from '../src/core/base62.js';
import { AppError, toEnvelope, statusOf } from '../src/core/errors.js';
import { bucketOf, fnv1a32 } from '../src/core/hash.js';
import { ClockRewindError, IdGenerator, nodeIdOf, sequenceOf, timestampOf } from '../src/core/idgen.js';
import { LruCache } from '../src/core/lru.js';
import { SingleFlight } from '../src/core/singleflight.js';
import { isBlockedHost, normaliseTargetUrl } from '../src/core/url-safety.js';

describe('base62', () => {
  it('encodes known values', () => {
    expect(encodeBase62(0)).toBe('0');
    expect(encodeBase62(1)).toBe('1');
    expect(encodeBase62(10)).toBe('A');
    expect(encodeBase62(61)).toBe('z');
    expect(encodeBase62(62)).toBe('10');
    expect(encodeBase62(3843)).toBe('zz');
  });

  it('round-trips across the full alphabet', () => {
    for (let i = 0; i < BASE62_ALPHABET.length; i++) {
      expect(decodeBase62(encodeBase62(i))).toBe(BigInt(i));
    }
  });

  // Property test: encode/decode must be a bijection, which is what removes the
  // need for a collision check on create.
  it('round-trips 100k pseudo-random values without collision', () => {
    const seen = new Set<string>();
    let state = 0x2545f491n; // fixed seed: deterministic, no Math.random in tests
    for (let i = 0; i < 100_000; i++) {
      state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      const value = state >> 4n;
      const code = encodeBase62(value);
      expect(decodeBase62(code)).toBe(value);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
    expect(seen.size).toBe(100_000);
  });

  it('handles values far beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 9_223_372_036_854_775_806n;
    expect(decodeBase62(encodeBase62(big))).toBe(big);
  });

  it('rejects invalid input', () => {
    expect(() => encodeBase62(-1)).toThrow(RangeError);
    expect(() => encodeBase62(1.5)).toThrow(RangeError);
    expect(() => decodeBase62('')).toThrow(RangeError);
    expect(() => decodeBase62('abc!')).toThrow(RangeError);
    expect(isValidBase62('aB3')).toBe(true);
    expect(isValidBase62('a-b')).toBe(false);
  });
});

describe('fnv1a32 / bucketOf', () => {
  it('is deterministic', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
    expect(fnv1a32('hello')).not.toBe(fnv1a32('hellp'));
  });

  it('matches the FNV-1a reference vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('always returns an unsigned 32-bit value', () => {
    for (const s of ['', 'a', 'zzzzzzzzzz', 'ÿþ', 'aB3xK9']) {
      const h = fnv1a32(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  // The distribution requirement from Phases.md Phase 2.
  it('distributes 10k codes across 4 buckets within +/-5% of even', () => {
    const buckets = [0, 0, 0, 0];
    for (let i = 0; i < 10_000; i++) {
      buckets[bucketOf(encodeBase62(i * 2_654_435_761), 4)]!++;
    }
    const expected = 2_500;
    for (const count of buckets) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
    }
  });

  it('rejects a non-positive bucket count', () => {
    expect(() => bucketOf('x', 0)).toThrow(RangeError);
    expect(bucketOf('x', 1)).toBe(0);
  });
});

describe('IdGenerator', () => {
  it('produces unique, monotonically increasing IDs', () => {
    const gen = new IdGenerator({ nodeId: 7 });
    const ids: bigint[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(gen.next());

    expect(new Set(ids.map(String)).size).toBe(10_000);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it('encodes node ID and sequence into the value', () => {
    const gen = new IdGenerator({ nodeId: 511 });
    const id = gen.next();
    expect(nodeIdOf(id)).toBe(511);
    expect(sequenceOf(id)).toBe(0);
  });

  it('recovers the mint timestamp', () => {
    const fixed = 1_800_000_000_000;
    const gen = new IdGenerator({ nodeId: 1, now: () => fixed });
    expect(timestampOf(gen.next())).toBe(fixed);
  });

  // Exercises sequence rollover: a burst larger than one millisecond's 4096 slots.
  it('rolls the sequence into the next millisecond instead of colliding', () => {
    let frozen = 1_800_000_000_000;
    const gen = new IdGenerator({ nodeId: 3, now: () => frozen });

    const ids = new Set<string>();
    for (let i = 0; i < 4096; i++) ids.add(String(gen.next()));
    expect(ids.size).toBe(4096); // exactly one millisecond's capacity, no duplicates

    // The 4097th spins for the next tick; advance the clock so it can resolve.
    frozen += 1;
    const next = gen.next();
    expect(ids.has(String(next))).toBe(false);
    expect(sequenceOf(next)).toBe(0);
  });

  it('refuses to generate during a clock rewind', () => {
    let clock = 1_800_000_000_000;
    const gen = new IdGenerator({ nodeId: 1, now: () => clock });
    gen.next();
    clock -= 5_000;
    expect(() => gen.next()).toThrow(ClockRewindError);
  });

  it('rejects an out-of-range node ID', () => {
    expect(() => new IdGenerator({ nodeId: -1 })).toThrow(RangeError);
    expect(() => new IdGenerator({ nodeId: 1024 })).toThrow(RangeError);
    expect(() => new IdGenerator({ nodeId: 1023 })).not.toThrow();
  });
});

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const c = new LruCache<string>({ maxEntries: 3, ttlMs: 1000 });
    c.set('a', 'alpha');
    expect(c.get('a')).toBe('alpha');
    expect(c.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const c = new LruCache<number>({ maxEntries: 3, ttlMs: 10_000 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.get('a'); // 'a' is now the most recent, so 'b' is the eviction candidate
    c.set('d', 4);

    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
    expect(c.size).toBe(3);
  });

  it('expires entries by TTL using an injected clock', () => {
    let now = 1000;
    const c = new LruCache<string>({ maxEntries: 10, ttlMs: 100, now: () => now });
    c.set('k', 'v');
    now = 1099;
    expect(c.get('k')).toBe('v');
    now = 1100;
    expect(c.get('k')).toBeUndefined();
  });

  it('prunes expired entries', () => {
    let now = 0;
    const c = new LruCache<number>({ maxEntries: 10, ttlMs: 50, now: () => now });
    c.set('a', 1);
    c.set('b', 2);
    now = 100;
    expect(c.prune()).toBe(2);
    expect(c.size).toBe(0);
  });

  it('is a no-op when disabled by a zero cap', () => {
    const c = new LruCache<number>({ maxEntries: 0, ttlMs: 1000 });
    c.set('a', 1);
    expect(c.get('a')).toBeUndefined();
  });

  it('reports hit ratio', () => {
    const c = new LruCache<number>({ maxEntries: 10, ttlMs: 1000 });
    c.set('a', 1);
    c.get('a');
    c.get('a');
    c.get('b');
    const s = c.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRatio).toBeCloseTo(2 / 3, 5);
  });
});

describe('SingleFlight', () => {
  it('collapses concurrent calls for the same key into one execution', async () => {
    const sf = new SingleFlight<number>();
    let executions = 0;
    const work = async () => {
      executions++;
      await new Promise((r) => setImmediate(r));
      return 42;
    };

    const results = await Promise.all(Array.from({ length: 50 }, () => sf.do('same', work)));

    expect(executions).toBe(1);
    expect(results).toEqual(Array.from({ length: 50 }, () => 42));
    expect(sf.pending).toBe(0);
  });

  it('runs distinct keys independently', async () => {
    const sf = new SingleFlight<string>();
    let executions = 0;
    const run = (v: string) => async () => {
      executions++;
      return v;
    };
    const [a, b] = await Promise.all([sf.do('a', run('a')), sf.do('b', run('b'))]);
    expect(executions).toBe(2);
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('does not cache a failure', async () => {
    const sf = new SingleFlight<string>();
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts === 1) throw new Error('boom');
      return 'ok';
    };

    await expect(sf.do('k', flaky)).rejects.toThrow('boom');
    await expect(sf.do('k', flaky)).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });

  it('turns a synchronous throw into a rejection and clears the entry', async () => {
    const sf = new SingleFlight<string>();
    await expect(
      sf.do('k', () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(sf.pending).toBe(0);
  });
});

describe('url-safety', () => {
  it('accepts ordinary public URLs', () => {
    expect(normaliseTargetUrl('https://example.com/a/b?c=d')).toBe('https://example.com/a/b?c=d');
    expect(normaliseTargetUrl('  http://example.com  ')).toBe('http://example.com/');
    expect(normaliseTargetUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('rejects non-http schemes', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://example.com']) {
      expect(() => normaliseTargetUrl(bad)).toThrow(AppError);
    }
  });

  it('rejects private, loopback, and link-local targets', () => {
    const blocked = [
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://10.1.2.3',
      'http://192.168.1.1',
      'http://172.16.0.1',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://0.0.0.0',
      'http://foo.internal/',
    ];
    for (const url of blocked) {
      expect(() => normaliseTargetUrl(url), url).toThrow(AppError);
    }
  });

  it('allows private targets when explicitly permitted', () => {
    expect(normaliseTargetUrl('http://localhost:3000/x', { allowPrivateHosts: true })).toContain('localhost');
  });

  it('rejects embedded credentials', () => {
    expect(() => normaliseTargetUrl('https://user:pass@example.com')).toThrow(/credentials/i);
  });

  it('rejects malformed and oversized input', () => {
    expect(() => normaliseTargetUrl('not a url')).toThrow(AppError);
    expect(() => normaliseTargetUrl('')).toThrow(AppError);
    expect(() => normaliseTargetUrl(`https://example.com/${'x'.repeat(3000)}`)).toThrow(/exceeds/);
  });

  it('classifies hosts directly', () => {
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('LOCALHOST')).toBe(true);
  });
});

describe('alias rules', () => {
  it('accepts a valid alias and preserves case', () => {
    expect(validateAlias('My-Link_1')).toBe('My-Link_1');
  });

  it('rejects bad shapes', () => {
    expect(() => validateAlias('ab')).toThrow(/between/);
    expect(() => validateAlias('x'.repeat(33))).toThrow(/between/);
    expect(() => validateAlias('has space')).toThrow(/only letters/);
    expect(() => validateAlias('has/slash')).toThrow(/only letters/);
  });

  it('rejects reserved words case-insensitively', () => {
    expect(() => validateAlias('api')).toThrow(/reserved/i);
    expect(() => validateAlias('API')).toThrow(/reserved/i);
    expect(isReservedAlias('metrics')).toBe(true);
    expect(isReservedAlias('notreserved')).toBe(false);
  });

  it('screens implausible codes before any I/O', () => {
    expect(isPlausibleCode('aB3xK9')).toBe(true);
    expect(isPlausibleCode('')).toBe(false);
    expect(isPlausibleCode('has space')).toBe(false);
    expect(isPlausibleCode('health')).toBe(false);
  });
});

describe('AppError', () => {
  it('maps codes to statuses', () => {
    expect(AppError.notFound('Link').status).toBe(404);
    expect(AppError.gone('Link').status).toBe(410);
    expect(new AppError('ALIAS_TAKEN', 'x').status).toBe(409);
    expect(new AppError('RATE_LIMITED', 'x').status).toBe(429);
    expect(AppError.internal('x').status).toBe(500);
    expect(statusOf(new Error('plain'))).toBe(500);
  });

  it('does not leak internal messages to the client', () => {
    const env = toEnvelope(AppError.internal('connection string postgres://u:p@h/db failed'), 'req-1');
    expect(env.error.message).toBe('Internal server error');
    expect(JSON.stringify(env)).not.toContain('postgres://');
  });

  it('exposes 4xx messages and details', () => {
    const env = toEnvelope(new AppError('ALIAS_TAKEN', 'Alias "abc" is taken', { details: { alias: 'abc' } }), 'req-2');
    expect(env.error.message).toBe('Alias "abc" is taken');
    expect(env.error.details).toEqual({ alias: 'abc' });
    expect(env.error.requestId).toBe('req-2');
  });

  it('wraps an unknown throw as a generic internal error', () => {
    const env = toEnvelope('a string was thrown', 'req-3');
    expect(env.error.code).toBe('INTERNAL');
    expect(env.error.message).toBe('Internal server error');
  });
});
