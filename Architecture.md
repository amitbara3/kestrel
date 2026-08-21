# Architecture — Kestrel

How the system is put together, why each piece is there, and where to find it in the tree.

---

## 1. Technical stack

| Layer | Choice | Why this and not the alternative |
| --- | --- | --- |
| Runtime | Node.js 22 LTS | Event-loop concurrency suits an I/O-bound proxy/redirect workload; no thread-per-request memory cost |
| Language | TypeScript 5 (strict), ESM | Compile-time guarantees on the driver interfaces that the whole pluggable design depends on |
| HTTP server | Fastify 5 | ~2× Express throughput, schema-based validation and serialization built in, first-class hook lifecycle for gateway middleware |
| Cache | Redis 7 via `ioredis` | Lua scripting gives atomic multi-step rate limiting in one round trip; `ioredis` has real cluster support |
| Database | PostgreSQL 16 via `pg` | Strong unique-index guarantees on `code`; a real connection pool per shard |
| Validation | Zod | One schema drives runtime validation, TypeScript types, and config parsing |
| Tests | Vitest | Native ESM/TS, fast watch mode, built-in coverage |
| Load test | `autocannon` | Scriptable, reports p99 rather than just averages |
| Load balancer | Nginx | `least_conn` upstream across replicas, health checks, one config file to read |
| Orchestration | Docker Compose | Whole topology — LB, 3 apps, Redis, Postgres — in one file |
| CI | GitHub Actions | Typecheck, lint, test with coverage, Docker build, integration test against real Redis + Postgres services |

**Deliberately not used:** an ORM (hides the query plan and the sharding, which are the point), a rate-limit library (the algorithm is the deliverable), Express (slower, and its middleware model fits the gateway story worse), Kubernetes (topology noise without teaching anything extra here).

## 2. The one idea that shapes everything: driver interfaces

Both external dependencies sit behind a narrow, **high-level** interface:

```
CacheDriver     get / set / del / slidingWindow / tokenBucket / ping
DatabaseDriver  insert / findByCode / delete / list / incrementClicks / ping
```

Two implementations of each ship in the box:

| Interface | Production driver | Fallback driver |
| --- | --- | --- |
| `CacheDriver` | `RedisCache` — Lua scripts, pipelining, circuit breaker | `MemoryCache` — Maps + timer-free lazy expiry |
| `DatabaseDriver` | `PostgresDriver` — pooled `pg` client per shard | `MemoryDriver` — Map with the same index semantics |

This is not a testing convenience bolted on afterwards; it is the reason the project runs anywhere.

- The interface is **high-level, not command-level**. `slidingWindow(key, limit, windowMs)` is one method, not `ZREMRANGEBYSCORE`+`ZCARD`+`ZADD`+`EXPIRE`. Redis implements it in a Lua script; memory implements it with an array of timestamps. Neither leaks its mechanism, and no Lua emulator is needed.
- Selection is by environment: set `REDIS_URL` and the Redis driver is used; omit it and the memory driver is used. Same for `DATABASE_URL`. A boot banner states which drivers are live, so a degraded run is never silent.
- The **correctness properties are identical across drivers** — the same test suite runs against both, which is what keeps the fallback honest.

## 3. Request flow

### 3.1 Redirect — the hot path

```
GET /aB3xK9
   │
   ▼
Nginx (least_conn) ──► one of N stateless app replicas
   │
   ▼
onRequest hook: assign request ID ──► start latency timer
   │
   ▼
rate limit (token bucket, burst-tolerant) ──► 429 + Retry-After if empty
   │
   ▼
LinkService.resolve(code)
   │
   ├─ L1: in-process LRU  ──hit──► return          (~0.01 ms, no network)
   │
   ├─ L2: Redis GET       ──hit──► fill L1, return (~0.4 ms, one RTT)
   │       │
   │       └─ negative-cache sentinel? ──► 404 without touching the DB
   │
   └─ L3: single-flight guard ──► shard router ──► SELECT on one shard
             │                                        │
             │◄──────── one query serves every ───────┘
             │          concurrent waiter
             ▼
          write L2 (TTL ± 10% jitter) ──► write L1 ──► return
   │
   ▼
302 Location: <target>
   │
   └─ fire-and-forget: buffer the click, flush on an interval
```

### 3.2 Create — the write path

```
POST /api/links
   │
   ▼
rate limit (sliding window, strict tier)
   │
   ▼
Zod validation ──► URL safety check (scheme + private-host block)
   │
   ▼
code = alias ?? base62(snowflake.next())      ← no DB round trip to pick an ID
   │
   ▼
shard = fnv1a(code) % SHARD_COUNT ──► INSERT (unique index on code catches races)
   │
   ▼
write-through to L2 ──► invalidate the negative-cache entry ──► 201
```

## 4. Caching strategy

**Pattern: cache-aside (lazy loading), three tiers.**

