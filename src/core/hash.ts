/**
 * FNV-1a, 32-bit.
 *
 * Used for shard routing (`fnv1a32(code) % SHARD_COUNT`) and for deriving a
 * node ID from a hostname. Chosen because it is fast, allocation-free, and
 * distributes short ASCII strings evenly — which is all shard routing asks of
 * a hash. It is deliberately *not* cryptographic: shard placement is not a
 * secret, and a stronger hash would only cost latency on the hot path.
 *
 * Determinism is the load-bearing property. Every replica must route a given
 * code to the same shard with no coordination, so this function must never
 * change behaviour once data exists.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by the FNV prime in 32-bit space. Math.imul keeps this exact;
    // a plain `*` would lose precision above 2^53 after a few rounds.
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Coerce to unsigned so the modulo below never yields a negative index.
  return hash >>> 0;
}

/** Map an arbitrary key onto `buckets` slots. Returns 0 when there is a single bucket. */
export function bucketOf(key: string, buckets: number): number {
  if (!Number.isInteger(buckets) || buckets < 1) {
    throw new RangeError(`bucketOf: buckets must be a positive integer, got ${buckets}`);
  }
  if (buckets === 1) return 0;
  return fnv1a32(key) % buckets;
}
