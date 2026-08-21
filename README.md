<h1 align="center">Kestrel</h1>

<p align="center">
  A scalable URL shortener and rate-limited API gateway.<br>
  Redis cache-aside · distributed rate limiting · hash-sharded PostgreSQL · N stateless replicas behind Nginx.
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-22-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Tests" src="https://img.shields.io/badge/tests-195%20local%20%C2%B7%20227%20integration-3FB950?style=flat-square">
  <img alt="Coverage" src="https://img.shields.io/badge/coverage-81%25-3FB950?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-F5A524?style=flat-square">
</p>

---

Kestrel shortens URLs, and every request passes through a real API-gateway pipeline on the way in: request tagging, distributed rate limiting, then a three-tier cache-aside read.

It exists to make the standard system-design answers **runnable and measurable** rather than described. Each technique lives in its own named module with a comment explaining what it costs, and the load test prints whether the stated targets were actually met.

## Quickstart

```bash
git clone <your-repo-url> kestrel && cd kestrel
npm install
npm run dev
```

Open <http://localhost:3000>. That is the whole setup — **no Redis and no PostgreSQL required**. With neither configured, Kestrel runs on in-process drivers that satisfy the same interfaces, and says so at boot:

```
{"level":"warn","msg":"No REDIS_URL set — using the in-process cache","driver":"memory",
 "consequence":"cache and rate limits are per-replica, not shared"}
```

For the real thing — load balancer, three replicas, Redis, Postgres:

```bash
docker compose up --build     # http://localhost:8080
```

```bash
npm test            # 195 tests, no external services needed
npm run test:coverage
npm run bench       # load test with a Zipfian key distribution
```

## Try it

```bash
# Create
curl -X POST localhost:3000/api/links \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/a/very/long/path"}'
# → 201 {"code":"PnlnEtzshs","shortUrl":"http://localhost:3000/PnlnEtzshs", ...}

# Redirect — note X-Cache showing which tier answered
curl -i localhost:3000/PnlnEtzshs
# → 302  x-cache: L1  location: https://example.com/a/very/long/path

# Rate-limit headers are on every response
curl -i localhost:3000/api/links | grep -i ratelimit
# → x-ratelimit-limit: 120   x-ratelimit-remaining: 119   x-ratelimit-reset: 1755...

# Where did hash routing put the rows?
curl -s localhost:3000/api/shards
```

## Architecture

```
                        ┌──────────────┐
   client ──────────────►    Nginx     │  least_conn, no session affinity
                        │  (port 8080) │
                        └──────┬───────┘
                 ┌─────────────┼─────────────┐
                 ▼             ▼             ▼
            ┌─────────┐  ┌─────────┐  ┌─────────┐
            │  app1   │  │  app2   │  │  app3   │   stateless, NODE_ID 1..3
            │ ┌─────┐ │  │ ┌─────┐ │  │ ┌─────┐ │
            │ │ L1  │ │  │ │ L1  │ │  │ │ L1  │ │   in-process LRU, 30s
            │ └─────┘ │  │ └─────┘ │  │ └─────┘ │
            └────┬────┘  └────┬────┘  └────┬────┘
                 └────────────┼────────────┘
                     ┌────────┴────────┐
                     ▼                 ▼
              ┌─────────────┐   ┌──────────────────────────┐
              │    Redis    │   │        PostgreSQL        │
              │             │   │  links_0  links_1        │
              │  L2 cache   │   │  links_2  links_3        │
              │  rate limit │   │  fnv1a(code) % 4         │
              └─────────────┘   └──────────────────────────┘
```

**Redirect path.** `GET /:code` → rate limit (token bucket) → L1 in-process LRU → L2 Redis → single-flight guard → one shard. A cache hit does no database work at all; the load test verifies this by counting queries, not by trusting a header.

**Write path.** `POST /api/links` → rate limit (sliding window) → validate → Snowflake ID → Base62 → `fnv1a(code) % SHARD_COUNT` → insert → write-through. No round trip to allocate an ID, and no collision-check retry loop.

Full detail, including the failure-mode table, is in [Architecture.md](Architecture.md).

## The design decisions, and what each one costs

