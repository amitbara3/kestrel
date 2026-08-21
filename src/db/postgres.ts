/**
 * PostgreSQL DatabaseDriver — the production implementation.
 *
 * Sharding is two-level on purpose:
 *   logical shard  = one table, `links_<n>`, chosen by fnv1a(code) % SHARD_COUNT
 *   physical shard = one server, chosen by logicalShard % serverCount
 *
 * Separating them is what lets the cluster grow servers without re-hashing a
 * single row: eight logical shards can sit on one server today and eight
 * servers tomorrow, and every code still routes to the same table.
 *
 * Timestamps are stored as BIGINT epoch milliseconds rather than TIMESTAMPTZ.
 * That is a deliberate trade: it costs the readable type in psql, and it buys
 * an exact round trip with the JS domain type plus no timezone semantics on a
 * value that is only ever compared, never displayed by the database.
 */

import pg from 'pg';

import { AppError } from '../core/errors.js';
import type { Logger } from '../logger.js';
import type { ClickDelta, LinkRecord, ListOptions, NewLink, ShardHealth } from '../types.js';
import { decodeCursor } from '../types.js';
import type { DatabaseDriver } from './driver.js';

const { Pool } = pg;

/** Postgres unique_violation — the alias race resolved by the database, not by us. */
const UNIQUE_VIOLATION = '23505';

export interface PostgresDriverOptions {
  /** One or more connection strings, comma-separated in config. */
  urls: string[];
  shardCount: number;
  poolMax: number;
  logger: Logger;
  statementTimeoutMs?: number;
}

interface Row {
  id: string;
  code: string;
  url: string;
  created_at: string;
  expires_at: string | null;
  clicks: string;
  last_accessed_at: string | null;
}

export class PostgresDriver implements DatabaseDriver {
  readonly name = 'postgres';
  readonly shardCount: number;

  private readonly pools: pg.Pool[];
  private readonly logger: Logger;

  constructor(options: PostgresDriverOptions) {
    if (options.urls.length === 0) throw new Error('PostgresDriver requires at least one URL');
    this.shardCount = options.shardCount;
    this.logger = options.logger;

    this.pools = options.urls.map(
      (connectionString) =>
        new Pool({
          connectionString,
          max: options.poolMax,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          // Bound every query so a lock or a bad plan cannot pin a request forever (Rules.md §4).
          statement_timeout: options.statementTimeoutMs ?? 5_000,
        }),
    );

    for (const pool of this.pools) {
      pool.on('error', (err: Error) => {
        this.logger.debug('Idle Postgres client error', { error: err.message });
      });
    }
  }

  /** Idempotent DDL, so a fresh replica can boot against an empty database. */
  async init(): Promise<void> {
    for (let shard = 0; shard < this.shardCount; shard++) {
      const table = this.table(shard);
      await this.query(
        shard,
        `CREATE TABLE IF NOT EXISTS ${table} (
           id               BIGINT PRIMARY KEY,
           code             TEXT   NOT NULL,
           url              TEXT   NOT NULL,
           created_at       BIGINT NOT NULL,
           expires_at       BIGINT,
           clicks           BIGINT NOT NULL DEFAULT 0,
           last_accessed_at BIGINT
         )`,
      );
      // The redirect lookup. Unique also makes an alias race resolve atomically.
      await this.query(
        shard,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_code_uidx ON ${table} (code)`,
      );
      // Keyset pagination for list; matches the ORDER BY exactly so it is index-only.
      await this.query(
        shard,
        `CREATE INDEX IF NOT EXISTS ${table}_created_idx ON ${table} (created_at DESC, id DESC)`,
      );
      // Partial: expiry reaping scans only rows that can expire.
      await this.query(
        shard,
        `CREATE INDEX IF NOT EXISTS ${table}_expires_idx ON ${table} (expires_at) WHERE expires_at IS NOT NULL`,
      );
    }
    this.logger.info('Postgres schema ready', {
      shards: this.shardCount,
      servers: this.pools.length,
    });
  }

  async insert(shard: number, link: NewLink): Promise<LinkRecord> {
    try {
      const res = await this.query<Row>(
        shard,
        `INSERT INTO ${this.table(shard)} (id, code, url, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code, url, created_at, expires_at, clicks, last_accessed_at`,
        [link.id, link.code, link.url, link.createdAt, link.expiresAt],
      );
      const row = res.rows[0];
      if (row === undefined) throw AppError.internal('INSERT returned no row');
      return toRecord(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError('ALIAS_TAKEN', `Code "${link.code}" is already in use`, {
          details: { code: link.code },
          cause: err,
        });
      }
      throw wrap(err, 'insert');
    }
  }

  async findByCode(shard: number, code: string): Promise<LinkRecord | null> {
    try {
      const res = await this.query<Row>(
        shard,
        `SELECT id, code, url, created_at, expires_at, clicks, last_accessed_at
           FROM ${this.table(shard)} WHERE code = $1`,
        [code],
      );
      const row = res.rows[0];
      return row === undefined ? null : toRecord(row);
    } catch (err) {
      throw wrap(err, 'findByCode');
    }
  }

  async deleteByCode(shard: number, code: string): Promise<boolean> {
    try {
      const res = await this.query(shard, `DELETE FROM ${this.table(shard)} WHERE code = $1`, [code]);
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      throw wrap(err, 'deleteByCode');
    }
  }

  async listShard(shard: number, options: ListOptions): Promise<LinkRecord[]> {
    const cursor =
      options.cursor !== undefined && options.cursor !== '' ? decodeCursor(options.cursor) : null;
    try {
      // Row-value comparison matches the composite index, so this is a range
      // scan rather than the OFFSET scan a naive paginator would produce.
      const res = await this.query<Row>(
        shard,
        `SELECT id, code, url, created_at, expires_at, clicks, last_accessed_at
           FROM ${this.table(shard)}
          WHERE $1::bigint IS NULL
             OR (created_at, id) < ($1::bigint, $2::bigint)
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, options.limit],
      );
      return res.rows.map(toRecord);
    } catch (err) {
      throw wrap(err, 'listShard');
    }
  }