| Tier | Medium | TTL | Purpose |
| --- | --- | --- | --- |
| L1 | In-process LRU, per replica | 30 s | Absorbs hot keys with zero network cost. Small and short-lived, because it is the one tier that can serve stale data after another replica deletes a link. |
| L2 | Redis, shared by all replicas | 1 h ± 10% | The real cache. Survives replica restarts and deploys. |
| L3 | PostgreSQL shard | — | Source of truth. |

Four specific failure modes are handled explicitly, each in a named module:

**Cache penetration** — requests for codes that do not exist never populate a cache, so every one hits the DB; an attacker can force this with random codes. *Fix:* store a sentinel value for misses with a short TTL (60 s), so a repeated miss is answered from Redis.

**Cache stampede** — a popular key expires and every concurrent request rushes the DB at once. *Fix:* `singleflight.ts` — the first miss for a key runs the query, later callers await that same promise. One DB query per key per expiry, regardless of concurrency.

**Cache avalanche** — many keys written together expire together, producing a periodic DB spike. *Fix:* every TTL is jittered ±10% at write time.

**Cache unavailability** — Redis goes down. *Fix:* the circuit breaker in `RedisCache` opens after consecutive failures, short-circuits calls for a cooldown, then half-opens to probe. While open, reads fall through to the DB and rate limiting degrades to per-replica local counters. The service returns correct answers more slowly; it does not 5xx. (NFR-5)

**Invalidation** on delete is explicit and ordered: delete the row, then evict L2, then evict L1 locally. Other replicas' L1 entries expire on their own within 30 s — a bounded, documented staleness window, which is the tradeoff L1 buys its speed with.

## 5. Rate limiting

Two algorithms, both atomic, both correct across replicas.

### Sliding window log — used for `/api/*`

A Redis sorted set per identity holds one member per request, scored by timestamp. On each call, one Lua script: drop entries older than the window, count what remains, add the new entry if under the limit, re-set the expiry. Atomic because Lua runs single-threaded inside Redis, so N replicas cannot interleave a check with another's write.

*Chosen for the API because it is exact — no boundary burst.* Costs O(window × rate) memory per identity, which is fine at API-tier limits.

### Token bucket — used for `/:code` redirects

Two fields per identity (`tokens`, `lastRefill`). Tokens accrue at a fixed rate up to a cap; each request spends one. Refill is computed lazily from elapsed time inside the same Lua script — no background timer.

*Chosen for redirects because bursts are legitimate* (a link goes out to a mailing list and a thousand people click within a second). O(1) memory per identity.

### Identity and headers

Identity is `apikey:<key>` when `X-API-Key` is present, otherwise `ip:<client-ip>`, taken from the LB's `X-Forwarded-For` — only when the peer is a trusted proxy, so the header cannot be spoofed by a direct caller. Every response carries `X-RateLimit-Limit`, `-Remaining`, and `-Reset`; a rejection adds `Retry-After`.

## 6. Sharding and indexing

Shard selection is `fnv1a32(code) % SHARD_COUNT`.

- **Why hash the code and not the ID?** Every read path starts from the code, so hashing the code makes reads single-shard. Hashing the ID would force a fan-out on every redirect.
- **Why FNV-1a?** Fast, dependency-free, and well-distributed on short ASCII strings. Not cryptographic — it does not need to be.
- **Why fixed modulo and not consistent hashing?** With a fixed shard count, modulo is simpler and exactly as correct. Consistent hashing only pays off when shards are added at runtime, which v1 does not do. The router is one file with one function, so the swap is contained.

**Index plan per shard:**

| Index | Column(s) | Serves |
| --- | --- | --- |
| Primary key | `id BIGINT` | Row identity |
| Unique | `code` | Redirect lookup — the hot query. Unique also enforces alias collisions atomically. |
| B-tree | `created_at DESC, id DESC` | Cursor pagination for list |
| Partial | `expires_at WHERE expires_at IS NOT NULL` | Background reaping of expired rows without scanning live ones |

Reads by code are single-shard and index-only. `list` fans out to all shards and merges by `(created_at, id)` — accepted, because listing is an admin-tier operation, not the hot path.

## 7. Horizontal scaling

Replicas hold no request state: no sessions, no sticky routing, no local counters that matter for correctness. Everything shared lives in Redis or Postgres. Consequences:

- Any replica can serve any request. Nginx uses `least_conn`, not `ip_hash`.
- Scaling is `docker compose up --scale app=N`.
- Node ID for the Snowflake generator is derived from `NODE_ID` env or the hostname hash, so replicas do not collide on IDs without any coordination.
- Graceful shutdown drains in-flight requests and flushes the click buffer on `SIGTERM` before exit, so a rolling deploy loses no writes.

## 8. Analytics without slowing the redirect

Counting a click must not add a database write to the hot path. Clicks accumulate in an in-process buffer keyed by code; a timer flushes them every 5 seconds as one batched `UPDATE ... FROM (VALUES ...)` per shard. The buffer also flushes on shutdown.

