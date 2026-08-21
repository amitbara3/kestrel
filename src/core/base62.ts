/**
 * Base62 encoding: the numeric ID a replica generates becomes the short code.
 *
 * Why 62 and not 64: the alphabet is [0-9A-Za-z], which survives a URL path, a
 * double-click selection, and a hand transcription without escaping. Base64's
 * `+` and `/` need percent-encoding in a path, which defeats the point of a
 * short link.
 *
 * Why encode an ID rather than hash the URL: encoding is a bijection, so no
 * collision check is needed. A hash would need a database round trip on every
 * create to prove uniqueness, and a retry loop when it failed.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = 62n;

/** Reverse lookup built once; a Map beats `indexOf` on the decode hot path. */
const VALUE_OF = new Map<string, bigint>();
for (let i = 0; i < ALPHABET.length; i++) {
  VALUE_OF.set(ALPHABET[i] as string, BigInt(i));
}

export const BASE62_ALPHABET = ALPHABET;

/**
 * Encode a non-negative integer to Base62.
 *
 * Accepts bigint because Snowflake IDs exceed Number.MAX_SAFE_INTEGER; numbers
 * are accepted for convenience but must be safe integers.
 */
export function encodeBase62(value: bigint | number): string {
  let n: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`encodeBase62: ${value} is not a safe integer`);
    }
    n = BigInt(value);
  } else {
    n = value;
  }
  if (n < 0n) throw new RangeError('encodeBase62: value must be non-negative');
  if (n === 0n) return '0';

  let out = '';
  while (n > 0n) {
    const rem = Number(n % BASE);
    out = (ALPHABET[rem] as string) + out;
    n /= BASE;
  }
  return out;
}

/** Decode a Base62 string back to a bigint. Throws on any character outside the alphabet. */
export function decodeBase62(code: string): bigint {
  if (code.length === 0) throw new RangeError('decodeBase62: empty string');
  let n = 0n;
  for (const ch of code) {
    const v = VALUE_OF.get(ch);
    if (v === undefined) throw new RangeError(`decodeBase62: invalid character ${JSON.stringify(ch)}`);
    n = n * BASE + v;
  }
  return n;
}

export function isValidBase62(code: string): boolean {
  if (code.length === 0) return false;
  for (const ch of code) {
    if (!VALUE_OF.has(ch)) return false;
  }
  return true;
}
