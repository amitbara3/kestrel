/**
 * Database driver selection. Same rule as the cache: the presence of
 * DATABASE_URL decides, and the choice is logged at boot.
 */

import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { DatabaseDriver } from './driver.js';
import { MemoryDriver } from './memory.js';
import { PostgresDriver } from './postgres.js';
import { ShardedStore } from './store.js';

export type { DatabaseDriver } from './driver.js';
export { MemoryDriver } from './memory.js';
export { PostgresDriver } from './postgres.js';
export { ShardRouter } from './shard-router.js';
export { ShardedStore } from './store.js';
export type { ListPage } from './store.js';

export async function createStore(config: Config, logger: Logger): Promise<ShardedStore> {
  let driver: DatabaseDriver;

  if (config.db.databaseUrl === undefined) {
    logger.warn('No DATABASE_URL set — using the in-process store', {
      driver: 'memory',
      consequence: 'data is lost on restart and is not shared between replicas',
    });
    driver = new MemoryDriver(config.db.shardCount);
  } else {
    // Comma-separated: one entry per physical server. Logical shards are spread
    // across them by `shard % serverCount` (see shard-router.ts).
    const urls = config.db.databaseUrl
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    driver = new PostgresDriver({
      urls,
      shardCount: config.db.shardCount,
      poolMax: config.db.poolMax,
      logger,
    });
    logger.info('Using PostgreSQL', {
      driver: 'postgres',
      logicalShards: config.db.shardCount,
      physicalServers: urls.length,
    });
  }

  const store = new ShardedStore(driver);
  await store.init();
  return store;
}