<table>
<tr><th align="left">Decision</th><th align="left">Why</th><th align="left">What it costs</th></tr>

<tr><td><b>Base62 of a Snowflake ID</b><br><code>core/base62.ts</code>, <code>core/idgen.ts</code></td>
<td>Encoding an ID is a bijection, so a code is unique by construction. No <code>SELECT</code> to check, no retry loop, no central sequence — which is what makes replicas genuinely independent.</td>
<td>Codes are sequential and therefore enumerable. Fine for a shortener; wrong for anything where a link is a secret.</td></tr>

<tr><td><b>Three cache tiers</b><br><code>services/link-service.ts</code></td>
<td>L1 answers a hot key with zero network cost; L2 is shared, so a replica restart is not a cold start.</td>
<td>L1 can serve a link another replica just deleted, for up to its 30s TTL. Bounded, documented, and the reason L1 is kept small and short.</td></tr>

<tr><td><b>Negative caching</b><br>sentinel + 60s TTL</td>
<td>Without it, a flood of random codes reaches the database on every single request — cache penetration is trivially weaponisable.</td>
<td>A code created seconds after being probed stays invisible until the sentinel expires. Mitigated: create explicitly evicts it.</td></tr>

<tr><td><b>Single-flight</b><br><code>core/singleflight.ts</code></td>
<td>When a hot key expires, 200 concurrent requests would issue 200 identical queries. This collapses them to one. <a href="tests/link-service.test.ts">Tested</a> at exactly 1.</td>
<td>Per-process only. Three replicas can still issue three queries — the shared L2 absorbs the rest, and a distributed lock would cost a round trip on the path this exists to speed up.</td></tr>

<tr><td><b>TTL jitter, ±10%</b></td>
<td>Keys written together would otherwise expire together and produce a periodic database spike.</td>
<td>Cache lifetime is no longer exact. Nothing depends on it being exact.</td></tr>

<tr><td><b>Lua rate limiters</b><br><code>cache/lua.ts</code></td>
<td>Redis runs Lua single-threaded, so check-and-write is atomic. Separate GET/SET would let two replicas both read "59 of 60" and both allow.</td>
<td>Window boundaries shift with replica clock skew, since <code>now</code> is passed in rather than read from the server (a script that reads server state is unsafe to replicate). NTP is a deployment requirement.</td></tr>

<tr><td><b>Two limiter algorithms</b></td>
<td>Sliding window is exact — used for the API. Token bucket tolerates bursts — used for redirects, because a link hitting a mailing list <i>should</i> produce a thousand clicks in a second.</td>
<td>Sliding window costs O(limit) memory per identity. Acceptable at API-tier limits, not at redirect-tier volume — hence the split.</td></tr>

<tr><td><b>Circuit breaker</b><br><code>cache/circuit-breaker.ts</code></td>
<td>A Redis outage without one is <i>worse</i> than no cache: every request waits for a timeout first. The breaker makes the failure fast so reads fall through to the database.</td>
<td>While open, rate limits become per-replica, so the effective limit is multiplied by the replica count. A degraded limit beats a 5xx.</td></tr>

<tr><td><b>Hash the code, not the ID</b><br><code>db/shard-router.ts</code></td>
<td>Every read starts from a code, so hashing it keeps a redirect single-shard. Hashing the ID would fan out across every shard on every redirect.</td>
<td><code>list</code> must scatter-gather. Accepted: listing is admin-tier, not the hot path.</td></tr>

<tr><td><b>Fixed modulo, not consistent hashing</b></td>
<td>With a shard count fixed at deploy time, modulo is simpler and exactly as correct.</td>
<td>Changing <code>SHARD_COUNT</code> re-routes existing codes — a data migration, not a config change. Isolated to one function so the swap is contained.</td></tr>

<tr><td><b>Buffered click counts</b><br><code>services/analytics.ts</code></td>
<td>A redirect must not carry a database write. 10,000 clicks in 5s cost one <code>UPDATE</code>, not 10,000.</td>
<td>Counts are eventually consistent, and up to one flush interval is lost on a hard kill. SIGTERM flushes first.</td></tr>

