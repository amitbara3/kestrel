# PRD — Kestrel

**A scalable URL shortener and rate-limited API gateway.**

| Field | Value |
| --- | --- |
| Product name | Kestrel |
| Version | 1.0 |
| Status | In development |
| Last updated | 2026-08-22 |

---

## 1. Summary

Kestrel is a horizontally scalable HTTP service that does two things:

1. **URL shortening** — turn a long URL into a short code (`/aB3xK9`) and redirect on lookup.
2. **API gateway concerns** — every request passes through a distributed rate limiter, request-ID tagging, and metrics collection before it reaches a handler.

The point of the project is to make classic system-design theory concrete and runnable: cache-aside with Redis, negative caching, cache-stampede prevention, atomic distributed rate limiting, hash-based database sharding, and N stateless app replicas behind a load balancer.

## 2. Problem statement

A URL shortener is read-dominated: the write path (create a link) runs maybe once, and the read path (redirect) runs thousands of times for the same row. A naive implementation hits the database on every redirect and falls over well before it should.

Separately, any public endpoint that creates rows is an abuse target. Rate limiting that lives in a single process is useless the moment you run more than one process — two replicas each allowing 100 req/min means the real limit is 200.

Kestrel solves both, and is structured so the solutions are legible to a reader rather than buried in a framework.

## 3. Goals

### 3.1 In scope

- Create, read, list, and delete short links over a JSON API.
- HTTP redirect on the short code with sub-millisecond cache hits.
- Custom aliases and per-link expiry.
- Distributed rate limiting shared correctly across every replica.
- Redis cache-aside with negative caching and single-flight stampede protection.
- Hash-based sharding across N logical database shards.
- Asynchronous click analytics that never block a redirect.
- Prometheus-format metrics and health/readiness probes.
- Stateless replicas behind Nginx, brought up with one `docker compose up`.
- A minimal web UI to create and inspect links.

### 3.2 Out of scope (v1)

- User accounts, OAuth, or a multi-tenant billing model. API keys identify callers; there is no signup flow.
- Link editing after creation (delete and recreate instead).
- Geographic/device breakdowns in analytics — click counts and last-seen timestamps only.
- Automatic shard rebalancing. Shard count is fixed at deploy time; changing it requires a migration.
- Custom domains per link.

## 4. Target users

| User | What they need | How Kestrel serves it |
| --- | --- | --- |
| **Backend engineer studying system design** | A readable reference implementation where each technique is isolated and named, not tangled into a framework | Every technique lives in its own module with a doc comment explaining the tradeoff; `Architecture.md` maps theory to file |
| **Hiring manager / interviewer** | Evidence the candidate can reason about caching, sharding, and throughput, not just wire up a CRUD app | Load-test script with published numbers, metrics endpoint, and an explicit failure-mode table |
| **API consumer (integrator)** | A predictable JSON API with honest rate-limit headers and stable error shapes | `X-RateLimit-*` headers on every response, one documented error envelope |
| **End user clicking a link** | The redirect resolves instantly and never dead-ends | p99 redirect under 25 ms; expired and unknown codes return a real 404/410 page, not a stack trace |

## 5. Functional requirements

### FR-1 — Create a short link

`POST /api/links` accepts a JSON body with `url` (required), optional `alias`, and optional `expiresIn` (seconds).

- The URL is validated: it must parse, must be `http` or `https`, and must not target a private/loopback/link-local host (SSRF and internal-redirect defence).
- Without an alias, the code is derived from a distributed unique ID (see FR-8) rendered in Base62 — no collision-check round trip needed.
- With an alias, the alias must be 3–32 chars of `[A-Za-z0-9_-]`, must not be a reserved word (`api`, `health`, `metrics`, …), and must be unique; a duplicate returns `409`.
- Response `201` with `{ code, shortUrl, url, createdAt, expiresAt }`.

### FR-2 — Redirect

`GET /:code` issues a `302` to the target URL.

- Resolution order: local in-process cache → Redis → shard database.
- A cache hit must not touch the database.
- An unknown code returns `404`; a known-but-expired code returns `410`.
- The click is recorded asynchronously; recording failure must never affect the response.

### FR-3 — Read link metadata

`GET /api/links/:code` returns the record plus its current click count. Does not count as a click.

### FR-4 — List links

`GET /api/links` returns a paginated list (cursor-based, `limit` max 100) scanned across all shards and merged by creation time.

### FR-5 — Delete a link

