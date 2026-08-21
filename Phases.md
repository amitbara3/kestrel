# Phases — Kestrel

The build broken into eight phases. Each phase is independently verifiable: it ends with a command you can run and an observable result. Do not start a phase until the previous one's exit criteria pass.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` complete

---

## Phase 0 — Foundation

**Goal:** an empty but correct skeleton. Nothing runs yet; everything is wired to.

- [x] Repository initialised, `.gitignore`, `.env.example`
- [x] `package.json` with scripts: `dev`, `build`, `start`, `test`, `test:coverage`, `lint`, `typecheck`, `bench`
- [x] TypeScript strict config, ESM, `tsconfig.json`
- [x] Vitest config with coverage thresholds
- [x] `src/config.ts` — Zod-parsed environment with working zero-config defaults
- [x] `src/logger.ts` — structured JSON logging with redaction
- [x] `src/core/errors.ts` — `AppError` taxonomy

**Exit criteria:** `npm run typecheck` passes. `npm test` runs (zero tests is fine).

---

## Phase 1 — Core primitives

**Goal:** the pure, dependency-free algorithms. All of it unit-tested before anything touches the network.

- [x] `core/base62.ts` — encode/decode, round-trip safe across the full `Number.MAX_SAFE_INTEGER` range
- [x] `core/idgen.ts` — Snowflake: 41-bit time, 10-bit node, 12-bit sequence; sequence rollover waits for the next millisecond; clock rewind throws
- [x] `core/hash.ts` — FNV-1a 32-bit
- [x] `core/lru.ts` — size-capped LRU with per-entry TTL and lazy expiry
- [x] `core/singleflight.ts` — concurrent calls for one key share one promise; the entry is cleared on settle so failures do not poison
- [x] `core/url-safety.ts` — scheme allowlist, private/loopback/link-local/metadata host rejection, normalisation

**Exit criteria:** unit tests for all six modules pass. Includes a 100k-iteration Base62 round-trip property test and an ID-generator test proving uniqueness and monotonicity under a burst larger than one millisecond's sequence space.

---

## Phase 2 — Storage layer

**Goal:** both driver pairs behind their interfaces, proven interchangeable.

- [x] `cache/driver.ts` and `db/driver.ts` — the two interfaces
- [x] `cache/memory.ts` — get/set/del, sliding window, token bucket, lazy expiry
- [x] `db/memory.ts` — insert with unique-code enforcement, findByCode, delete, cursor list, batched click increment
- [x] `db/shard-router.ts` — `fnv1a(code) % SHARD_COUNT`, with a distribution test
- [x] `cache/index.ts` / `db/index.ts` — factories that select a driver from config and log the choice
- [x] Shared **contract test suite** that any driver implementation must pass

**Exit criteria:** the contract suite passes against the memory drivers. The shard router distributes 10,000 codes across 4 shards within ±5% of even.

---

## Phase 3 — Redis and PostgreSQL drivers

**Goal:** the production implementations, satisfying the same contract.

- [x] `cache/redis.ts` — `ioredis`, Lua for sliding window and token bucket, circuit breaker (open after 5 consecutive failures, 10 s cooldown, half-open probe)
- [x] `db/postgres.ts` — one pooled client per shard, parameterised SQL only, cursor pagination, batched click flush
- [x] `db/migrations/001_init.sql` — table plus the four indexes from `Architecture.md`
- [x] The same contract suite runs against Redis and Postgres when `INTEGRATION=1` and the services are reachable; skipped otherwise

**Exit criteria:** with `INTEGRATION=1` and services up, the contract suite passes against Redis and Postgres unchanged. Without them, the suite skips those cases and stays green.

---

## Phase 4 — Services and HTTP

**Goal:** the application is usable end to end.

- [x] `services/link-service.ts` — cache-aside across L1/L2/L3, negative caching, single-flight, jittered TTL, ordered invalidation on delete
- [x] `services/analytics.ts` — buffered click counter, interval flush, flush on shutdown, size cap
- [x] `middleware/request-context.ts` — request ID, access log, error envelope
- [x] `middleware/rate-limit.ts` — tiered limiter (write / read / redirect / exempt), header emission, degradation when the cache is down
- [x] `routes/links.ts`, `routes/redirect.ts`, `routes/system.ts`
- [x] `server.ts` factory and `index.ts` entry with graceful shutdown
- [x] `container.ts` — dependency wiring

**Exit criteria:** integration tests cover every endpoint including 404, 410 (expired), 409 (duplicate alias), 422 (bad URL), and 429. `npm run dev` serves a working create-then-redirect flow.

---

## Phase 5 — Observability and the web UI

**Goal:** the system can be watched, and demoed without curl.

- [x] `middleware/metrics.ts` — Prometheus registry, no dependency: request counter, latency histogram, cache hit/miss, rate-limit rejections, shard query counts
- [x] `/health`, `/ready` with per-dependency status, `/metrics`
- [x] `src/public/index.html` — create, copy, and look up links; matches `Design.md`

**Exit criteria:** `/metrics` parses as valid Prometheus text format. `/ready` returns 503 when a hard dependency is down. The UI creates and resolves a link in a browser.

---

## Phase 6 — Scaling topology

**Goal:** actually horizontal, actually behind a load balancer.

- [x] Multi-stage `Dockerfile`, non-root, healthcheck
- [x] `docker-compose.yml` — Nginx, 3 app replicas, Redis, Postgres, with dependency health gating
- [x] `nginx/nginx.conf` — `least_conn` upstream, forwarded headers, health probe
- [x] Node ID derivation per replica so Snowflake IDs never collide

**Exit criteria:** `docker compose up` brings all services healthy. Requests round-robin across replicas (visible via a per-replica label in `/metrics`). A link created on one replica resolves on the others.

---

## Phase 7 — Load testing and hardening

**Goal:** measured numbers, and proof of the failure behaviour.

- [x] `bench/loadtest.mjs` — autocannon harness, Zipfian key distribution, reports p50/p99 and cache hit ratio
- [x] Chaos check: kill Redis mid-run and assert zero 5xx responses
- [x] Cross-replica rate-limit verification: 100 requests against a 60/min limit ⇒ exactly 60 allowed
- [x] Coverage thresholds enforced in CI

**Exit criteria:** the load test reports ≥ 5,000 req/s and > 95% hit ratio; the chaos run records zero 5xx; measured numbers written into `README.md`.

---

## Phase 8 — Repository polish

**Goal:** it reads as well as it runs.

- [x] `README.md` — quickstart, architecture diagram, per-decision tradeoff notes, measured benchmarks
- [x] `.github/workflows/ci.yml` — typecheck, lint, test with coverage, integration against real services, Docker build
- [x] `Memory.md` brought current
- [x] Issue and PR templates, LICENSE

**Exit criteria:** CI green on a clean clone. A reader who has never seen the repo can go from clone to a working redirect in under two minutes.

---

## Dependency order

```
Phase 0 ─► Phase 1 ─► Phase 2 ─┬─► Phase 3 ─┐
                               │            ├─► Phase 6 ─► Phase 7 ─► Phase 8
                               └─► Phase 4 ─┴─► Phase 5 ─┘
```

Phases 3 and 4 are independent once Phase 2 lands: the services are written against the interfaces, not the Redis or Postgres implementations.

## Deferred beyond v1

Consistent hashing for runtime shard addition · read replicas with routed reads · Redis Cluster · per-key adaptive rate limits · geo/device analytics · OpenTelemetry tracing · API-key management endpoints · bulk import.
