# Memory — Kestrel

The handoff file. Read this first: it says where the build actually is, what was decided and why, and what is open. Update it at the end of every phase (Rules.md §9).

**Last updated:** 2026-08-22 · **Status:** v1.0 complete, CI green, **compose topology verified on real infrastructure** · **Tests:** 195 local · 227 integration · 20 live cluster checks

---

## Current state

Everything in `Phases.md` is done and verified. The service runs, the suite is green, the load test meets its targets.

```
npm install && npm test     # 195 passing, 2 skipped (integration, need Redis/Postgres)
npm run dev                 # http://localhost:3000 — no external services needed
docker compose up --build   # http://localhost:8080 — LB + 3 replicas + Redis + Postgres
npm run bench               # load test, prints PASS/FAIL against the NFR targets
```

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | 195 passed, 2 skipped |
| `npm run test:coverage` | 81.71% statements, 90% branches, 94% functions — above the 80/70/80 thresholds |
| `npm run build` | clean |
| `npm run bench` | 16,672 req/s, p99 4 ms, 0 DB lookups, 0 errors |
| CI — typecheck + test | green |
| CI — contracts vs real Redis + Postgres | green, **227 passed** |
| CI — Docker build + smoke test | green (image boots, creates a link, follows the redirect) |
| `docker compose up` | **all 6 containers healthy** — LB + 3 replicas + Redis + Postgres |
| `npm run verify -- --chaos` | **20 passed, 0 failed** against the live cluster |
| `npm run bench` (cluster) | 14,408 req/s · 0 DB lookups of 288,142 · p99 1 ms server-side |

Repository: <https://github.com/amitbara3/distributed-url-shortener>

The repo was renamed from `kestrel` on 2026-08-22 so it reads as what it is on a
CV. **`Kestrel` remains the service's internal name** and should stay that way:
the metric namespace (`kestrel_*`), the Redis key prefix (`kestrel:`), and the
compose project and container names all use it, so renaming those would orphan
cache keys on deploy and break any dashboard built on the metrics. GitHub
permanently redirects the old URL.

## Environment (2026-08-22)

Docker was installed to close out the last unverified items. Notes that are not
recoverable from the repo:

- **Docker Engine 29.7.2 + Compose v5.5.0 runs inside WSL2 Ubuntu 24.04**, not
  Docker Desktop. The Windows user is not an administrator, and WSL2 with
  systemd was already present — so `docker-ce` from the official apt repo inside
  the distro needed no admin rights and no Desktop licence.
- `docker` is therefore **not on the Windows PATH**. Drive it with
  `wsl -u root docker ...`, or set `DOCKER_CMD="wsl -u root docker"` for
  `bench/verify-cluster.mjs`.
- **WSL shuts the distro down once its last process exits**, which stops dockerd
  and every container with it. Each separate `wsl ...` invocation is its own
  session, so a stack started by one command dies moments later and
  `restart: unless-stopped` silently revives it on the next call — containers
  appear to flap and requests fail mid-restart for no visible reason. Hold the
  distro open first:
  `wsl -u root -e bash -c 'exec sleep 86400' &`
- Node is **not installed inside WSL**. Benchmarks run in a `node:22-alpine`
  container attached to the `kestrel_kestrel` network, so the WSL2 localhost
  relay stays out of the measurement path.

## What exists

| Area | Files | State |
| --- | --- | --- |
| Docs | `PRD.md` `Architecture.md` `Rules.md` `Phases.md` `Design.md` `README.md` | Complete |
| Config & logging | `src/config.ts` `src/logger.ts` | Zod-validated env, JSON logs with secret redaction |
| Core algorithms | `src/core/*` | base62, snowflake, fnv1a, LRU, single-flight, URL safety, alias rules, error taxonomy |
| Cache drivers | `src/cache/*` | Interface + memory + Redis (Lua limiters, circuit breaker) |
| DB drivers | `src/db/*` | Interface + memory + Postgres, shard router, sharded store |
| Services | `src/services/*` | Cache-aside orchestration, buffered click counter |
| Middleware | `src/middleware/*` | Request context, tiered rate limiter, Prometheus registry |
| Routes | `src/routes/*` | links API, redirect, health/ready/metrics/shards |
| UI | `src/public/index.html` | Single page, no build step, matches `Design.md` |
| Topology | `Dockerfile` `docker-compose.yml` `nginx/nginx.conf` | 3 replicas behind `least_conn` |
| CI | `.github/workflows/ci.yml` | typecheck+test · integration vs real services · image build + smoke test |
| Bench | `bench/loadtest.mjs` | autocannon, Zipfian keys, reports against NFR targets |

## Decisions worth not re-litigating

These were settled during the build. Each is documented at the code that implements it; this is the index.