`DELETE /api/links/:code` removes the row and evicts the code from every cache tier. Returns `204`, or `404` if absent.

### FR-6 — Rate limiting

Every request is limited before the handler runs.

- Identity is the API key when present (`X-API-Key`), otherwise the client IP.
- Two algorithms are available and selectable per route group: **sliding window** (accurate, used for the API) and **token bucket** (burst-tolerant, used for redirects).
- Limits are enforced atomically so that N replicas share one budget.
- Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. A rejection returns `429` with `Retry-After`.
- Write endpoints get a stricter limit than read endpoints.

### FR-7 — Sharding

Link rows are distributed across `SHARD_COUNT` logical shards by `fnv1a(code) % SHARD_COUNT`. The router is deterministic, so any replica resolves any code without coordination. Each shard indexes `code` uniquely and `created_at` for listing.

### FR-8 — Distributed ID generation

IDs come from a Snowflake-style 64-bit generator: 41-bit timestamp, 10-bit node ID, 12-bit sequence. No database round trip, no central coordinator, monotonically increasing per node, and safe for up to 1024 replicas.

### FR-9 — Observability

- `GET /health` — liveness, always cheap.
- `GET /ready` — readiness; reports per-dependency status and returns `503` when a hard dependency is down.
- `GET /metrics` — Prometheus text format: request counts and latency histogram by route and status, cache hit/miss ratio, rate-limit rejections, shard query counts.

### FR-10 — Web UI

A single static page served at `/` to create a link, copy the result, and look up stats. No build step, no framework.

## 6. Non-functional requirements

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-1 | Redirect latency, cache hit | p99 < 25 ms |
| NFR-2 | Redirect throughput, single replica | ≥ 5,000 req/s sustained on commodity hardware |
| NFR-3 | Cache hit ratio in steady state | > 95% on a Zipfian access pattern |
| NFR-4 | Horizontal scaling | Replicas are stateless; adding one requires no config change and no sticky sessions |
| NFR-5 | Cache failure behaviour | Redis down ⇒ degrade to database reads and local rate limiting; **never** return 5xx purely because the cache is unavailable |
| NFR-6 | Startup | Cold start to serving < 2 s |
| NFR-7 | Portability | Full test suite runs with zero external services installed |
| NFR-8 | Test coverage | > 80% of statements in `src/core`, `src/services`, `src/middleware` |

## 7. API surface

| Method | Path | Purpose | Limit tier |
| --- | --- | --- | --- |
| `POST` | `/api/links` | Create link | write |
| `GET` | `/api/links` | List links | read |
| `GET` | `/api/links/:code` | Link metadata | read |
| `DELETE` | `/api/links/:code` | Delete link | write |
| `GET` | `/:code` | Redirect | redirect |
| `GET` | `/health` | Liveness | exempt |
| `GET` | `/ready` | Readiness | exempt |
| `GET` | `/metrics` | Prometheus scrape | exempt |

### Error envelope

Every non-2xx JSON response uses one shape:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests",
    "requestId": "b3f1c2d4e5a6b7c8",
    "details": {}
  }
}
```

## 8. Success criteria

The project is done when:

1. `npm test` passes with no external service running.
2. `docker compose up` yields 3 app replicas behind Nginx, all healthy, with round-robin traffic visible in `/metrics`.
3. The load test reports ≥ 5,000 redirects/s and a cache hit ratio above 95%.
4. Killing Redis mid-load-test degrades latency but returns zero 5xx responses.
5. Rate limits hold across replicas: 100 requests against a 60/min limit yields exactly 60 successes and 40 `429`s regardless of which replica served them.
6. `README.md` explains each system-design decision with its tradeoff.

## 9. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Redis becomes a single point of failure | Total outage | Circuit breaker in the cache driver; fall back to DB reads and local-only rate limiting |
| Hot key (one viral link) saturates a shard | Tail-latency spike | Local L1 cache absorbs repeats before Redis; single-flight collapses concurrent misses |
| Cache stampede on TTL expiry | Thundering herd on the DB | Single-flight per key plus ±10% TTL jitter |
| Cache penetration via random codes | DB hammered with misses | Negative caching of 404s with a short TTL |
| Snowflake clock rewind | Duplicate IDs | Detect non-monotonic clock and refuse to issue until time catches up |
| Fixed shard count | Rebalancing is a migration | Documented as an explicit v1 limitation; the router is isolated so consistent hashing can replace it |
