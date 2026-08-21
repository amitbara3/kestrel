/**
 * Entry point: build, listen, and drain cleanly.
 *
 * Graceful shutdown is what makes a rolling deploy lossless. On SIGTERM the
 * replica stops accepting connections, lets in-flight requests finish, flushes
 * the click buffer, then closes its pools — in that order. Exiting immediately
 * would drop up to one flush interval of counts on every deploy.
 *
 * This is the only file allowed to call process.exit (Rules.md §3).
 */

import { buildServer } from './server.js';
import { loadConfig } from './config.js';
import { createContainer, VERSION } from './container.js';
import { createLogger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const container = await createContainer(config);
  const app = await buildServer(container);
  const { logger } = container;

  await app.listen({ port: config.port, host: config.host });

  logger.info('Kestrel listening', {
    version: VERSION,
    url: `http://${config.host}:${config.port}`,
    baseUrl: config.baseUrl,
    env: config.env,
    cacheDriver: container.cache.name,
    dbDriver: container.store.driverName,
    shards: container.store.shardCount,
  });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second signal during a drain means "stop waiting", not "drain twice".
    if (shuttingDown) {
      logger.warn('Second signal received; exiting immediately', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info('Draining', { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });

    const forced = setTimeout(() => {
      logger.error('Drain timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forced.unref();

    try {
      await app.close(); // stop accepting, finish in-flight
      await container.shutdown(); // flush clicks, then close pools
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { error: err });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Log it
  // loudly and drain rather than continuing to serve from a corrupt one.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { error: reason });
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err });
    void shutdown('uncaughtException');
  });
}

main().catch((err: unknown) => {
  // The logger may not exist yet if config parsing failed, so build a minimal one.
  createLogger({ level: 'error' }).error('Failed to start', { error: err });
  process.exit(1);
});