The tradeoff is stated plainly: **counts are eventually consistent, and up to 5 seconds of clicks are lost if a replica is hard-killed.** For click analytics that is the right trade; for anything requiring exactness it would not be.

## 9. Folder structure

```
kestrel/
├── PRD.md                      Requirements
├── Architecture.md             This file
├── Rules.md                    Engineering constraints
├── Phases.md                   Build plan
├── Design.md                   Visual system
├── Memory.md                   Running build log
├── README.md                   Public-facing overview
├── docker-compose.yml          LB + 3 apps + Redis + Postgres
├── Dockerfile                  Multi-stage, non-root, distroless-ish
├── nginx/nginx.conf            least_conn upstream
├── db/migrations/001_init.sql  Shard schema + indexes
├── .github/workflows/ci.yml    Typecheck, test, integration, build
│
├── src/
│   ├── index.ts                Entry: build server, listen, wire signals
│   ├── server.ts               Fastify factory — routes and hooks, no I/O
│   ├── config.ts               Zod-parsed env, single source of settings
│   ├── logger.ts               Structured JSON logging
│   ├── container.ts            Dependency wiring; picks drivers by env
│   │
│   ├── core/                   Pure, dependency-free logic
│   │   ├── base62.ts             ID ⇄ short code
│   │   ├── idgen.ts              Snowflake generator
│   │   ├── hash.ts               FNV-1a for shard routing
│   │   ├── lru.ts                L1 cache
│   │   ├── singleflight.ts       Stampede collapse
│   │   ├── url-safety.ts         Scheme + private-host validation
│   │   └── errors.ts             AppError taxonomy → HTTP status
│   │
│   ├── cache/
│   │   ├── driver.ts             CacheDriver interface
│   │   ├── memory.ts             In-process implementation
│   │   ├── redis.ts              Redis + Lua + circuit breaker
│   │   └── index.ts              Factory
│   │
│   ├── db/
│   │   ├── driver.ts             DatabaseDriver interface
│   │   ├── memory.ts             In-process implementation
│   │   ├── postgres.ts           Pooled pg implementation
│   │   ├── shard-router.ts       code → shard
│   │   └── index.ts              Factory; builds the shard set
│   │
│   ├── services/
│   │   ├── link-service.ts       Cache-aside orchestration
│   │   └── analytics.ts          Buffered click counter
│   │
│   ├── middleware/
│   │   ├── rate-limit.ts         Tiered limiter hook
│   │   ├── request-context.ts    Request ID + access log
│   │   └── metrics.ts            Prometheus registry and hooks
│   │
│   ├── routes/
│   │   ├── links.ts              /api/links CRUD
│   │   ├── redirect.ts           /:code
│   │   └── system.ts             /health /ready /metrics
│   │
│   └── public/index.html         Web UI (no build step)
│
├── tests/                      Unit + integration, run driver-agnostic
└── bench/loadtest.mjs          autocannon harness, reports p99 + hit ratio
```

## 10. Where each system-design concept lives

| Concept | File |
| --- | --- |
| Cache-aside, 3 tiers | `src/services/link-service.ts` |
| Negative caching | `src/services/link-service.ts` (`NEGATIVE` sentinel) |
| Stampede prevention | `src/core/singleflight.ts` |
| TTL jitter | `src/cache/index.ts` (`jitter()`) |
| Circuit breaker | `src/cache/redis.ts` |
| Sliding-window limiter | `src/cache/redis.ts` (Lua) + `src/cache/memory.ts` |
| Token-bucket limiter | same pair |
| Hash sharding | `src/db/shard-router.ts` |
| Index strategy | `db/migrations/001_init.sql` |
| Distributed IDs | `src/core/idgen.ts` |
| Base62 encoding | `src/core/base62.ts` |
| Stateless scaling | `nginx/nginx.conf` + `docker-compose.yml` |
| Async write buffering | `src/services/analytics.ts` |
| Graceful drain | `src/index.ts` |

## 11. Failure modes

| Failure | Behaviour | Recovery |
| --- | --- | --- |
| Redis unreachable | Breaker opens; reads go to DB; limits become per-replica | Half-open probe every 10 s |
| One shard down | Only codes hashing to that shard fail; the rest serve normally | Pool reconnects; `/ready` reports the shard as degraded |
| All Postgres down | Cached codes still redirect from L1/L2; writes 503 | `/ready` fails, LB pulls the replica |
| Replica killed | LB routes elsewhere; up to 5 s of buffered clicks lost | Restart; no state to rebuild |
| Clock skew backwards | ID generator refuses to issue until the clock catches up | Logged loudly; NTP-dependent |
| Rate-limit key explosion | Redis memory grows with distinct identities | Every limiter key carries a TTL; `maxmemory-policy allkeys-lru` |
