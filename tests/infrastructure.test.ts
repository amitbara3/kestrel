/**
 * Config, logging, click buffering, and client identification — the pieces
 * that are load-bearing for security and correctness but do not sit on the
 * link path.
 */

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { MemoryDriver } from '../src/db/memory.js';
import { ShardedStore } from '../src/db/store.js';
import { createLogger, nullLogger } from '../src/logger.js';
import { Metrics } from '../src/middleware/metrics.js';
import { parseTrustedProxies, resolveClientId } from '../src/middleware/request-context.js';
import { ClickTracker } from '../src/services/analytics.js';
import type { FastifyRequest } from 'fastify';

describe('config', () => {
  it('boots with zero environment variables set', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.port).toBe(3000);
    expect(config.db.shardCount).toBe(4);
    expect(config.cache.redisUrl).toBeUndefined();
    expect(config.rateLimit.enabled).toBe(true);
  });

  it('parses numbers, booleans, and lists from strings', () => {
    const config = loadConfig({
      PORT: '8080',
      SHARD_COUNT: '8',
      RATE_LIMIT_ENABLED: 'false',
      TRUSTED_PROXIES: '10.0.0.0/8, 192.168.0.0/16',
    } as NodeJS.ProcessEnv);

    expect(config.port).toBe(8080);
    expect(config.db.shardCount).toBe(8);
    expect(config.rateLimit.enabled).toBe(false);
    expect(config.rateLimit.trustedProxies).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('rejects an out-of-range value rather than silently clamping it', () => {
    expect(() => loadConfig({ PORT: '99999' } as NodeJS.ProcessEnv)).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ SHARD_COUNT: '0' } as NodeJS.ProcessEnv)).toThrow(/SHARD_COUNT/);
    expect(() => loadConfig({ NODE_ID: '2000' } as NodeJS.ProcessEnv)).toThrow(/NODE_ID/);
  });

  it('derives a node ID in range when none is pinned', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.nodeId).toBeGreaterThanOrEqual(0);
    expect(config.nodeId).toBeLessThan(1024);
  });

  it('honours a pinned node ID', () => {
    expect(loadConfig({ NODE_ID: '42' } as NodeJS.ProcessEnv).nodeId).toBe(42);
  });

  it('strips a trailing slash from the base URL so short links are not doubled', () => {
    expect(loadConfig({ BASE_URL: 'https://kes.tr/' } as NodeJS.ProcessEnv).baseUrl).toBe('https://kes.tr');
  });

  it('is frozen after load', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe('logger', () => {
  it('emits one JSON object per line', () => {
    const lines: string[] = [];
    createLogger({ level: 'info', sink: (l) => lines.push(l) }).info('hello', { a: 1 });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string);
    expect(record).toMatchObject({ level: 'info', msg: 'hello', a: 1 });
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    log.debug('no');
    log.info('no');
    log.warn('yes');
    log.error('yes');
    expect(lines).toHaveLength(2);
  });

  // Rules.md §5: a secret must never reach a log, whoever passes it.
  it('redacts secrets by field name', () => {
    const lines: string[] = [];
    createLogger({ level: 'info', sink: (l) => lines.push(l) }).info('connect', {
      password: 'hunter2-very-secret',
      apiKey: 'sk_live_abcdefghijklmnop',
      DATABASE_URL: 'postgres://user:pass@host/db',
      nested: { authorization: 'Bearer abcdefghijklmnop' },
      safe: 'visible',
    });

    const line = lines[0] as string;
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('abcdefghijklmnop');
    expect(line).not.toContain('postgres://user:pass');
    expect(line).toContain('visible');
    // A recognisable prefix survives so a key can still be correlated.
    expect(line).toContain('sk_l***');
  });

  it('carries child bindings into every record', () => {
    const lines: string[] = [];
    createLogger({ level: 'info', sink: (l) => lines.push(l) })
      .child({ instance: 'app-1' })
      .info('x');
    expect(JSON.parse(lines[0] as string).instance).toBe('app-1');
  });

  it('serialises an Error rather than dropping it to {}', () => {
    const lines: string[] = [];
    createLogger({ level: 'error', sink: (l) => lines.push(l) }).error('failed', {
      error: new Error('boom'),
    });
    const record = JSON.parse(lines[0] as string);
    expect(record.error.message).toBe('boom');
    expect(record.error.stack).toBeTruthy();
  });

  it('never throws on a circular field', () => {
    const lines: string[] = [];
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() =>
      createLogger({ level: 'info', sink: (l) => lines.push(l) }).info('circular', { circular }),
    ).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('trusted proxies and client identity', () => {
  const trusted = parseTrustedProxies(['127.0.0.1/32', '10.0.0.0/8', '::1/128']);

  function request(options: {
    socket?: string;
    forwarded?: string;
    apiKey?: string;
  }): FastifyRequest {
    return {
      headers: {
        ...(options.forwarded !== undefined ? { 'x-forwarded-for': options.forwarded } : {}),
        ...(options.apiKey !== undefined ? { 'x-api-key': options.apiKey } : {}),
      },
      socket: { remoteAddress: options.socket ?? '203.0.113.9' },
    } as unknown as FastifyRequest;
  }

  it('matches CIDRs correctly', () => {
    expect(trusted.contains('127.0.0.1')).toBe(true);
    expect(trusted.contains('10.4.5.6')).toBe(true);
    expect(trusted.contains('11.0.0.1')).toBe(false);
    expect(trusted.contains('203.0.113.9')).toBe(false);
    expect(trusted.contains('::1')).toBe(true);
  });

  it('treats an IPv4-mapped IPv6 address as its IPv4 form', () => {
    expect(trusted.contains('::ffff:10.1.2.3')).toBe(true);
  });

  // The attack this prevents: spoofing X-Forwarded-For to reset your own limit.
  it('ignores X-Forwarded-For from an untrusted peer', () => {
    const id = resolveClientId(
      request({ socket: '203.0.113.9', forwarded: '1.2.3.4' }),
      trusted,
    );
    expect(id).toBe('ip:203.0.113.9');
  });

  it('honours X-Forwarded-For from a trusted proxy', () => {
    const id = resolveClientId(request({ socket: '10.0.0.5', forwarded: '1.2.3.4' }), trusted);
    expect(id).toBe('ip:1.2.3.4');
  });

  it('takes the left-most entry of a forwarded chain', () => {
    const id = resolveClientId(
      request({ socket: '10.0.0.5', forwarded: '1.2.3.4, 10.0.0.1, 10.0.0.5' }),
      trusted,
    );
    expect(id).toBe('ip:1.2.3.4');
  });

  it('prefers an API key over any IP', () => {
    const id = resolveClientId(
      request({ socket: '10.0.0.5', forwarded: '1.2.3.4', apiKey: 'abc123' }),
      trusted,
    );
    expect(id).toBe('apikey:abc123');
  });

  it('bounds an oversized API key so it cannot inflate the key space', () => {
    const id = resolveClientId(request({ apiKey: 'x'.repeat(500) }), trusted);
    expect(id.length).toBeLessThanOrEqual('apikey:'.length + 64);
  });

  it('skips malformed CIDR entries instead of throwing at boot', () => {
    const lenient = parseTrustedProxies(['not-an-ip', '10.0.0.0/99', '', '192.168.1.0/24']);
    expect(lenient.contains('192.168.1.7')).toBe(true);
    expect(lenient.contains('10.0.0.1')).toBe(false);
  });
});

describe('ClickTracker', () => {
  function makeTracker(options: { flushIntervalMs?: number; bufferMax?: number } = {}) {
    const store = new ShardedStore(new MemoryDriver(4));
    const tracker = new ClickTracker({
      store,
      logger: nullLogger,
      metrics: new Metrics('test'),
      flushIntervalMs: options.flushIntervalMs ?? 10_000,
      bufferMax: options.bufferMax ?? 1000,
    });
    return { store, tracker };
  }

  it('buffers rather than writing on every click', async () => {
    const { store, tracker } = makeTracker();
    const applyClicks = vi.spyOn(store, 'applyClicks');

    for (let i = 0; i < 100; i++) tracker.record('same-code');
    expect(applyClicks).not.toHaveBeenCalled();
    expect(tracker.pending).toBe(1); // 100 clicks collapse to one delta

    await tracker.flush();
    expect(applyClicks).toHaveBeenCalledTimes(1);
    expect(applyClicks.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ code: 'same-code', count: 100 }),
    ]);
  });

  it('applies counts to the store', async () => {
    const { store, tracker } = makeTracker();
    await store.insert({
      id: '1',
      code: 'counted',
      url: 'https://example.com',
      createdAt: Date.now(),
      expiresAt: null,
    });

    for (let i = 0; i < 7; i++) tracker.record('counted');
    await tracker.flush();

    expect((await store.findByCode('counted'))?.clicks).toBe(7);
  });

  it('flushes on its own when the buffer cap is reached', async () => {
    const { store, tracker } = makeTracker({ bufferMax: 5 });
    const applyClicks = vi.spyOn(store, 'applyClicks');

    for (let i = 0; i < 5; i++) tracker.record(`code-${i}`);

    await vi.waitFor(() => expect(applyClicks).toHaveBeenCalled());
  });

  it('does not lose clicks that arrive during a flush', async () => {
    const { store, tracker } = makeTracker();
    let release: () => void = () => undefined;
    vi.spyOn(store, 'applyClicks').mockImplementationOnce(
      async () => new Promise<void>((resolve) => (release = resolve)),
    );

    tracker.record('a');
    const flushing = tracker.flush();

    // These land in the fresh buffer, not the one being written.
    tracker.record('b');
    tracker.record('b');

    release();
    await flushing;

    expect(tracker.pending).toBe(1);
  });

  it('survives a store failure without throwing at the caller', async () => {
    const { store, tracker } = makeTracker();
    vi.spyOn(store, 'applyClicks').mockRejectedValue(new Error('database down'));

    tracker.record('x');
    await expect(tracker.flush()).resolves.toBeUndefined();
  });

  it('flushes on stop and then ignores further clicks', async () => {
    const { store, tracker } = makeTracker();
    const applyClicks = vi.spyOn(store, 'applyClicks');

    tracker.start();
    tracker.record('shutdown');
    await tracker.stop();

    expect(applyClicks).toHaveBeenCalledTimes(1);

    tracker.record('after-stop');
    expect(tracker.pending).toBe(0);
  });

  it('is a no-op when there is nothing buffered', async () => {
    const { store, tracker } = makeTracker();
    const applyClicks = vi.spyOn(store, 'applyClicks');
    await tracker.flush();
    expect(applyClicks).not.toHaveBeenCalled();
  });
});

