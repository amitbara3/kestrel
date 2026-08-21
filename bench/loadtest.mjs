#!/usr/bin/env node
/**
 * Load-test harness.
 *
 * Measures the redirect path under a Zipfian key distribution, because that is
 * what real short-link traffic looks like: a handful of links take most of the
 * requests. A uniform distribution would understate the cache hit ratio and
 * overstate the database load, making the numbers useless as evidence.
 *
 * Usage:
 *   node bench/loadtest.mjs                        # against localhost:3000
 *   TARGET=http://localhost:8080 node bench/loadtest.mjs   # against the balancer
 *   LINKS=1000 DURATION=30 CONNECTIONS=100 node bench/loadtest.mjs
 *
 * Rate limiting must be off (or set high) for a throughput run, or the limiter
 * caps the result rather than the system:
 *   RATE_LIMIT_ENABLED=false npm run dev
 */

import autocannon from 'autocannon';

const TARGET = process.env.TARGET ?? 'http://localhost:3000';
const LINKS = Number(process.env.LINKS ?? 500);
const DURATION = Number(process.env.DURATION ?? 15);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);
const ZIPF_S = Number(process.env.ZIPF_S ?? 1.1);
/**
 * Optional fixed request rate (req/s across all connections).
 *
 * At saturation a single-process load generator becomes the bottleneck and the
 * latency it reports is mostly time queued in its own event loop, not time the
 * server took — the classic coordinated-omission artifact. Driving a fixed rate
 * below saturation measures service time instead. Use RATE for latency numbers
 * and leave it unset for throughput numbers.
 */
const RATE = process.env.RATE ? Number(process.env.RATE) : undefined;

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Read the metrics, aggregating across replicas.
 *
 * Behind a load balancer a single scrape of /metrics reaches exactly one
 * replica, so it reports that replica's counters — comparing them against the
 * whole cluster's request total silently understates database load by the
 * replica count. Every series carries an `instance` label, so scraping
 * repeatedly and keeping the highest value seen per (series, instance) —
 * counters are monotonic, so the highest is the latest — then summing across
 * instances gives the cluster-wide figure.
 */
async function readMetrics(samples = 15) {
  const perInstance = new Map();

  const bump = (instance, key, value) => {
    let series = perInstance.get(instance);
    if (series === undefined) {
      series = new Map();
      perInstance.set(instance, series);
    }
    series.set(key, Math.max(series.get(key) ?? 0, value));
  };

  let reached = 0;
  for (let sample = 0; sample < samples; sample++) {
    let text;
    try {
      const response = await fetch(`${TARGET}/metrics`);
      if (!response.ok) continue;
      text = await response.text();
      reached++;
    } catch {
      continue;
    }

    for (const line of text.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      const value = Number(line.slice(line.lastIndexOf(' ') + 1));
      if (!Number.isFinite(value)) continue;

      const instance = /instance="([^"]+)"/.exec(line)?.[1] ?? 'unknown';

      if (line.startsWith('kestrel_cache_events_total')) {
        const tier = /tier="([^"]+)"/.exec(line)?.[1];
        const outcome = /outcome="([^"]+)"/.exec(line)?.[1];
        if (tier && outcome) bump(instance, `tier:${tier}:${outcome}`, value);
      } else if (line.startsWith('kestrel_shard_queries_total')) {
        bump(instance, 'shardQueries', value);
        // Only lookups matter for cache effectiveness; inserts and deletes are
        // writes no cache is expected to absorb.
        if (line.includes('operation="findByCode"')) bump(instance, 'lookups', value);
      } else if (line.startsWith('kestrel_rate_limit_rejections_total')) {
        bump(instance, 'rejections', value);
      } else if (line.startsWith('kestrel_redirects_total') && line.includes('outcome="ok"')) {
        bump(instance, 'redirects', value);
      }
    }
  }

  if (reached === 0) return null;

  const totals = { shardQueries: 0, lookups: 0, rejections: 0, redirects: 0, byTier: {}, instances: [] };
  for (const [instance, series] of perInstance) {
    totals.instances.push(instance);
    for (const [key, value] of series) {
      if (key.startsWith('tier:')) {
        const [, tier, outcome] = key.split(':');
        totals.byTier[tier] ??= { hit: 0, miss: 0, negative: 0 };
        totals.byTier[tier][outcome] += value;
      } else {
        totals[key] += value;
      }
    }
  }
  return totals;
}

/**
 * Zipf sampler by inverse-CDF over a precomputed table. Built once so the
 * request-generating hook stays allocation-free — the generator must not
 * become the bottleneck being measured.
 */
function zipfTable(n, s) {
  const weights = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1 / Math.pow(i + 1, s);
    weights[i] = total;
  }
  for (let i = 0; i < n; i++) weights[i] /= total;
  return weights;
}

function sample(table) {
  const r = Math.random();
  let lo = 0;
  let hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function seed() {
  log(`Seeding ${LINKS} links at ${TARGET} …`);
  const codes = [];
  let failures = 0;

  // Serial batches of 25: enough concurrency to seed quickly, not so much that
  // the seeding itself trips a write limit and skews the sample.
  for (let start = 0; start < LINKS; start += 25) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(25, LINKS - start) }, async (_unused, offset) => {
        const index = start + offset;
        try {
          const response = await fetch(`${TARGET}/api/links`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: `https://example.com/bench/${index}` }),
          });
          if (!response.ok) return null;
          return (await response.json()).code;
        } catch {
          return null;
        }
      }),
    );
    for (const code of batch) {
      if (code === null) failures++;
      else codes.push(code);
    }
  }

  if (codes.length === 0) {
    log('');
    log('Seeding produced no links. Is the service running, and is the write');
    log('rate limit high enough? Try: RATE_LIMIT_ENABLED=false npm run dev');
    process.exit(1);
  }
  if (failures > 0) log(`  ${failures} seed requests failed (likely rate limited)`);
  log(`  seeded ${codes.length} links`);
  return codes;
}

