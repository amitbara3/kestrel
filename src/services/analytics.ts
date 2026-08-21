/**
 * Buffered click counter.
 *
 * A redirect must not carry a database write. Clicks accumulate in memory
 * keyed by code and flush on a timer as one batched statement per shard, so
 * 10,000 clicks on one link across five seconds cost one UPDATE instead of
 * 10,000.
 *
 * The trade, stated plainly: counts are eventually consistent, and up to one
 * flush interval of clicks is lost if a replica is hard-killed (SIGKILL, OOM).
 * A graceful SIGTERM flushes first. For click analytics that is the right
 * trade; for anything that must be exact it would not be.
 */

import type { ShardedStore } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../middleware/metrics.js';
import type { ClickDelta } from '../types.js';

export interface AnalyticsOptions {
  store: ShardedStore;
  logger: Logger;
  metrics: Metrics;
  flushIntervalMs: number;
  /** Back-pressure bound: a flush is forced when the buffer reaches this size. */
  bufferMax: number;
  now?: () => number;
}

interface Pending {
  count: number;
  lastAccessedAt: number;
}

export class ClickTracker {
  private buffer = new Map<string, Pending>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private stopped = false;

  private readonly now: () => number;

  constructor(private readonly options: AnalyticsOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => undefined);
    }, this.options.flushIntervalMs);
    // Do not hold the event loop open; shutdown flushes explicitly.
    this.timer.unref?.();
  }

  /**
   * Record a click. Synchronous and allocation-light by design — this runs on
   * the redirect path.
   */
  record(code: string): void {
    if (this.stopped) return;

    const existing = this.buffer.get(code);
    if (existing === undefined) {
      this.buffer.set(code, { count: 1, lastAccessedAt: this.now() });
    } else {
      existing.count++;
      existing.lastAccessedAt = this.now();
    }

    this.options.metrics.clicksBuffered.set(this.buffer.size, this.options.metrics.withInstance());

    if (this.buffer.size >= this.options.bufferMax) {
      // Fire-and-forget: the redirect must not wait on a flush. Errors are
      // logged inside flush(), never surfaced to the user (Rules.md §3).
      void this.flush().catch(() => undefined);
    }
  }

  /**
   * Write the buffer out. Concurrent calls join the flush already running, so
   * a timer tick during a size-triggered flush cannot double-apply deltas.
   */
  async flush(): Promise<void> {
    if (this.flushing !== undefined) return this.flushing;
    if (this.buffer.size === 0) return;

    // Swap the buffer out first: clicks arriving during the write land in the
    // new map and are counted by the next flush, rather than being lost.
    const batch = this.buffer;
    this.buffer = new Map();

    const deltas: ClickDelta[] = [...batch.entries()].map(([code, pending]) => ({
      code,
      count: pending.count,
      lastAccessedAt: pending.lastAccessedAt,
    }));

    this.flushing = (async () => {
      try {
        await this.options.store.applyClicks(deltas);
        this.options.logger.debug('Flushed click buffer', {
          codes: deltas.length,
          clicks: deltas.reduce((sum, d) => sum + d.count, 0),
        });
      } catch (err) {
        // Analytics failure must never break the service. The counts are lost;
        // that is preferable to retrying into a database that is already sick.
        this.options.logger.warn('Click flush failed; deltas dropped', {
          codes: deltas.length,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.flushing = undefined;
        this.options.metrics.clicksBuffered.set(
          this.buffer.size,
          this.options.metrics.withInstance(),
        );
      }
    })();

    return this.flushing;
  }

  /** Stop the timer and write out whatever is buffered. Called on SIGTERM. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    if (this.flushing !== undefined) await this.flushing;
  }

  get pending(): number {
    return this.buffer.size;
  }
}
