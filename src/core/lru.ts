/**
 * L1 cache: a size-capped LRU with a per-entry TTL.
 *
 * Built on the fact that a JS Map iterates in insertion order, so the first key
 * from `keys()` is the least recently used once every read re-inserts. That
 * gives O(1) get, set, and evict without a linked list.
 *
 * Expiry is lazy — checked on read, plus a bounded sweep on write — because a
 * timer per entry would cost more than the cache saves, and would keep the
 * event loop alive at shutdown.
 *
 * This tier is deliberately small and short-lived: it is the one place a
 * replica can serve data another replica has already deleted. `Architecture.md`
 * §4 documents that staleness window as the price of a zero-network hit.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface LruOptions {
  maxEntries: number;
  ttlMs: number;
  /** Injected so tests can advance time without sleeping. */
  now?: () => number;
}

export class LruCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(options: LruOptions) {
    this.maxEntries = Math.max(0, options.maxEntries);
    this.ttlMs = Math.max(0, options.ttlMs);
    this.now = options.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.missCount++;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      this.missCount++;
      return undefined;
    }
    // Re-insert to move the key to the most-recent end of the iteration order.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hitCount++;
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    if (this.maxEntries === 0) return; // L1 disabled by config
    const ttl = ttlMs ?? this.ttlMs;
    if (ttl <= 0) return;

    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttl });

    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.map.delete(oldest.value);
      this.evictionCount++;
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Drop expired entries. Called opportunistically; never required for correctness. */
  prune(): number {
    const t = this.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= t) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }

  stats(): { hits: number; misses: number; evictions: number; size: number; hitRatio: number } {
    const total = this.hitCount + this.missCount;
    return {
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
      size: this.map.size,
      hitRatio: total === 0 ? 0 : this.hitCount / total,
    };
  }
}
