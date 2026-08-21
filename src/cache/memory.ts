/**
 * In-process CacheDriver.
 *
 * Two jobs: it is the zero-dependency default so the service and its test suite
 * run on a machine with nothing installed (NFR-7), and it is the degraded mode
 * a replica falls back to when Redis is unreachable.
 *
 * The limiting to understand: state lives in one process, so with more than one
 * replica each gets its own budget. That is the whole reason the Redis driver
 * exists, and the boot banner says which one is live so the degradation is
 * never silent.
 */

import type { CacheDriver, RateLimitResult } from './driver.js';

interface Entry {
  value: string;
  expiresAt: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface MemoryCacheOptions {
  /** Injected so tests drive time instead of sleeping (Rules.md §6). */
  now?: () => number;
  /** Safety cap; keeps a rogue key space from exhausting heap. */
  maxKeys?: number;
}

export class MemoryCache implements CacheDriver {
  readonly name = 'memory';
  readonly healthy = true;

  private readonly store = new Map<string, Entry>();
  private readonly windows = new Map<string, number[]>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: MemoryCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 100_000;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    if (this.store.size >= this.maxKeys && !this.store.has(key)) {
      this.evictOldest();
    }
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  /**
   * Sliding-window log. The array holds one timestamp per request in the
   * window; entries older than the window are dropped on each call, so no
   * background sweep is needed.
   */
  async slidingWindow(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const t = this.now();
    const cutoff = t - windowMs;

    const existing = this.windows.get(key) ?? [];
    // Timestamps are appended in order, so the survivors are a suffix.
    let firstLive = 0;
    while (firstLive < existing.length && (existing[firstLive] as number) <= cutoff) firstLive++;
    const live = firstLive === 0 ? existing : existing.slice(firstLive);

    if (live.length >= limit) {
      // The window frees a slot when its oldest entry ages out.
      const oldest = live[0] as number;
      const resetAt = oldest + windowMs;
      this.windows.set(key, live);
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfterMs: Math.max(1, resetAt - t),
      };
    }

    live.push(t);
    this.windows.set(key, live);
    return {
      allowed: true,
      limit,
      remaining: limit - live.length,
      resetAt: (live[0] as number) + windowMs,
      retryAfterMs: 0,
    };
  }

  /** Token bucket with lazy refill: tokens accrue from elapsed time on read. */
  async tokenBucket(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost = 1,
  ): Promise<RateLimitResult> {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, lastRefill: t };

    const elapsedMs = Math.max(0, t - bucket.lastRefill);
    const refilled = Math.min(capacity, bucket.tokens + (elapsedMs / 1000) * refillPerSecond);

    if (refilled < cost) {
      const deficit = cost - refilled;
      const waitMs = Math.ceil((deficit / refillPerSecond) * 1000);
      // Persist the refill so the next call does not recompute from a stale mark.
      this.buckets.set(key, { tokens: refilled, lastRefill: t });
      return {
        allowed: false,
        limit: capacity,
        remaining: Math.floor(refilled),
        resetAt: t + waitMs,
        retryAfterMs: Math.max(1, waitMs),
      };
    }

    const remaining = refilled - cost;
    this.buckets.set(key, { tokens: remaining, lastRefill: t });
    const msToFull = ((capacity - remaining) / refillPerSecond) * 1000;
    return {
      allowed: true,
      limit: capacity,
      remaining: Math.floor(remaining),
      resetAt: t + Math.ceil(msToFull),
      retryAfterMs: 0,
    };
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.store.clear();
    this.windows.clear();
    this.buckets.clear();
  }

  /** Map iteration is insertion-ordered, so the first key is the oldest write. */
  private evictOldest(): void {
    const first = this.store.keys().next();
    if (first.done !== true) this.store.delete(first.value);
  }
}
