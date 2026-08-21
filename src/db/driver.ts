/**
 * The storage contract.
 *
 * Every method takes an explicit `shard` index. Routing lives one layer up in
 * `ShardedStore`, so the driver never has to know how a code maps to a shard
 * and the routing strategy can change without touching either implementation.
 *
 * `list` is deliberately per-shard (`listShard`): the fan-out and merge are the
 * store's job, which keeps the Postgres driver free of cross-connection logic.
 */

import type { ClickDelta, LinkRecord, ListOptions, NewLink, ShardHealth } from '../types.js';

export interface DatabaseDriver {
  readonly name: string;
  readonly shardCount: number;

  /** Create schema / warm pools. Safe to call more than once. */
  init(): Promise<void>;

  /**
   * Insert a link. Throws AppError('ALIAS_TAKEN') when `code` already exists —
   * enforced by a unique index, so two replicas racing on the same alias
   * cannot both win.
   */
  insert(shard: number, link: NewLink): Promise<LinkRecord>;

  findByCode(shard: number, code: string): Promise<LinkRecord | null>;

  /** Returns false when the code was not present. */
  deleteByCode(shard: number, code: string): Promise<boolean>;

  listShard(shard: number, options: ListOptions): Promise<LinkRecord[]>;

  /** Batched click apply — one round trip per shard, never one per click. */
  incrementClicks(shard: number, deltas: ClickDelta[]): Promise<void>;

  /** Count rows in a shard. Used by /ready and the shard distribution report. */
  countShard(shard: number): Promise<number>;

  ping(): Promise<ShardHealth[]>;

  close(): Promise<void>;
}