<tr><td><b>Driver interfaces with fallbacks</b><br><code>cache/driver.ts</code>, <code>db/driver.ts</code></td>
<td>The suite runs anywhere, and a Redis outage has a real degraded path rather than a hypothetical one. Both implementations pass the <i>same</i> contract suite.</td>
<td>Two implementations to keep in step. The shared contract tests are what enforce that.</td></tr>

<tr><td><b>No ORM, no rate-limit library</b></td>
<td>The sharding and the limiter algorithms are the substance here. A library would hide exactly what the project is meant to show.</td>
<td>More hand-written code to maintain and test. See <a href="Rules.md">Rules.md §1</a>.</td></tr>
</table>

## Measured results

Load test, single replica, Zipfian key distribution over 500 links (`s = 1.1`), cache warmed before measuring:

| | L1 + L2 enabled | L1 disabled (L2 only) |
| --- | --- | --- |
| Requests/sec | **16,672** | **19,861** |
| Latency p50 | 2 ms | 2 ms |
| Latency p99 | **4 ms** | **4 ms** |
| Latency max | 22 ms | 20 ms |
| Requests served | 250,097 | 218,468 |
| Database lookups | **0** | **0** |
| Cache effectiveness | **100%** | **100%** |
| Non-3xx responses | 0 | 0 |
| Socket errors | 0 | 0 |

| Target | Result |
| --- | --- |
| NFR-1 · p99 < 25 ms | **PASS** — 4 ms |
| NFR-2 · ≥ 5,000 req/s | **PASS** — 16,672 req/s |
| NFR-3 · hit ratio > 95% | **PASS** — 100% |
| Zero 5xx under load | **PASS** — 0 errors |

<sub>Measured on Windows 11, Intel i7-11800H (8C/16T), 16 GB RAM, Node 22.15, `npm run bench`, 50 connections, 15 s.</sub>

**Read these numbers with three caveats,** because a benchmark without them is decoration:

1. **The in-process drivers were used** — no Redis or PostgreSQL was installed on the measurement machine. So L1 and L2 are both in-memory here, which is why the two columns are close and why the L1-disabled run is nominally *faster* (that gap is noise, not a finding). Against real Redis, expect L2 to cost roughly 0.3–0.5 ms per hit and the gap between the columns to become real.
2. **Zero database lookups is the honest figure but the easy case**: 500 links fit inside a 10,000-entry L1, and the run is shorter than the 30 s TTL. A working set larger than L1 is what exercises L2, and a working set larger than L2 is what exercises the shards.
3. **Rate limiting was disabled for the throughput runs** (`RATE_LIMIT_ENABLED=false`). Left on, the limiter caps the result and you measure the limiter, not the system.

Cache effectiveness here is *requests served without a database lookup*. Summing per-tier hits and misses would double-count — one request that misses L1 and hits L2 records both, which reads as 50% when the database was never touched.

## API

| Method | Path | Purpose | Limit tier |
| --- | --- | --- | --- |
| `POST` | `/api/links` | Create — `{ url, alias?, expiresIn? }` | write · 20/min |
| `GET` | `/api/links` | List, cursor-paginated | read · 120/min |
| `GET` | `/api/links/:code` | Metadata + click count | read |
| `DELETE` | `/api/links/:code` | Delete and invalidate | write |
| `GET` | `/api/shards` | Row distribution per shard | read |
| `GET` | `/:code` | Redirect (302) | redirect · 200 burst, 50/s |
| `GET` | `/health` | Liveness | exempt |
| `GET` | `/ready` | Readiness, per dependency | exempt |
| `GET` | `/metrics` | Prometheus | exempt |

