/**
 * End-to-end route tests through Fastify's inject() — real hooks, real service,
 * real cache tiers, no socket and no external dependency.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildHarness, createLink } from './helpers.js';
import type { Harness } from './helpers.js';

describe('API', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  describe('POST /api/links', () => {
    it('creates a link and returns 201 with a short URL', async () => {
      const res = await createLink(h.app, { url: 'https://example.com/some/path' });
      expect(res.statusCode).toBe(201);

      const body = res.json();
      expect(body.url).toBe('https://example.com/some/path');
      expect(body.shortUrl).toBe(`http://localhost:3000/${body.code}`);
      expect(body.code).toMatch(/^[0-9A-Za-z]+$/);
      expect(body.expiresAt).toBeNull();
      expect(body.clicks).toBe(0);
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('accepts a custom alias', async () => {
      const res = await createLink(h.app, { url: 'https://example.com', alias: 'my-Link_1' });
      expect(res.statusCode).toBe(201);
      expect(res.json().code).toBe('my-Link_1');
    });

    it('rejects a duplicate alias with 409', async () => {
      await createLink(h.app, { url: 'https://example.com', alias: 'taken-one' });
      const res = await createLink(h.app, { url: 'https://other.com', alias: 'taken-one' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ALIAS_TAKEN');
    });

    it('rejects a reserved alias with 409', async () => {
      const res = await createLink(h.app, { url: 'https://example.com', alias: 'metrics' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('RESERVED_ALIAS');
    });

    it('rejects a malformed alias with 422', async () => {
      const res = await createLink(h.app, { url: 'https://example.com', alias: 'no spaces' });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a dangerous scheme with 422', async () => {
      const res = await createLink(h.app, { url: 'javascript:alert(1)' });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('UNSAFE_URL');
    });

    it('rejects a missing url with 422', async () => {
      const res = await createLink(h.app, {});
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toContain('url');
    });

    it('rejects a negative expiry with 422', async () => {
      const res = await createLink(h.app, { url: 'https://example.com', expiresIn: -5 });
      expect(res.statusCode).toBe(422);
    });

    it('returns the standard error envelope on every failure', async () => {
      const res = await createLink(h.app, { url: 'javascript:alert(1)' });
      const body = res.json();
      expect(Object.keys(body)).toEqual(['error']);
      expect(body.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
      expect(body.error.requestId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('blocks private hosts when running as production', async () => {
      const prod = await buildHarness({ NODE_ENV: 'production' });
      try {
        const res = await createLink(prod.app, { url: 'http://169.254.169.254/latest/meta-data/' });
        expect(res.statusCode).toBe(422);
        expect(res.json().error.code).toBe('UNSAFE_URL');
      } finally {
        await prod.close();
      }
    });
  });

  describe('GET /:code', () => {
    it('redirects with 302 to the target', async () => {
      const created = await createLink(h.app, { url: 'https://example.com/target' });
      const { code } = created.json();

      const res = await h.app.inject({ method: 'GET', url: `/${code}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://example.com/target');
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('answers from L1 once the create has written through', async () => {
      const created = await createLink(h.app, { url: 'https://example.com/tiered' });
      const { code } = created.json();

      const res = await h.app.inject({ method: 'GET', url: `/${code}` });
      expect(res.headers['x-cache']).toBe('L1');
    });

    it('falls through to L2 when L1 is disabled by config', async () => {
      const noL1 = await buildHarness({ L1_TTL_SECONDS: '0' });
      try {
        const created = await createLink(noL1.app, { url: 'https://example.com/l2' });
        const { code } = created.json();

        const res = await noL1.app.inject({ method: 'GET', url: `/${code}` });
        expect(res.statusCode).toBe(302);
        expect(res.headers['x-cache']).toBe('L2');
      } finally {
        await noL1.close();
      }
    });

    it('returns 404 for an unknown code', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/doesnotexist' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for a structurally invalid code without any lookup', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/a'.repeat(200) });
      expect([404, 414]).toContain(res.statusCode);
    });

    it('returns 410 once a link has expired', async () => {
      const created = await createLink(h.app, { url: 'https://example.com/short', expiresIn: 1 });
      const { code } = created.json();

      expect((await h.app.inject({ method: 'GET', url: `/${code}` })).statusCode).toBe(302);

      await new Promise((r) => setTimeout(r, 1100));
      const res = await h.app.inject({ method: 'GET', url: `/${code}` });
      expect(res.statusCode).toBe(410);
    });

    it('serves an HTML page to a browser and JSON to an API client', async () => {
      const html = await h.app.inject({
        method: 'GET',
        url: '/nosuchcode',
        headers: { accept: 'text/html' },
      });
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.body).toContain('404');

      const json = await h.app.inject({
        method: 'GET',
        url: '/nosuchcode',
        headers: { accept: 'application/json' },
      });
      expect(json.headers['content-type']).toContain('application/json');
      expect(json.json().error.code).toBe('NOT_FOUND');
    });

    it('counts clicks asynchronously without delaying the redirect', async () => {
      const created = await createLink(h.app, { url: 'https://example.com/counted' });
      const { code } = created.json();

      for (let i = 0; i < 5; i++) await h.app.inject({ method: 'GET', url: `/${code}` });

      // The count is not visible until the buffer flushes — that is the trade.
      await h.container.clicks.flush();

      const meta = await h.app.inject({ method: 'GET', url: `/api/links/${code}` });
      expect(meta.json().clicks).toBe(5);
      expect(meta.json().lastAccessedAt).not.toBeNull();
    });
  });

  describe('GET /api/links/:code', () => {
    it('returns metadata without counting a click', async () => {
      const created = await createLink(h.app, { url: 'https://example.com/meta' });
      const { code } = created.json();

      await h.app.inject({ method: 'GET', url: `/api/links/${code}` });
      await h.container.clicks.flush();

      const res = await h.app.inject({ method: 'GET', url: `/api/links/${code}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().clicks).toBe(0);
    });

    it('returns 404 for an unknown code', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/api/links/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/links', () => {
    it('lists newest first and paginates by cursor', async () => {
      for (let i = 0; i < 7; i++) {
        await createLink(h.app, { url: `https://example.com/${i}` });
      }

      const first = await h.app.inject({ method: 'GET', url: '/api/links?limit=3' });
      expect(first.statusCode).toBe(200);
      expect(first.json().items).toHaveLength(3);
      expect(first.json().nextCursor).toBeTruthy();

      const second = await h.app.inject({
        method: 'GET',
        url: `/api/links?limit=3&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      });
      const firstCodes = first.json().items.map((i: { code: string }) => i.code);
      const secondCodes = second.json().items.map((i: { code: string }) => i.code);
      expect(secondCodes.some((c: string) => firstCodes.includes(c))).toBe(false);
    });

    it('rejects an over-large limit', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/api/links?limit=5000' });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('DELETE /api/links/:code', () => {
    it('deletes and evicts from every cache tier', async () => {
      const created = await createLink(h.app, { url: 'https://example.com/deleteme' });
      const { code } = created.json();

      // Warm every tier first, so this proves invalidation rather than a cold miss.
      expect((await h.app.inject({ method: 'GET', url: `/${code}` })).statusCode).toBe(302);

      const del = await h.app.inject({ method: 'DELETE', url: `/api/links/${code}` });
      expect(del.statusCode).toBe(204);

      expect((await h.app.inject({ method: 'GET', url: `/${code}` })).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'GET', url: `/api/links/${code}` })).statusCode).toBe(404);
    });

    it('returns 404 when the code does not exist', async () => {
      const res = await h.app.inject({ method: 'DELETE', url: '/api/links/absent' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('system routes', () => {
    it('reports liveness', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    });

    it('reports readiness with per-dependency detail', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.status).toBe('ready');
      expect(body.dependencies.database).toMatchObject({ status: 'up', required: true });
      expect(body.dependencies.cache).toMatchObject({ status: 'up', required: false });
    });

    it('exposes valid Prometheus text', async () => {
      await createLink(h.app, { url: 'https://example.com/metrics-probe' });

      const res = await h.app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');

      const body = res.body;
      expect(body).toContain('# HELP kestrel_http_requests_total');
      expect(body).toContain('# TYPE kestrel_http_requests_total counter');
      expect(body).toContain('kestrel_links_created_total');
      expect(body).toContain('kestrel_http_request_duration_seconds_bucket');

      // Every non-comment line must be `name{labels} value`.
      for (const line of body.split('\n').filter((l) => l && !l.startsWith('#'))) {
        expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? -?[0-9.e+]+$/);
      }
    });

    it('reports shard distribution', async () => {
      for (let i = 0; i < 40; i++) await createLink(h.app, { url: `https://example.com/s${i}` });

      const res = await h.app.inject({ method: 'GET', url: '/api/shards' });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.shardCount).toBe(4);
      expect(body.total).toBe(40);
      expect(body.shards).toHaveLength(4);
      // Hash routing should touch every shard rather than piling onto one.
      expect(body.shards.every((s: { count: number }) => s.count > 0)).toBe(true);
    });

    it('serves the web UI at the root', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('returns the error envelope for an unmatched route', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/deep/nested/path' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('rate limiting', () => {
    it('emits limit headers on every response', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/api/links' });
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('does not limit health or metrics', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/health' });
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });

    // The headline guarantee: N requests against a limit of M yields exactly M.
    it('admits exactly the configured number of writes, then 429s', async () => {
      const limited = await buildHarness({
        RATE_LIMIT_WRITE_MAX: '5',
        RATE_LIMIT_WRITE_WINDOW_MS: '60000',
      });
      try {
        const results = [];
        for (let i = 0; i < 12; i++) {
          results.push(await createLink(limited.app, { url: `https://example.com/rl${i}` }));
        }

        expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
        expect(results.filter((r) => r.statusCode === 429)).toHaveLength(7);

        const rejected = results.find((r) => r.statusCode === 429)!;
        expect(rejected.json().error.code).toBe('RATE_LIMITED');
        expect(Number(rejected.headers['retry-after'])).toBeGreaterThan(0);
        expect(rejected.headers['x-ratelimit-remaining']).toBe('0');
      } finally {
        await limited.close();
      }
    });

    it('charges an API key its own budget, separate from the IP', async () => {
      const limited = await buildHarness({ RATE_LIMIT_WRITE_MAX: '2' });
      try {
        const key = { 'x-api-key': 'client-alpha' };
        await createLink(limited.app, { url: 'https://example.com/a' }, key);
        await createLink(limited.app, { url: 'https://example.com/b' }, key);
        const third = await createLink(limited.app, { url: 'https://example.com/c' }, key);
        expect(third.statusCode).toBe(429);

        // A different key still has its full budget.
        const other = await createLink(
          limited.app,
          { url: 'https://example.com/d' },
          { 'x-api-key': 'client-beta' },
        );
        expect(other.statusCode).toBe(201);
      } finally {
        await limited.close();
      }
    });

    it('allows a burst on the redirect tier', async () => {
      const burst = await buildHarness({
        RATE_LIMIT_REDIRECT_CAPACITY: '10',
        RATE_LIMIT_REDIRECT_REFILL_PER_SEC: '1',
      });
      try {
        const created = await createLink(burst.app, { url: 'https://example.com/burst' });
        const { code } = created.json();

        const results = await Promise.all(
          Array.from({ length: 15 }, () => burst.app.inject({ method: 'GET', url: `/${code}` })),
        );

        expect(results.filter((r) => r.statusCode === 302).length).toBe(10);
        expect(results.filter((r) => r.statusCode === 429).length).toBe(5);
      } finally {
        await burst.close();
      }
    });
  });
});