1. **Driver interfaces are high-level, not command-level.** `CacheDriver.slidingWindow(...)` is one method, not four Redis commands. This is why the memory driver needs no Lua emulator and why both implementations can pass one contract suite. — `src/cache/driver.ts`
2. **Driver choice comes from the presence of `REDIS_URL` / `DATABASE_URL`,** not a mode flag. A flag and a URL can disagree, and then the boot log lies.
3. **The code is the Base62 of a Snowflake ID.** Bijective, so no collision check and no retry loop on create. Cost: codes are enumerable.
4. **Shard on the code, not the ID.** Reads start from a code, so this keeps redirects single-shard.
5. **Logical shards (tables) are separate from physical shards (servers).** `DATABASE_URL` accepts a comma-separated list; shard *i* lives on server *i % servers*. Growing servers does not re-hash rows.
6. **Timestamps are `BIGINT` epoch ms, not `TIMESTAMPTZ`.** Exact round-trip with the JS domain type; no timezone semantics on a value the database only ever compares.
7. **`now` is passed into the Lua scripts** rather than read via `redis.call('TIME')` — a script reading server state is unsafe to replicate. Cost: clock skew shifts window edges, so NTP is a deployment requirement.
8. **Delete order is row → L2 → L1.** Evicting first leaves a window for a concurrent read to repopulate from a row that is about to vanish.
9. **`/health` never touches a dependency; `/ready` does.** A restart cannot fix a sick database, and restart loops make an outage worse.
10. **Cache effectiveness is measured as "requests served without a database lookup".** Summing per-tier hits and misses double-counts — one request that misses L1 and hits L2 records both, reading as 50% when the database was never touched. Corrected in both `bench/loadtest.mjs` and the UI tile.

## Defects found and fixed during the build

Recorded because each one is a trap worth not re-entering:

| Defect | Symptom | Fix |
| --- | --- | --- |
| `statusOf()` ignored Fastify's own `statusCode` | Malformed JSON and over-large bodies returned **500** instead of 400/413 — client mistakes reported as server faults, and noise in 5xx alerting | `src/core/errors.ts` now reads `statusCode` off non-`AppError` throws. Caught by `tests/degradation.test.ts` |
| Dead normalisation branch in `url-safety.ts` | `url.pathname = ''` is a no-op: WHATWG `URL` forces `/` on http(s) | Branch removed; the trailing-slash normal form is now documented instead of half-attempted |
| Double-counted cache hit ratio | Bench reported 50% with L1 disabled although **zero** requests reached the database | Redefined as `1 − lookups/requests` in bench and UI |
| Test harness set a 50 ms flush interval | Config validation rejected it at boot (floor is 100 ms) | Harness raised to 100 ms — the validator was right |
| **`RedisCache` never completed its handshake** | With `lazyConnect` + `enableOfflineQueue: false`, a driver built without an explicit `connect()` issued every command against a client in `wait` status. Reads returned null (a miss), writes were dropped — the cache did **nothing**, invisibly, while the service kept serving correct data | Every command path awaits a memoised connect promise (`ensureConnected`). Caught by the CI integration job |
| **Lua scripts dispatched by name** | `client.call('kestrelSlidingWindow', …)` sent a literal unknown command. `defineCommand` attaches a *method*, it does not register a dispatchable name. Both limiters failed on every request and silently degraded to per-replica counters — still limiting, just no longer distributed | Call `client.kestrelSlidingWindow(…)` via a declared interface on the client type. Caught by the CI integration job |
| **No `.dockerignore`** | The build context shipped `node_modules/` and `dist/` to the daemon on every build — hundreds of MB the image discards and rebuilds anyway | Added `.dockerignore`; it also keeps `.env` out of a layer |
| **`proxy_buffering off` in nginx.conf, with a comment claiming it prevented caching** | It does not: caching is `proxy_cache`, never declared and so already off. The directive only cost a write syscall per chunk. Removing it took throughput 13,010 → 14,408 req/s (+11%) | Removed; comment corrected to explain why caching is already off |
| **Unbuffered nginx access log** | A write syscall per request at redirect volume, straight into tail latency | `buffer=64k flush=5s` |
| **Bench read `/metrics` through the balancer** | One scrape reaches one replica, so it reported a single replica's counters against the whole cluster's request total — understating database load 3× (`l1 consulted 88,237` vs `264,939` requests) | Scrape repeatedly, keep the max per (series, `instance`) since counters are monotonic, then sum across instances |
| **Benchmark reported p99 35 ms as a system property** | Coordinated omission: one Node process at 14.4k req/s is itself the bottleneck, so most reported "latency" was queueing in its own event loop. Nginx timing the same traffic reported p99 **1 ms** | Added `RATE=` fixed-rate mode; README reports client-at-saturation, client-at-rate, and server-side separately |