Every non-2xx response uses one envelope:

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests", "requestId": "1c95bdc0e416d91f" } }
```

`ALIAS_TAKEN` · `RESERVED_ALIAS` · `VALIDATION_FAILED` · `UNSAFE_URL` · `NOT_FOUND` · `GONE` · `RATE_LIMITED` · `DEPENDENCY_UNAVAILABLE` · `INTERNAL`

## Failure behaviour

| Failure | What happens | Verified by |
| --- | --- | --- |
| Redis down | Breaker opens; reads fall through to the shards; limits degrade to per-replica. **No 5xx.** | `tests/degradation.test.ts` |
| One shard down | Only codes hashing there fail; `/ready` reports it and returns 503 | `tests/degradation.test.ts` |
| Database down | Cached codes still redirect; `/ready` 503s so the balancer drains the replica | `tests/degradation.test.ts` |
| Replica killed | Balancer routes elsewhere; ≤ 1 flush interval of clicks lost | by design |
| Clock rewind | ID generator refuses to issue rather than risk a duplicate | `tests/core.test.ts` |
| Corrupt cache entry | Treated as a miss and dropped, never a 500 | `tests/link-service.test.ts` |
| Spoofed `X-Forwarded-For` | Ignored unless the peer is a configured trusted proxy | `tests/infrastructure.test.ts` |
| Alias race | Resolved by the unique index — exactly one winner out of 8 concurrent inserts | `tests/db-contract.test.ts` |

## Configuration

Every value has a working default; `npm start` on a clean machine works with no environment at all. Full list in [.env.example](.env.example).

| Variable | Default | Effect |
| --- | --- | --- |
| `REDIS_URL` | *(unset)* | Set it to use Redis; unset uses the in-process cache |
| `DATABASE_URL` | *(unset)* | Set it to use Postgres. Comma-separated for multiple servers |
| `SHARD_COUNT` | `4` | Logical shards. Changing it after data exists is a migration |
| `NODE_ID` | *(hostname hash)* | Snowflake node ID, 0–1023. Pin it per replica |
| `CACHE_TTL_SECONDS` | `3600` | L2 TTL before jitter |
| `L1_TTL_SECONDS` | `30` | L1 TTL — also the staleness window after a delete |
| `RATE_LIMIT_*` | see file | Per-tier limits |
| `TRUSTED_PROXIES` | RFC1918 + loopback | Whose `X-Forwarded-For` is believed |

## Project layout

```
src/core/        pure algorithms — base62, snowflake, fnv1a, LRU, single-flight, URL safety
src/cache/       CacheDriver: interface, memory, redis (+ Lua, circuit breaker)
src/db/          DatabaseDriver: interface, memory, postgres, shard router, sharded store
src/services/    cache-aside orchestration, buffered click counter
src/middleware/  request context, rate limiter, Prometheus registry
src/routes/      links API, redirect, system
tests/           195 tests — unit, driver contract, integration, failure modes
bench/           autocannon harness, Zipfian distribution
```

## Documentation

| File | Contents |
| --- | --- |
| [PRD.md](PRD.md) | Requirements, users, NFR targets, risks |
| [Architecture.md](Architecture.md) | Stack, request flows, caching, sharding, failure modes |
| [Rules.md](Rules.md) | Dependency allow/deny list, error handling, security, testing rules |
| [Phases.md](Phases.md) | The eight build phases and their exit criteria |
| [Design.md](Design.md) | Colour, typography, spacing, components, accessibility |
| [Memory.md](Memory.md) | Running build log — what shipped, what is open |

## Testing

```bash
npm test                  # 195 tests, no external services
npm run test:coverage     # thresholds enforced: 80% statements
npm run test:integration  # 227 tests — adds the contract suites against real Redis + Postgres
npm run typecheck
```

CI runs all three, plus a Docker smoke test that boots the image, creates a link, and follows the redirect.

Two things worth noting about how this is tested:

- **Both driver implementations run the same contract suite.** That is what makes the in-process fallback trustworthy rather than merely present. If `MemoryCache` and `RedisCache` both pass, swapping them cannot change observable behaviour.
- **Cache claims are measured, not asserted.** The tests wrap the store in a counting driver, so "the cache hit did not touch the database" is a counted fact — including the one proving 200 concurrent misses produce exactly one query.

That integration job earned its keep immediately: it caught two bugs in `RedisCache` that the in-process run structurally cannot see — the client never completed its handshake (so every read silently reported a miss and every write was dropped), and the Lua scripts were dispatched by name through `client.call()` instead of the methods `defineCommand` attaches (so both limiters failed on every request and quietly degraded to per-replica counters). Both are in the history.

## License

MIT — see [LICENSE](LICENSE).
