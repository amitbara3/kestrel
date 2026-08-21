/**
 * Fastify application factory.
 *
 * Pure with respect to I/O: it takes a built container and returns a
 * configured app without listening. That is what lets the integration tests
 * drive every route through `app.inject()` with no socket and no port
 * (Rules.md §6).
 *
 * Hook order matters and is the gateway pipeline:
 *   request-context (ID, client identity, timer)  ->  rate limit  ->  handler
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { Container } from './container.js';
import { VERSION } from './container.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import { registerRequestContext } from './middleware/request-context.js';
import { registerLinkRoutes } from './routes/links.js';
import { registerRedirectRoute } from './routes/redirect.js';
import { registerSystemRoutes } from './routes/system.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildServer(container: Container): Promise<FastifyInstance> {
  const { config, logger, metrics, cache, store, service, clicks } = container;

  const app = Fastify({
    // We run our own structured logger; Fastify's would duplicate every line.
    logger: false,
    // The load balancer terminates the connection, so trust is decided by our
    // own CIDR check in request-context.ts, not by Fastify's blanket flag.
    trustProxy: false,
    bodyLimit: 64 * 1024,
    // A short code is a single path segment; anything longer is not a link.
    routerOptions: { maxParamLength: 64 },
  });

  registerRequestContext(app, {
    logger,
    metrics,
    trustedProxies: config.rateLimit.trustedProxies,
  });

  registerRateLimit(app, {
    cache,
    config: config.rateLimit,
    metrics,
    logger,
  });

  registerSystemRoutes(app, {
    cache,
    store,
    metrics,
    instanceId: config.instanceId,
    version: VERSION,
    startedAt: container.startedAt,
  });

  registerLinkRoutes(app, { service, baseUrl: config.baseUrl });

  // The UI is served at exactly "/" so it cannot shadow the `/:code` route.
  await app.register(fastifyStatic, {
    root: join(here, 'public'),
    prefix: '/',
    index: ['index.html'],
    serve: false,
  });

  app.get('/', { config: { rateLimitTier: 'read' } }, async (_request, reply) =>
    reply.sendFile('index.html'),
  );

  // Registered last: `/:code` is a catch-all for single-segment paths and would
  // otherwise shadow every literal route above it.
  registerRedirectRoute(app, { service, clicks, metrics });

  return app;
}
