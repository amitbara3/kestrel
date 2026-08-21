/**
 * The gateway's rate limiter.
 *
 * Tiers exist because one limit cannot be right for both a write that costs a
 * database insert and a redirect that costs a cache read:
 *
 *   write     sliding window, strict   — exact, no boundary burst
 *   read      sliding window, generous
 *   redirect  token bucket             — bursts are legitimate here
 *   exempt    skipped                  — health and metrics must stay scrapable
 *
 * The limits are enforced in Redis, so N replicas share one budget. When Redis
 * is unavailable the limiter degrades to a per-replica in-process limiter
 * rather than failing open: a degraded limit is still a limit, and a 5xx here
 * would violate NFR-5.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CacheDriver, RateLimitResult } from '../cache/driver.js';
import { MemoryCache } from '../cache/memory.js';
import { AppError } from '../core/errors.js';
import type { Logger } from '../logger.js';
import type { Metrics } from './metrics.js';

export type RateLimitTier = 'write' | 'read' | 'redirect' | 'exempt';

declare module 'fastify' {
  interface FastifyContextConfig {
    rateLimitTier?: RateLimitTier;
  }
}

export interface RateLimitConfig {
  enabled: boolean;
  write: { max: number; windowMs: number };
  read: { max: number; windowMs: number };
  redirect: { capacity: number; refillPerSecond: number };
}

export interface RateLimitOptions {
  cache: CacheDriver;
  config: RateLimitConfig;
  metrics: Metrics;
  logger: Logger;
}

export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions): void {
  const { cache, config, metrics, logger } = options;

  // The degraded-mode limiter. Held for the process lifetime so its counters
  // survive across a Redis outage rather than resetting on every request.
  const localFallback = new MemoryCache({ maxKeys: 50_000 });
  let degradedLogged = false;

  async function evaluate(tier: RateLimitTier, clientId: string): Promise<RateLimitResult> {
    const key = `${tier}:${clientId}`;

    const run = (driver: CacheDriver): Promise<RateLimitResult> =>
      tier === 'redirect'
        ? driver.tokenBucket(key, config.redirect.capacity, config.redirect.refillPerSecond)
        : tier === 'write'
          ? driver.slidingWindow(key, config.write.max, config.write.windowMs)
          : driver.slidingWindow(key, config.read.max, config.read.windowMs);

    try {
      return await run(cache);
    } catch (err) {
      // Only a genuine dependency failure degrades; anything else is a bug and
      // should surface rather than silently loosen the limit.
      if (!(err instanceof AppError) || err.code !== 'DEPENDENCY_UNAVAILABLE') throw err;

      if (!degradedLogged) {
        logger.warn('Rate limiting degraded to per-replica counters', {
          reason: 'cache unavailable',
          consequence: 'effective limit is multiplied by the replica count',
        });
        degradedLogged = true;
      }
      return run(localFallback);
    }
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const tier: RateLimitTier = request.routeOptions.config?.rateLimitTier ?? 'read';
    if (!config.enabled || tier === 'exempt') return;

    const result = await evaluate(tier, request.clientId);

    // Headers go on every response, not just rejections — an integrator can
    // then back off before being told to (PRD.md FR-6).
    reply.header('X-RateLimit-Limit', String(result.limit));
    reply.header('X-RateLimit-Remaining', String(result.remaining));
    reply.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    if (result.allowed) return;

    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    reply.header('Retry-After', String(retryAfterSeconds));
    metrics.rateLimitRejections.inc(metrics.withInstance({ tier }));

    throw new AppError('RATE_LIMITED', 'Too many requests', {
      details: { tier, retryAfterSeconds },
    });
  });
}