function percentOf(part, whole) {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

async function main() {
  log('');
  log('  Kestrel load test');
  log(`  target=${TARGET} links=${LINKS} duration=${DURATION}s connections=${CONNECTIONS} zipf-s=${ZIPF_S}`);
  log(`  mode=${RATE !== undefined ? `fixed ${RATE} req/s (latency measurement)` : 'saturation (throughput measurement)'}`);
  log('');

  const codes = await seed();
  const table = zipfTable(codes.length, ZIPF_S);

  // Warm the cache so the run measures steady state rather than a cold start —
  // and say so, because an unstated warm-up is how benchmarks become lies.
  log('Warming the cache …');
  for (const code of codes) {
    await fetch(`${TARGET}/${code}`, { redirect: 'manual' }).catch(() => undefined);
  }

  const before = await readMetrics();
  log(`Running for ${DURATION}s …`);
  log('');

  const result = await autocannon({
    url: TARGET,
    connections: CONNECTIONS,
    duration: DURATION,
    ...(RATE !== undefined ? { overallRate: RATE } : {}),
    // Do not follow the 302 — we are measuring Kestrel, not example.com.
    requests: [{ method: 'GET', path: '/', setupRequest: (request) => ({
      ...request,
      path: `/${codes[sample(table)]}`,
    }) }],
  });

  const after = await readMetrics();

  const status2xx3xx = (result['2xx'] ?? 0) + (result['3xx'] ?? 0);
  const errors = (result.non2xx ?? 0) - (result['3xx'] ?? 0);

  log('  Results');
  log('  ─────────────────────────────────────────────');
  log(`  Requests/sec      ${Math.round(result.requests.average).toLocaleString()}`);
  log(`  Latency p50       ${result.latency.p50} ms`);
  log(`  Latency p99       ${result.latency.p99} ms`);
  log(`  Latency max       ${result.latency.max} ms`);
  log(`  Throughput        ${(result.throughput.average / 1e6).toFixed(2)} MB/s`);
  log(`  Total requests    ${result.requests.total.toLocaleString()}`);
  log(`  Redirects (3xx)   ${(result['3xx'] ?? 0).toLocaleString()}`);
  log(`  Non-2xx/3xx       ${Math.max(0, errors).toLocaleString()}`);
  log(`  Socket errors     ${result.errors}`);
  log('');

  if (before !== null && after !== null) {
    const lookups = after.lookups - before.lookups;
    const queries = after.shardQueries - before.shardQueries;
    const rejections = after.rejections - before.rejections;
    const total = result.requests.total;

    // Cache effectiveness is the share of requests answered WITHOUT a database
    // lookup. Summing per-tier hits and misses would double-count: a request
    // that misses L1 and hits L2 records both, reading as 50% when in fact the
    // database was never touched.
    const effectiveness = percentOf(total - lookups, total);

    log('  Cache');
    log('  ─────────────────────────────────────────────');
    if (after.instances.length > 1) {
      log(`  Replicas seen     ${after.instances.length} (counters summed across them)`);
    }
    log(`  Hit ratio         ${effectiveness}%  (requests served with no DB lookup)`);
    log(`  DB lookups        ${lookups.toLocaleString()} of ${total.toLocaleString()} requests`);
    log('  Per tier, share of the reads that reached it:');
    for (const tier of ['l1', 'l2', 'l3']) {
      const counts = after.byTier[tier];
      if (!counts) continue;
      const tierHits = counts.hit - (before.byTier[tier]?.hit ?? 0);
      const tierMisses = counts.miss - (before.byTier[tier]?.miss ?? 0);
      const consulted = tierHits + tierMisses;
      if (consulted === 0) continue;
      log(`    ${tier.padEnd(13)} ${String(percentOf(tierHits, consulted)).padStart(5)}% hit of ${consulted.toLocaleString()} consulted`);
    }
    log(`  Shard queries     ${queries.toLocaleString()} total (all operations)`);
    if (rejections > 0) {
      log(`  Rate limited      ${rejections.toLocaleString()} — limits are capping this run`);
    }
    log('');

    log('  Targets');
    log('  ─────────────────────────────────────────────');
    check('NFR-1  p99 < 25ms', result.latency.p99 < 25, `${result.latency.p99} ms`);
    check('NFR-2  >= 5,000 req/s', result.requests.average >= 5000, `${Math.round(result.requests.average)} req/s`);
    check('NFR-3  hit ratio > 95%', effectiveness > 95, `${effectiveness}%`);
    check('       zero 5xx', errors <= 0 && result.errors === 0, `${Math.max(0, errors)} errors`);
    log('');
  } else {
    log('  (metrics endpoint unreachable — cache figures unavailable)');
    log('');
  }

  void status2xx3xx;
}

function check(label, pass, actual) {
  log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} ${actual}`);
}

main().catch((err) => {
  log(`Load test failed: ${err.message}`);
  process.exit(1);
});
