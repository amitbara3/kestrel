/**
 * Snowflake-style distributed ID generator.
 *
 * 64-bit layout:
 *   1 bit  unused (keeps the value positive as a signed 64-bit integer)
 *   41 bits timestamp, ms since a custom epoch  -> ~69 years of range
 *   10 bits node ID                             -> 1024 replicas
 *   12 bits sequence                            -> 4096 IDs per node per ms
 *
 * Why this and not a database sequence: an ID is needed on every create, and a
 * sequence would put a network round trip and a shared bottleneck on the write
 * path. This generates locally with zero coordination, which is what makes the
 * replicas genuinely stateless.
 *
 * Why not UUIDv4: 128 random bits produce a 22-character Base62 code — too long
 * for a short link — and index poorly because they are unordered. These IDs are
 * time-ordered, so the b-tree appends rather than fragments.
 *
 * Tradeoff: correctness depends on the clock. A backwards jump could re-issue
 * IDs already handed out, so the generator refuses to issue during a rewind
 * rather than risk a duplicate.
 */

/** 2024-01-01T00:00:00Z. Fixed forever — changing it would re-mint existing IDs. */
export const KESTREL_EPOCH_MS = 1_704_067_200_000;

const NODE_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_NODE_ID = (1 << 10) - 1;
const MAX_SEQUENCE = (1 << 12) - 1;
const NODE_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + NODE_BITS;

export interface IdGeneratorOptions {
  nodeId: number;
  /** Injected so tests can drive time deterministically (Rules.md §6: no sleep-based tests). */
  now?: () => number;
  epoch?: number;
}

export class ClockRewindError extends Error {
  constructor(byMs: number) {
    super(`Clock moved backwards by ${byMs}ms; refusing to generate an ID`);
    this.name = 'ClockRewindError';
  }
}

export class IdGenerator {
  private readonly nodeId: bigint;
  private readonly now: () => number;
  private readonly epoch: number;
  private lastTimestamp = -1;
  private sequence = 0;

  constructor(options: IdGeneratorOptions) {
    if (!Number.isInteger(options.nodeId) || options.nodeId < 0 || options.nodeId > MAX_NODE_ID) {
      throw new RangeError(`nodeId must be an integer in [0, ${MAX_NODE_ID}], got ${options.nodeId}`);
    }
    this.nodeId = BigInt(options.nodeId);
    this.now = options.now ?? Date.now;
    this.epoch = options.epoch ?? KESTREL_EPOCH_MS;
  }

  /**
   * Next ID. Monotonically increasing for a given node.
   *
   * Throws ClockRewindError on a backwards clock — louder than silently risking
   * a duplicate, and recoverable once NTP settles.
   */
  next(): bigint {
    let ts = this.now();

    if (ts < this.lastTimestamp) {
      throw new ClockRewindError(this.lastTimestamp - ts);
    }

    if (ts === this.lastTimestamp) {
      this.sequence = (this.sequence + 1) & MAX_SEQUENCE;
      if (this.sequence === 0) {
        // 4096 IDs issued inside one millisecond: spin to the next tick rather
        // than wrap the sequence and collide with an ID already issued.
        ts = this.waitNextMillis(this.lastTimestamp);
      }
    } else {
      this.sequence = 0;
    }

    this.lastTimestamp = ts;

    const elapsed = BigInt(ts - this.epoch);
    if (elapsed < 0n) {
      throw new RangeError('Current time is before the configured epoch');
    }
    return (elapsed << TIMESTAMP_SHIFT) | (this.nodeId << NODE_SHIFT) | BigInt(this.sequence);
  }

  /** Busy-wait to the next millisecond. Bounded by definition: at most 1 ms. */
  private waitNextMillis(last: number): number {
    let ts = this.now();
    while (ts <= last) ts = this.now();
    return ts;
  }
}

/** Recover the wall-clock time an ID was minted at — useful for debugging and for TTL reasoning. */
export function timestampOf(id: bigint, epoch: number = KESTREL_EPOCH_MS): number {
  return Number(id >> TIMESTAMP_SHIFT) + epoch;
}

export function nodeIdOf(id: bigint): number {
  return Number((id >> NODE_SHIFT) & BigInt(MAX_NODE_ID));
}

export function sequenceOf(id: bigint): number {
  return Number(id & BigInt(MAX_SEQUENCE));
}
