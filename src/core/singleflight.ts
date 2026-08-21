/**
 * Single-flight: collapse concurrent work on the same key into one execution.
 *
 * This is the cache-stampede fix (Architecture.md §4). When a hot key expires,
 * every in-flight request for it misses the cache at the same instant and each
 * one would otherwise issue its own database query. With single-flight the
 * first caller runs the query and every later caller awaits that same promise,
 * so the database sees exactly one query per key per expiry regardless of
 * concurrency.
 *
 * Scope is per-process, which is the right granularity here: the shared Redis
 * tier already absorbs cross-replica duplication, and a distributed lock would
 * add a network round trip to the path this exists to make faster.
 */

export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  /**
   * Run `fn` for `key`, or join the run already in progress.
   *
   * The entry is removed when the promise settles — including on rejection — so
   * one failure is not cached and the next caller gets a fresh attempt.
   */
  async do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;

    // Start eagerly, then register, so a synchronous throw inside `fn` still
    // becomes a rejected promise that the finally clause can clean up.
    const promise = (async () => fn())().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  /** Number of distinct keys currently executing. Exposed for metrics and tests. */
  get pending(): number {
    return this.inFlight.size;
  }

  has(key: string): boolean {
    return this.inFlight.has(key);
  }
}
