/**
 * Shard routing: `fnv1a32(code) % shardCount`.
 *
 * Hashing the *code* rather than the ID is the load-bearing decision. Every
 * read path starts from a code, so hashing it keeps a redirect single-shard;
 * hashing the ID would force a fan-out across every shard on every redirect —
 * exactly the hot path this design exists to keep cheap.
 *
 * Fixed modulo rather than consistent hashing: with a shard count fixed at
 * deploy time, modulo is simpler and equally correct. Consistent hashing only
 * earns its complexity when shards are added at runtime, which v1 does not do
 * (PRD.md §3.2). It lives behind this one function so the swap stays contained.
 */

import { fnv1a32 } from '../core/hash.js';

export class ShardRouter {
  readonly shardCount: number;

  constructor(shardCount: number) {
    if (!Number.isInteger(shardCount) || shardCount < 1) {
      throw new RangeError(`shardCount must be a positive integer, got ${shardCount}`);
    }
    this.shardCount = shardCount;
  }

  /** Deterministic across every replica and every restart — no coordination. */
  shardFor(code: string): number {
    if (this.shardCount === 1) return 0;
    return fnv1a32(code) % this.shardCount;
  }

  allShards(): number[] {
    return Array.from({ length: this.shardCount }, (_, i) => i);
  }

  /**
   * Which physical server holds a logical shard.
   *
   * Logical shards (tables) and physical shards (servers) are separated so the
   * cluster can grow servers without re-hashing rows: 8 logical shards can sit
   * on 1 server today and 8 tomorrow with no change to routing.
   */
  serverFor(shard: number, serverCount: number): number {
    if (serverCount < 1) throw new RangeError('serverCount must be >= 1');
    return shard % serverCount;
  }
}
