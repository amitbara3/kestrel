import { hostname } from 'node:os';
import { z } from 'zod';

import { fnv1a32 } from './core/hash.js';

/**
 * The single place `process.env` is read (Rules.md §7).
 *
 * Every field has a default that works with zero environment variables set, so
 * `npm start` on a clean machine boots on the in-process drivers. Supplying
 * REDIS_URL / DATABASE_URL is what promotes the service to its production
 * drivers — there is no separate "mode" flag to get out of sync.
 */

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? dflt : v === 'true' || v === '1'));

const int = (dflt: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  BASE_URL: z.string().url().default('http://localhost:3000'),
  NODE_ID: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
    .pipe(z.number().int().min(0).max(1023).optional()),

  REDIS_URL: z.string().optional(),
  REDIS_KEY_PREFIX: z.string().default('kestrel:'),
  CACHE_TTL_SECONDS: int(3600, 1),
  NEGATIVE_CACHE_TTL_SECONDS: int(60, 1),
  L1_MAX_ENTRIES: int(10_000, 0),
  L1_TTL_SECONDS: int(30, 0),

  DATABASE_URL: z.string().optional(),
  SHARD_COUNT: int(4, 1, 64),
  PG_POOL_MAX: int(10, 1, 200),

  RATE_LIMIT_ENABLED: bool(true),
  RATE_LIMIT_WRITE_MAX: int(20, 1),
  RATE_LIMIT_WRITE_WINDOW_MS: int(60_000, 100),
  RATE_LIMIT_READ_MAX: int(120, 1),
  RATE_LIMIT_READ_WINDOW_MS: int(60_000, 100),
  RATE_LIMIT_REDIRECT_CAPACITY: int(200, 1),
  RATE_LIMIT_REDIRECT_REFILL_PER_SEC: int(50, 1),
  TRUSTED_PROXIES: z
    .string()
    .default('127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'),

  ANALYTICS_FLUSH_INTERVAL_MS: int(5_000, 100),
  ANALYTICS_BUFFER_MAX: int(10_000, 1),
});

export type Config = Readonly<{
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  baseUrl: string;
  nodeId: number;
  instanceId: string;

  cache: {
    redisUrl: string | undefined;
    keyPrefix: string;
    ttlSeconds: number;
    negativeTtlSeconds: number;
    l1MaxEntries: number;
    l1TtlSeconds: number;
  };

  db: {
    databaseUrl: string | undefined;
    shardCount: number;
    poolMax: number;
  };

  rateLimit: {
    enabled: boolean;
    write: { max: number; windowMs: number };
    read: { max: number; windowMs: number };
    redirect: { capacity: number; refillPerSecond: number };
    trustedProxies: string[];
  };

  analytics: {
    flushIntervalMs: number;
    bufferMax: number;
  };
}>;

/**
 * Derive a Snowflake node ID when the operator has not pinned one.
 *
 * Hashing the hostname means container replicas get distinct IDs with no
 * coordination and no config change on scale-up. Collisions are possible in
 * principle (1024 slots); NODE_ID exists to pin them when that matters.
 */
function deriveNodeId(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  return fnv1a32(hostname() || 'localhost') % 1024;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  const nodeId = deriveNodeId(e.NODE_ID);

  return Object.freeze({
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    baseUrl: e.BASE_URL.replace(/\/+$/, ''),
    nodeId,
    instanceId: `${hostname() || 'local'}-${nodeId}`,

    cache: {
      redisUrl: e.REDIS_URL || undefined,
      keyPrefix: e.REDIS_KEY_PREFIX,
      ttlSeconds: e.CACHE_TTL_SECONDS,
      negativeTtlSeconds: e.NEGATIVE_CACHE_TTL_SECONDS,
      l1MaxEntries: e.L1_MAX_ENTRIES,
      l1TtlSeconds: e.L1_TTL_SECONDS,
    },

    db: {
      databaseUrl: e.DATABASE_URL || undefined,
      shardCount: e.SHARD_COUNT,
      poolMax: e.PG_POOL_MAX,
    },

    rateLimit: {
      enabled: e.RATE_LIMIT_ENABLED,
      write: { max: e.RATE_LIMIT_WRITE_MAX, windowMs: e.RATE_LIMIT_WRITE_WINDOW_MS },
      read: { max: e.RATE_LIMIT_READ_MAX, windowMs: e.RATE_LIMIT_READ_WINDOW_MS },
      redirect: {
        capacity: e.RATE_LIMIT_REDIRECT_CAPACITY,
        refillPerSecond: e.RATE_LIMIT_REDIRECT_REFILL_PER_SEC,
      },
      trustedProxies: e.TRUSTED_PROXIES.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },

    analytics: {
      flushIntervalMs: e.ANALYTICS_FLUSH_INTERVAL_MS,
      bufferMax: e.ANALYTICS_BUFFER_MAX,
    },
  });
}
