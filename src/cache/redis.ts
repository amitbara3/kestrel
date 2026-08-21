/**
 * Redis CacheDriver — the production implementation.
 *
 * Three things make this more than a thin ioredis wrapper:
 *
 * 1. Both limiters run as Lua scripts, so check-and-write is atomic across
 *    every replica (see lua.ts).
 * 2. A circuit breaker turns a Redis outage into a fast failure instead of a
 *    slow one, which is what lets the service degrade to database reads instead
 *    of timing out (NFR-5).
 * 3. The client is configured to fail fast: no offline command queue, one retry,
 *    short timeouts. Queuing commands during an outage would just convert the
 *    outage into a memory leak and a thundering herd on recovery.
 */

import { Redis } from 'ioredis';

import { AppError } from '../core/errors.js';
import type { Logger } from '../logger.js';
import { CircuitBreaker } from './circuit-breaker.js';
import type { CacheDriver, RateLimitResult } from './driver.js';
import { SLIDING_WINDOW_LUA, TOKEN_BUCKET_LUA } from './lua.js';

export interface RedisCacheOptions {
  url: string;
  keyPrefix: string;
  logger: Logger;
  failureThreshold?: number;
  cooldownMs?: number;
  commandTimeoutMs?: number;
}

type LuaReply = [number, number, number, number, number];

export class RedisCache implements CacheDriver {
  readonly name = 'redis';

  private readonly client: Redis;
  private readonly prefix: string;
  private readonly logger: Logger;
  private readonly breaker: CircuitBreaker;
  private counter = 0;
  private closed = false;

  constructor(options: RedisCacheOptions) {
    this.prefix = options.keyPrefix;
    this.logger = options.logger;

    this.breaker = new CircuitBreaker({
      failureThreshold: options.failureThreshold ?? 5,
      cooldownMs: options.cooldownMs ?? 10_000,
      onStateChange: (from, to) => {
        const msg = `Redis circuit breaker ${from} -> ${to}`;
        if (to === 'open') this.logger.error(msg, { dependency: 'redis', degraded: true });
        else this.logger.warn(msg, { dependency: 'redis', degraded: to !== 'closed' });
      },
    });

    this.client = new Redis(options.url, {
      lazyConnect: true,
      // Fail fast rather than buffering commands while the server is unreachable.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3_000,
      commandTimeout: options.commandTimeoutMs ?? 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });

    // ioredis emits 'error' on every failed reconnect; without a listener Node
    // treats it as unhandled and exits the process.
    this.client.on('error', (err: Error) => {
      this.logger.debug('Redis client error', { error: err.message });
    });

    this.client.defineCommand('kestrelSlidingWindow', {
      numberOfKeys: 1,
      lua: SLIDING_WINDOW_LUA,
    });
    this.client.defineCommand('kestrelTokenBucket', {
      numberOfKeys: 1,
      lua: TOKEN_BUCKET_LUA,
    });
  }

  get healthy(): boolean {
    return this.breaker.isClosed && this.client.status === 'ready';
  }

  get breakerState(): string {
    return this.breaker.current;
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async get(key: string): Promise<string | null> {
    // A cache read is always optional: a failure is a miss, never an error.
    return this.guardOptional(async () => this.client.get(this.k(key)), null);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.guardOptional(async () => {
      await this.client.set(this.k(key), value, 'EX', Math.ceil(ttlSeconds));
      return undefined;
    }, undefined);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.guardOptional(async () => {
      await this.client.del(...keys.map((key) => this.k(key)));
      return undefined;
    }, undefined);
  }

  async slidingWindow(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    // A unique member per request; without it ZADD would overwrite the score of
    // an existing member and the window would undercount.
    const member = `${Date.now()}-${process.pid}-${this.counter++}`;
    const reply = await this.guardRequired<LuaReply>(
      async () =>
        (await this.client.call(
          'kestrelSlidingWindow',
          this.k(`rl:sw:${key}`),
          String(Date.now()),
          String(windowMs),
          String(limit),
          member,
        )) as LuaReply,
      'sliding window',
    );
    return toResult(reply);
  }

  async tokenBucket(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost = 1,
  ): Promise<RateLimitResult> {
    const reply = await this.guardRequired<LuaReply>(
      async () =>
        (await this.client.call(
          'kestrelTokenBucket',
          this.k(`rl:tb:${key}`),
          String(Date.now()),
          String(capacity),
          String(refillPerSecond),
          String(cost),
        )) as LuaReply,
      'token bucket',
    );
    return toResult(reply);
  }

  async ping(): Promise<boolean> {
    if (this.closed) return false;
    try {
      const pong = await this.client.ping();
      this.breaker.recordSuccess();
      return pong === 'PONG';
    } catch {
      this.breaker.recordFailure();
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * For operations where failure is survivable: return `fallback` instead of
   * throwing, and feed the breaker so a sustained outage stops being retried.
   */
  private async guardOptional<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    if (this.closed || !this.breaker.canAttempt()) return fallback;
    try {
      const result = await op();
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      this.logger.debug('Redis operation failed; treating as a miss', {
        error: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  }

  /**
   * For operations with no meaningful fallback value. Throws
   * DEPENDENCY_UNAVAILABLE so the rate-limit middleware can consciously choose
   * to degrade to a local limiter rather than silently allowing everything.
   */
  private async guardRequired<T>(op: () => Promise<T>, what: string): Promise<T> {
    if (this.closed || !this.breaker.canAttempt()) {
      throw AppError.unavailable('redis');
    }
    try {
      const result = await op();
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      throw AppError.unavailable('redis', new Error(`${what} failed: ${errText(err)}`));
    }
  }
}

function toResult(reply: LuaReply): RateLimitResult {
  const [allowed, limit, remaining, resetAt, retryAfterMs] = reply;
  return {
    allowed: allowed === 1,
    limit,
    remaining: Math.max(0, remaining),
    resetAt,
    retryAfterMs,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