describe('Metrics', () => {
  it('renders counters, gauges, and histograms in Prometheus format', () => {
    const metrics = new Metrics('app-1');
    metrics.httpRequests.inc(metrics.withInstance({ route: '/:code', method: 'GET', status: '302' }));
    metrics.httpDuration.observe(0.004, metrics.withInstance({ route: '/:code' }));
    metrics.l1Size.set(42, metrics.withInstance());

    const out = metrics.render();
    expect(out).toContain('# TYPE kestrel_http_requests_total counter');
    expect(out).toContain('route="/:code"');
    expect(out).toContain('kestrel_http_request_duration_seconds_bucket');
    expect(out).toContain('le="+Inf"');
    expect(out).toContain('kestrel_l1_cache_entries{instance="app-1"} 42');
  });

  it('accumulates counter values per label set', () => {
    const metrics = new Metrics('app-1');
    metrics.recordCache('l1', 'hit');
    metrics.recordCache('l1', 'hit');
    metrics.recordCache('l1', 'miss');

    expect(metrics.cacheEvents.get(metrics.withInstance({ tier: 'l1', outcome: 'hit' }))).toBe(2);
    expect(metrics.cacheEvents.get(metrics.withInstance({ tier: 'l1', outcome: 'miss' }))).toBe(1);
  });

  it('escapes label values so a quote cannot corrupt the exposition', () => {
    const metrics = new Metrics('app-1');
    metrics.httpRequests.inc({ route: 'a"b\\c' });
    expect(metrics.render()).toContain('a\\"b\\\\c');
  });

  it('omits a metric that has never been observed', () => {
    expect(new Metrics('app-1').render()).not.toContain('kestrel_rate_limit_rejections_total');
  });
});
