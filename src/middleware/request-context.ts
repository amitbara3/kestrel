/**
 * Request identity, client identity, access logging, and the error envelope.
 *
 * The client-IP resolution here is security-relevant: X-Forwarded-For is
 * attacker-controlled unless the peer is a proxy we put there ourselves. Taking
 * it unconditionally would let anyone reset their own rate limit by sending a
 * fresh header value (Rules.md §5).
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isAppError, statusOf, toEnvelope } from '../core/errors.js';
import type { Logger } from '../logger.js';
import type { Metrics } from './metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startTime: bigint;
    clientId: string;
  }
}

export interface TrustedProxy {
  contains(ip: string): boolean;
}

/** Parse `a.b.c.d/len` CIDRs once at boot; IPv6 entries match by literal or prefix. */
export function parseTrustedProxies(cidrs: string[]): TrustedProxy {
  const v4: { base: number; mask: number }[] = [];
  const v6: string[] = [];

  for (const entry of cidrs) {
    const [addr, bitsRaw] = entry.split('/');
    if (addr === undefined) continue;

    if (addr.includes(':')) {
      v6.push(addr.toLowerCase().replace(/::$/, ''));
      continue;
    }

    const octets = addr.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) continue;

    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;

    const base =
      (((octets[0] as number) << 24) |
        ((octets[1] as number) << 16) |
        ((octets[2] as number) << 8) |
        (octets[3] as number)) >>>
      0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    v4.push({ base: (base & mask) >>> 0, mask });
  }

  return {
    contains(ip: string): boolean {
      const normalised = ip.replace(/^::ffff:/i, '');
      if (normalised.includes(':')) {
        const lower = normalised.toLowerCase();
        return v6.some((prefix) => lower === prefix || lower.startsWith(prefix));
      }
      const octets = normalised.split('.').map(Number);
      if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) return false;
      const value =
        (((octets[0] as number) << 24) |
          ((octets[1] as number) << 16) |
          ((octets[2] as number) << 8) |
          (octets[3] as number)) >>>
        0;
      return v4.some(({ base, mask }) => ((value & mask) >>> 0) === base);
    },
  };
}

/**
 * The identity a rate limit is charged against.
 *
 * An API key wins when present: it is a stronger identity than an IP, and it
 * lets a legitimate integrator behind a shared NAT have its own budget.
 */
export function resolveClientId(request: FastifyRequest, trusted: TrustedProxy): string {
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return `apikey:${apiKey.slice(0, 64)}`;
  }

  const socketIp = request.socket.remoteAddress ?? '0.0.0.0';

  // Only believe the forwarded chain if the immediate peer is a proxy we trust.
  if (trusted.contains(socketIp)) {
    const forwarded = request.headers['x-forwarded-for'];
    const chain = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof chain === 'string' && chain.length > 0) {
      const client = chain.split(',')[0]?.trim();
      if (client !== undefined && client.length > 0) return `ip:${client}`;
    }
  }

  return `ip:${socketIp}`;
}

export interface RequestContextOptions {
  logger: Logger;
  metrics: Metrics;
  trustedProxies: string[];
}

/** Fastify's own errors are not AppErrors; read their message without assuming a type. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Bad request';
}

export function registerRequestContext(app: FastifyInstance, options: RequestContextOptions): void {
  const trusted = parseTrustedProxies(options.trustedProxies);

  app.decorateRequest('requestId', '');
  app.decorateRequest('startTime', 0n);
  app.decorateRequest('clientId', '');

  app.addHook('onRequest', async (request, reply) => {
    // 8 random bytes: enough to correlate a log line, cheaper than a UUID on
    // a path that runs thousands of times a second.
    request.requestId = randomBytes(8).toString('hex');
    request.startTime = process.hrtime.bigint();
    request.clientId = resolveClientId(request, trusted);
    reply.header('X-Request-Id', request.requestId);
  });

  app.addHook('onResponse', async (request, reply) => {
    const seconds = Number(process.hrtime.bigint() - request.startTime) / 1e9;
    // Route template, never the raw URL — a label per short code would explode
    // metric cardinality (metrics.ts).
    const route = request.routeOptions.url ?? 'unmatched';
    const labels = options.metrics.withInstance({
      route,
      method: request.method,
      status: String(reply.statusCode),
    });

    options.metrics.httpRequests.inc(labels);
    options.metrics.httpDuration.observe(seconds, options.metrics.withInstance({ route }));

    if (route !== '/metrics' && route !== '/health') {
      options.logger.debug('request', {
        requestId: request.requestId,
        method: request.method,
        route,
        status: reply.statusCode,
        durationMs: Math.round(seconds * 1e6) / 1e3,
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const status = statusOf(error);

    if (status >= 500) {
      // Full detail to the log, generic message to the client.
      options.logger.error('Unhandled request error', {
        requestId: request.requestId,
        route: request.routeOptions.url ?? request.url,
        error,
      });
    } else if (!isAppError(error)) {
      // Fastify's own 4xx (bad JSON, schema violations) — worth seeing at debug.
      options.logger.debug('Client error', {
        requestId: request.requestId,
        status,
        message: messageOf(error),
      });
    }

    // Fastify validation errors are not AppErrors; give them the same envelope
    // so a caller never has to parse two error shapes.
    if (!isAppError(error) && status < 500) {
      void reply.status(status).send({
        error: {
          code: 'BAD_REQUEST',
          message: messageOf(error),
          requestId: request.requestId,
        },
      });
      return;
    }

    void reply.status(status).send(toEnvelope(error, request.requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        requestId: request.requestId,
      },
    });
  });
}
