/**
 * In-process DatabaseDriver.
 *
 * Mirrors the Postgres driver's *semantics*, not its storage: a per-shard Map
 * keyed by code gives the same uniqueness guarantee the unique index provides,
 * and `listShard` sorts by the same `(created_at DESC, id DESC)` key the b-tree
 * serves. Holding it to the identical contract suite is what makes the fallback
 * trustworthy rather than approximate.
 *
 * Data is lost on restart. That is stated at boot, not hidden.
 */

import { AppError } from '../core/errors.js';
import type { ClickDelta, LinkRecord, ListOptions, NewLink, ShardHealth } from '../types.js';
import { decodeCursor } from '../types.js';
import type { DatabaseDriver } from './driver.js';

export class MemoryDriver implements DatabaseDriver {
  readonly name = 'memory';
  readonly shardCount: number;

  private readonly shards: Map<string, LinkRecord>[];

  constructor(shardCount: number) {
    this.shardCount = shardCount;
    this.shards = Array.from({ length: shardCount }, () => new Map<string, LinkRecord>());
  }

  async init(): Promise<void> {
    // Nothing to build.
  }

  async insert(shard: number, link: NewLink): Promise<LinkRecord> {
    const table = this.table(shard);
    if (table.has(link.code)) {
      throw new AppError('ALIAS_TAKEN', `Code "${link.code}" is already in use`, {
        details: { code: link.code },
      });
    }
    const record: LinkRecord = {
      id: link.id,
      code: link.code,
      url: link.url,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      clicks: 0,
      lastAccessedAt: null,
    };
    table.set(link.code, record);
    // Return a copy so a caller mutating the result cannot corrupt the store —
    // the Postgres driver hands back a fresh row, and the contract must match.
    return { ...record };
  }

  async findByCode(shard: number, code: string): Promise<LinkRecord | null> {
    const found = this.table(shard).get(code);
    return found === undefined ? null : { ...found };
  }

  async deleteByCode(shard: number, code: string): Promise<boolean> {
    return this.table(shard).delete(code);
  }

  async listShard(shard: number, options: ListOptions): Promise<LinkRecord[]> {
    const rows = [...this.table(shard).values()].sort(
      (a, b) => b.createdAt - a.createdAt || compareIdDesc(a.id, b.id),
    );

    let start = 0;
    if (options.cursor !== undefined && options.cursor !== '') {
      const cursor = decodeCursor(options.cursor);
      if (cursor !== null) {
        start = rows.findIndex(
          (r) =>
            r.createdAt < cursor.createdAt ||
            (r.createdAt === cursor.createdAt && compareIdDesc(r.id, cursor.id) > 0),
        );
        if (start === -1) start = rows.length;
      }
    }

    return rows.slice(start, start + options.limit).map((r) => ({ ...r }));
  }

  async incrementClicks(shard: number, deltas: ClickDelta[]): Promise<void> {
    const table = this.table(shard);
    for (const delta of deltas) {
      const record = table.get(delta.code);
      if (record === undefined) continue; // deleted between the click and the flush
      record.clicks += delta.count;
      record.lastAccessedAt = Math.max(record.lastAccessedAt ?? 0, delta.lastAccessedAt);
    }
  }

  async countShard(shard: number): Promise<number> {
    return this.table(shard).size;
  }

  async ping(): Promise<ShardHealth[]> {
    return this.shards.map((_, shard) => ({ shard, healthy: true }));
  }

  async close(): Promise<void> {
    for (const table of this.shards) table.clear();
  }

  private table(shard: number): Map<string, LinkRecord> {
    const table = this.shards[shard];
    if (table === undefined) {
      throw new RangeError(`shard ${shard} out of range (shardCount=${this.shardCount})`);
    }
    return table;
  }
}

/** IDs are decimal strings of 64-bit values, so compare by length then lexically. */
function compareIdDesc(a: string, b: string): number {
  if (a.length !== b.length) return b.length - a.length;
  return a < b ? 1 : a > b ? -1 : 0;
}