  /**
   * One statement for the whole batch. A per-click UPDATE would put a write on
   * the redirect path; this puts one round trip on a 5-second timer instead.
   */
  async incrementClicks(shard: number, deltas: ClickDelta[]): Promise<void> {
    if (deltas.length === 0) return;

    const values: unknown[] = [];
    const tuples = deltas.map((delta, i) => {
      const base = i * 3;
      values.push(delta.code, delta.count, delta.lastAccessedAt);
      return `($${base + 1}::text, $${base + 2}::bigint, $${base + 3}::bigint)`;
    });

    try {
      await this.query(
        shard,
        `UPDATE ${this.table(shard)} AS l
            SET clicks = l.clicks + v.count,
                last_accessed_at = GREATEST(COALESCE(l.last_accessed_at, 0), v.ts)
           FROM (VALUES ${tuples.join(', ')}) AS v(code, count, ts)
          WHERE l.code = v.code`,
        values,
      );
    } catch (err) {
      throw wrap(err, 'incrementClicks');
    }
  }

  async countShard(shard: number): Promise<number> {
    const res = await this.query<{ count: string }>(
      shard,
      `SELECT COUNT(*)::text AS count FROM ${this.table(shard)}`,
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async ping(): Promise<ShardHealth[]> {
    return Promise.all(
      Array.from({ length: this.shardCount }, async (_, shard): Promise<ShardHealth> => {
        try {
          await this.query(shard, 'SELECT 1');
          return { shard, healthy: true };
        } catch (err) {
          return { shard, healthy: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  async close(): Promise<void> {
    await Promise.all(this.pools.map((p) => p.end().catch(() => undefined)));
  }

  /**
   * Table name is built from a validated integer, never from input — the one
   * place identifier interpolation is safe, and it is bounded here (Rules.md §5).
   */
  private table(shard: number): string {
    if (!Number.isInteger(shard) || shard < 0 || shard >= this.shardCount) {
      throw new RangeError(`shard ${shard} out of range (shardCount=${this.shardCount})`);
    }
    return `links_${shard}`;
  }

  private poolFor(shard: number): pg.Pool {
    const pool = this.pools[shard % this.pools.length];
    if (pool === undefined) throw AppError.internal('No pool for shard');
    return pool;
  }

  private async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    shard: number,
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    return this.poolFor(shard).query<T>(text, params);
  }
}

function toRecord(row: Row): LinkRecord {
  return {
    id: row.id,
    code: row.code,
    url: row.url,
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    clicks: Number(row.clicks),
    lastAccessedAt: row.last_accessed_at === null ? null : Number(row.last_accessed_at),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/** Driver text never reaches a client; it goes in `cause` for the logger. */
function wrap(err: unknown, operation: string): AppError {
  if (err instanceof AppError) return err;
  return AppError.unavailable('database', new Error(`${operation}: ${err instanceof Error ? err.message : String(err)}`));
}
