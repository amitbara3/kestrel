/**
 * The cache contract.
 *
 * Deliberately *high-level*, not command-level: `slidingWindow(...)` is one
 * method rather than ZREMRANGEBYSCORE + ZCARD + ZADD + EXPIRE. That choice is
 * what makes two very different implementations possible without either one
 * leaking its mechanism — Redis runs a Lua script, the in-process driver walks
 * an array — and it means the fallback driver needs no Lua emulator.
 *
 * Both implementations are held to the same contract test suite, which is what
 * keeps the fallback honest (Architecture.md §2).
 */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms at which the caller regains capacity. */
  resetAt: number;
  /** Milliseconds to wait before retrying. 0 when allowed. */
  retryAfterMs: number;
}

export interface CacheDriver {
  /** Identifies the implementation in logs and on /ready. */
  readonly name: string;

  /** True when the driver is currently usable. False while a circuit breaker is open. */
  readonly healthy: boolean;

  get(key: string): Promise<string | null>;

  set(key: string, value: string, ttlSeconds: number): Promise<void>;

  del(...keys: string[]): Promise<void>;

  /**
   * Sliding-window log limiter: exact, no boundary burst.
   * Costs O(limit) memory per identity, which is fine at API-tier limits.
   */
  slidingWindow(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;

  /**
   * Token bucket: burst-tolerant, O(1) memory per identity.
   * Refill is computed lazily from elapsed time — no background timer.
   */
  tokenBucket(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost?: number,
  ): Promise<RateLimitResult>;

  ping(): Promise<boolean>;

  close(): Promise<void>;
}
