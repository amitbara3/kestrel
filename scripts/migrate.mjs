#!/usr/bin/env node
/**
 * Provision the shard schema ahead of a deploy.
 *
 * The application also creates its tables idempotently at boot, so this is a
 * convenience for CI and for provisioning a database the app has not seen yet —
 * not a step the service depends on.
 *
 *   DATABASE_URL=postgres://... SHARD_COUNT=8 npm run migrate
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const SHARD_COUNT = Number(process.env.SHARD_COUNT ?? 4);

if (!DATABASE_URL) {
  process.stderr.write('DATABASE_URL is required.\n');
  process.exit(1);
}
if (!Number.isInteger(SHARD_COUNT) || SHARD_COUNT < 1 || SHARD_COUNT > 64) {
  process.stderr.write(`SHARD_COUNT must be an integer in [1, 64], got ${SHARD_COUNT}\n`);
  process.exit(1);
}

// Comma-separated: one entry per physical server. Logical shard i lives on
// server i % servers.length, matching src/db/shard-router.ts.
const urls = DATABASE_URL.split(',').map((s) => s.trim()).filter(Boolean);
const pools = urls.map((connectionString) => new pg.Pool({ connectionString, max: 2 }));

function ddl(shard) {
  const t = `links_${shard}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${t} (
       id               BIGINT PRIMARY KEY,
       code             TEXT   NOT NULL,
       url              TEXT   NOT NULL,
       created_at       BIGINT NOT NULL,
       expires_at       BIGINT,
       clicks           BIGINT NOT NULL DEFAULT 0,
       last_accessed_at BIGINT
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${t}_code_uidx ON ${t} (code)`,
    `CREATE INDEX IF NOT EXISTS ${t}_created_idx ON ${t} (created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS ${t}_expires_idx ON ${t} (expires_at) WHERE expires_at IS NOT NULL`,
  ];
}

try {
  for (let shard = 0; shard < SHARD_COUNT; shard++) {
    const pool = pools[shard % pools.length];
    for (const statement of ddl(shard)) {
      await pool.query(statement);
    }
    process.stdout.write(`shard ${shard} -> links_${shard} on server ${shard % pools.length}\n`);
  }
  process.stdout.write(`\n${SHARD_COUNT} logical shards ready across ${pools.length} server(s).\n`);
} catch (err) {
  process.stderr.write(`Migration failed: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
}
