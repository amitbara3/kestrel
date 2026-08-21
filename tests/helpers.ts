/**
 * Test harness.
 *
 * Builds a full container on the in-process drivers, so integration tests
 * exercise the real routes, hooks, service, and cache tiers with no external
 * service and no listening socket.
 */

import type { FastifyInstance } from 'fastify';

import { loadConfig } from '../src/config.js';
import type { Config } from '../src/config.js';
import { createContainer } from '../src/container.js';
import type { Container } from '../src/container.js';
import { buildServer } from '../src/server.js';

export interface Harness {
  app: FastifyInstance;
  container: Container;
  config: Config;
  close(): Promise<void>;
}

export async function buildHarness(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    BASE_URL: 'http://localhost:3000',
    SHARD_COUNT: '4',
    // Long enough that a test never trips a limit it did not mean to.
    RATE_LIMIT_WRITE_MAX: '1000',
    RATE_LIMIT_READ_MAX: '1000',
    RATE_LIMIT_REDIRECT_CAPACITY: '1000',
    ANALYTICS_FLUSH_INTERVAL_MS: '100',
    ...env,
  } as NodeJS.ProcessEnv);

  const container = await createContainer(config);
  const app = await buildServer(container);
  await app.ready();

  return {
    app,
    container,
    config,
    async close() {
      await app.close();
      await container.shutdown();
    },
  };
}

export async function createLink(
  app: FastifyInstance,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/links',
    payload: body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
