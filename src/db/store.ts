/**
 * ShardedStore — routing and fan-out over a DatabaseDriver.
 *
 * Single-key operations (the hot path) touch exactly one shard: the router
 * turns a code into a shard index and the driver is called once. Only `list`
 * fans out, and that is an admin-tier operation, not the redirect path
 * (Architecture.md §6).
 */

import type { ClickDelta, LinkRecord, ListOptions, NewLink, ShardHealth } from '../types.js';
import { encodeCursor } from '../types.js';
import type { DatabaseDriver } from './driver.js';
import { ShardRouter } from './shard-router.js';

export interface ListPage {
  items: LinkRecord[];
  nextCursor: string | null;
}

export class ShardedStore {
  readonly router: ShardRouter;

  constructor(
    private readonly driver: DatabaseDriver,
    router?: ShardRouter,
  ) {
    this.router = router ?? new ShardRouter(driver.shardCount);
    if (this.router.shardCount !== driver.shardCount) {
      throw new RangeError(
        `Router shard count (${this.router.shardCount}) does not match driver (${driver.shardCount})`,
      );
    }
  }

  get driverName(): string {
    return this.driver.name;
  }

  get shardCount(): number {
    return this.router.shardCount;
  }

  shardFor(code: string): number {
    return this.router.shardFor(code);
  }

  async init(): Promise<void> {
    await this.driver.init();
  }

  async insert(link: NewLink): Promise<LinkRecord> {
    return this.driver.insert(this.router.shardFor(link.code), link);
  }

  async findByCode(code: string): Promise<LinkRecord | null> {
    return this.driver.findByCode(this.router.shardFor(code), code);
  }

  async deleteByCode(code: string): Promise<boolean> {
    return this.driver.deleteByCode(this.router.shardFor(code), code);
  }

  /**
   * Scatter-gather list.
   *
   * Each shard returns its own top `limit` rows past the cursor; merging them
   * and re-slicing to `limit` yields the globally correct page, because the
   * sort key `(createdAt, id)` is total and every shard applies the same cursor.
   * Reading `limit` per shard is the necessary over-fetch: the true page could
   * in principle come entirely from one shard.
   */
  async list(options: ListOptions): Promise<ListPage> {
    const perShard = await Promise.all(
      this.router.allShards().map((shard) => this.driver.listShard(shard, options)),
    );

    const merged = perShard
      .flat()
      .sort((a, b) => b.createdAt - a.createdAt || compareIdDesc(a.id, b.id))
      .slice(0, options.limit);

    const last = merged.at(-1);
    // A short page means every shard is drained, so there is nothing after it.
    const nextCursor =
      last !== undefined && merged.length === options.limit ? encodeCursor(last) : null;

    return { items: merged, nextCursor };
  }

  /**
   * Apply buffered clicks. Deltas are grouped by shard so each shard takes one
   * round trip regardless of how many distinct codes were clicked.
   */
  async applyClicks(deltas: ClickDelta[]): Promise<void> {
    if (deltas.length === 0) return;

    const byShard = new Map<number, ClickDelta[]>();
    for (const delta of deltas) {
      const shard = this.router.shardFor(delta.code);
      const list = byShard.get(shard);
      if (list === undefined) byShard.set(shard, [delta]);
      else list.push(delta);
    }

    await Promise.all(
      [...byShard.entries()].map(([shard, group]) => this.driver.incrementClicks(shard, group)),
    );
  }

  /** Row counts per shard — the evidence that hash routing actually spreads load. */
  async shardDistribution(): Promise<{ shard: number; count: number }[]> {
    return Promise.all(
      this.router.allShards().map(async (shard) => ({
        shard,
        count: await this.driver.countShard(shard),
      })),
    );
  }

  async ping(): Promise<ShardHealth[]> {
    return this.driver.ping();
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

function compareIdDesc(a: string, b: string): number {
  if (a.length !== b.length) return b.length - a.length;
  return a < b ? 1 : a > b ? -1 : 0;
}
