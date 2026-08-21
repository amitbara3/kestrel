/**
 * /api/links — the JSON API.
 *
 * Validation happens here, at the boundary, with Zod. Past this point data is
 * trusted and typed, so the service layer does not re-check it (Rules.md §3).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AppError } from '../core/errors.js';
import type { LinkService } from '../services/link-service.js';
import type { LinkRecord } from '../types.js';

const CreateBody = z.object({
  url: z.string().min(1, 'url is required').max(2048),
  alias: z.string().min(1).max(64).optional(),
  expiresIn: z.number().int().positive().optional(),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(256).optional(),
});

const CodeParams = z.object({
  code: z.string().min(1).max(64),
});

export interface LinksRouteOptions {
  service: LinkService;
  baseUrl: string;
}

export function registerLinkRoutes(app: FastifyInstance, options: LinksRouteOptions): void {
  const { service, baseUrl } = options;

  const present = (link: LinkRecord) => ({
    code: link.code,
    shortUrl: `${baseUrl}/${link.code}`,
    url: link.url,
    createdAt: new Date(link.createdAt).toISOString(),
    expiresAt: link.expiresAt === null ? null : new Date(link.expiresAt).toISOString(),
    clicks: link.clicks,
    lastAccessedAt: link.lastAccessedAt === null ? null : new Date(link.lastAccessedAt).toISOString(),
  });

  app.post('/api/links', { config: { rateLimitTier: 'write' } }, async (request, reply) => {
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) {
      throw AppError.validation(firstIssue(parsed.error), { issues: parsed.error.issues.length });
    }

    const link = await service.create({
      url: parsed.data.url,
      alias: parsed.data.alias,
      expiresIn: parsed.data.expiresIn,
    });

    return reply.status(201).send(present(link));
  });

  app.get('/api/links', { config: { rateLimitTier: 'read' } }, async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) throw AppError.validation(firstIssue(parsed.error));

    const page = await service.list({
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });

    return reply.send({
      items: page.items.map(present),
      nextCursor: page.nextCursor,
    });
  });

  app.get('/api/links/:code', { config: { rateLimitTier: 'read' } }, async (request, reply) => {
    const parsed = CodeParams.safeParse(request.params);
    if (!parsed.success) throw AppError.validation(firstIssue(parsed.error));

    // Reads through to the shard rather than the cache: this endpoint reports
    // the click count, which is buffered and would be stale in cache.
    const link = await service.get(parsed.data.code);
    return reply.send(present(link));
  });

  app.delete('/api/links/:code', { config: { rateLimitTier: 'write' } }, async (request, reply) => {
    const parsed = CodeParams.safeParse(request.params);
    if (!parsed.success) throw AppError.validation(firstIssue(parsed.error));

    await service.remove(parsed.data.code);
    return reply.status(204).send();
  });
}

/** Surface one clear message rather than dumping the whole Zod tree at a caller. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'Invalid request';
  const path = issue.path.join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}