The last two are the argument for the integration job existing. Neither is
visible to the in-process contract run: `MemoryCache` has no connection to
forget and no Lua to dispatch. Both would have shipped looking healthy.

## Known limitations (deliberate, documented)

- **L1 staleness:** up to 30 s after another replica deletes a link. The price of a zero-network cache tier. Shrink `L1_TTL_SECONDS` to trade throughput for freshness.
- **Single-flight is per-process.** Three replicas can still issue three queries for one expired key. The shared L2 absorbs the rest.
- **Click counts are eventually consistent**, and up to one flush interval is lost on SIGKILL. SIGTERM flushes first.
- **`SHARD_COUNT` is fixed at deploy time.** Changing it re-routes existing codes — a data migration.
- **URL safety checks the literal address, not DNS.** Kestrel never fetches the target, so a hostname resolving to a private IP is out of scope for v1 (`Rules.md` §5).
- **Codes are sequential and enumerable.** Correct for a shortener; wrong if a link is meant to be a secret.
- **Degraded rate limiting is per-replica.** With Redis down, the effective limit is multiplied by the replica count. A degraded limit beats a 5xx.

## Benchmark caveats

The README numbers now come from the **real compose topology** (Nginx + 3
replicas + Redis + Postgres), not the in-process drivers. Still read them with
these in mind:

- **Everything shares one laptop**, load generator included. Nginx peaks at 120%
  CPU, each replica at 65–72%, Postgres and Redis at ~4%. On separate hosts the
  balancer would stop being the busiest process.
- **Latency and throughput are separate runs.** At saturation the single-process
  generator is the bottleneck and its latency figures are mostly its own
  queueing — the p99 it reports (35 ms) is 35× what Nginx measures for the same
  traffic (1 ms). Use `RATE=2000` for latency, unset for throughput.
- **Zero database lookups is honest but is the easy case**: 500 links fit inside
  a 10,000-entry L1, and the run is shorter than the 30 s L1 TTL. A working set
  larger than L1 exercises L2; larger than L2 exercises the shards.
- **Rate limiting is off for throughput runs** via `docker-compose.bench.yml`.
  Left on, the redirect tier caps the result at ~150 req/s and you measure the
  limiter.

## Verified by hand, not only by tests

- Built and started the compiled output; `curl`ed `/health`, `/ready`, `POST /api/links`, and the redirect. `X-Cache: L1` confirmed on the redirect, `Location` correct.
- Boot log confirms the degraded-driver warnings fire when `REDIS_URL` / `DATABASE_URL` are absent.
- Load test executed twice (L1 on, L1 off) against a real socket.

## What was not done

- ~~The compose stack has never been started.~~ **Done.** All six containers come up healthy, and `npm run verify -- --chaos` passes 20/20 against the live cluster.
- ~~Cross-replica rate limiting unverified.~~ **Done** — exactly 20 of 60 writes admitted across 3 replicas. Per-process counters would have admitted ~60.
- ~~Chaos check unverified.~~ **Done** — 0 of 80,260 requests returned 5xx with Redis stopped, and the breaker closed on its own once it returned.
- **Redis and Postgres drivers are verified** — the CI integration job runs both contract suites against real services (227 tests), and the index plan is now confirmed by `EXPLAIN (ANALYZE, BUFFERS)` on the live database rather than asserted.
- **The cross-replica rate-limit check** (Phases.md Phase 7: 100 requests against a 60/min limit across 3 replicas ⇒ exactly 60) needs the compose stack. The single-process equivalent is tested and passes.
- **The chaos check** (kill Redis mid-load-test, assert zero 5xx) needs the compose stack. The degradation path itself is unit-tested with a failing cache driver.

## Next steps

1. ~~Verify the compose topology, chaos, and cross-replica limits.~~ **All done** — see the checks table above.
2. Consider adding `npm run verify` to CI as a fourth job: bring the stack up with compose and run the 20 cluster checks. It is the one layer CI does not cover, and it is the layer where the last four defects were found.
3. Then the deferred list in `Phases.md`: consistent hashing, read replicas, Redis Cluster, OpenTelemetry.
4. If tail latency ever matters for real, the next lever is the balancer — it is the busiest process in the topology. Multiple Nginx instances, or a lighter L4 balancer, before touching the app.

## Conventions to follow

- One phase at a time, in `Phases.md` order. Verify before moving on.
- Read `Rules.md` before adding a dependency — the deny list is deliberate and includes ORMs, rate-limit libraries, and cache wrappers.
- Both driver implementations must keep passing the shared contract suites. That is what keeps the fallback honest.
- No sleep-based tests; inject a clock.
- A bug fix starts with a failing test.
- Never publish a benchmark number that was not measured.
