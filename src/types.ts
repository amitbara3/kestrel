/** Shared domain types. Kept dependency-free so every layer can import them. */

export interface LinkRecord {
  /** Snowflake ID rendered as a decimal string — a bigint is not JSON-safe. */
  id: string;
  code: string;
  url: string;
  createdAt: number;
  expiresAt: number | null;
  clicks: number;
  lastAccessedAt: number | null;
}

export interface NewLink {
  id: string;
  code: string;
  url: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface ListOptions {
  limit: number;
  /** Cursor is `${createdAt}:${id}` — keyset pagination, stable under insert. */
  cursor?: string | undefined;
}

export interface ClickDelta {
  code: string;
  count: number;
  lastAccessedAt: number;
}

export interface ShardHealth {
  shard: number;
  healthy: boolean;
  error?: string;
}

export function isExpired(link: LinkRecord, now: number = Date.now()): boolean {
  return link.expiresAt !== null && link.expiresAt <= now;
}

/** Encode/decode the keyset cursor. Opaque to callers by intent, not by encryption. */
export function encodeCursor(link: LinkRecord): string {
  return Buffer.from(`${link.createdAt}:${link.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const idx = raw.indexOf(':');
    if (idx < 1) return null;
    const createdAt = Number(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (!Number.isFinite(createdAt) || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
