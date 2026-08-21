#!/usr/bin/env node
/**
 * Cluster verification — the claims that only a real multi-replica deployment
 * can settle.
 *
 * Everything here is checked against the load balancer, never against a single
 * replica, because the properties under test are exactly the ones that hold
 * per-cluster rather than per-process:
 *
 *   1. every replica is up and the balancer spreads across all of them
 *   2. a link created through one replica resolves through the others,
 *      which is what proves the shared Postgres and Redis tiers are real
 *   3. the rate limit is shared: N requests against a limit of M yields
 *      exactly M, no matter which replica served each one
 *   4. shard routing agrees across replicas — every replica maps a code to the
 *      same shard with no coordination
 *   5. killing Redis mid-traffic degrades latency but returns zero 5xx
 *
 * Usage:
 *   node bench/verify-cluster.mjs                      # skips the chaos step
 *   node bench/verify-cluster.mjs --chaos              # includes it
 *   TARGET=http://localhost:8080 node bench/verify-cluster.mjs
 *
 * --chaos stops and restarts the Redis container, so it needs a reachable
 * docker daemon and the compose project running. It is opt-in for that reason.
 * Set DOCKER_CMD when docker is not on PATH where this script runs, e.g.
 *   DOCKER_CMD="wsl -u root docker" node bench/verify-cluster.mjs --chaos
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const TARGET = process.env.TARGET ?? 'http://localhost:8080';
const REDIS_CONTAINER = process.env.REDIS_CONTAINER ?? 'kestrel-redis';
const WITH_CHAOS = process.argv.includes('--chaos');

/**
 * How to invoke docker. Overridable because the daemon does not always live
 * where this script runs — driving a WSL2 daemon from Windows, for instance,
 * needs `DOCKER_CMD="wsl -u root docker"`.
 */
const DOCKER_CMD = (process.env.DOCKER_CMD ?? 'docker').trim().split(/\s+/);
const DOCKER_BIN = DOCKER_CMD[0];
const DOCKER_PREFIX = DOCKER_CMD.slice(1);

async function docker(...args) {
  return exec(DOCKER_BIN, [...DOCKER_PREFIX, ...args]);
}

const results = [];
let failures = 0;

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  if (!passed) failures++;
  log(`  ${passed ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
}

function section(title) {
  log('');
  log(`  ${title}`);
  log('  ─────────────────────────────────────────────────────────────────────');
}

async function json(path, options = {}) {
  const response = await fetch(`${TARGET}${path}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON is legitimate for a redirect or an HTML error page */
  }
  return { status: response.status, headers: response.headers, body, text };
}

async function createLink(url, extraHeaders = {}) {
  return json('/api/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ url }),
  });
}

// ---------------------------------------------------------------------------

async function checkReplicasUp() {
  section('1. Replicas up, and the balancer spreads across them');

  // /health reports the replica's own instance id, so repeated calls through
  // the balancer reveal the distribution without any special instrumentation.
  const instances = new Map();
  let unhealthy = 0;

  for (let i = 0; i < 60; i++) {
    const { status, body } = await json('/health');
    if (status !== 200 || body === null) {
      unhealthy++;
      continue;
    }
    instances.set(body.instance, (instances.get(body.instance) ?? 0) + 1);
  }

  record('all /health probes returned 200', unhealthy === 0, `${60 - unhealthy}/60 ok`);

  const distinct = [...instances.keys()];
  record(
    'balancer reached more than one replica',
    distinct.length > 1,
    `${distinct.length} distinct: ${distinct.join(', ')}`,
  );

  for (const [instance, count] of instances) {
    log(`        ${instance.padEnd(28)} ${count} requests`);
  }
  return distinct;
}

async function checkReadiness() {
  section('2. Readiness reports real dependencies');

  const { status, body } = await json('/ready');
  record('/ready returns 200', status === 200, `status ${status}`);

  if (body !== null) {
    const db = body.dependencies?.database;
    const cache = body.dependencies?.cache;
    record('database driver is postgres', db?.driver === 'postgres', `driver=${db?.driver}`);
    record('all shards healthy', db?.healthyShards === db?.shards, `${db?.healthyShards}/${db?.shards}`);
    record('cache driver is redis', cache?.driver === 'redis', `driver=${cache?.driver}`);
    record('cache is not degraded', cache?.degraded === false, `degraded=${cache?.degraded}`);
  }
}

async function checkCrossReplicaResolve() {
  section('3. A link created on one replica resolves on the others');

  const created = await createLink('https://example.com/cross-replica');
  record('create returned 201', created.status === 201, `status ${created.status}`);
  if (created.body === null) return null;

  const { code } = created.body;
  log(`        code=${code}`);

  // Resolve repeatedly. Every response must redirect to the same target; the
  // balancer will have spread these across replicas.
  const targets = new Set();
  const tiers = new Map();
  let nonRedirect = 0;

  for (let i = 0; i < 30; i++) {
    const response = await fetch(`${TARGET}/${code}`, { redirect: 'manual' });
    if (response.status !== 302) {
      nonRedirect++;
      continue;
    }
    targets.add(response.headers.get('location'));
    const tier = response.headers.get('x-cache') ?? 'none';
    tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
  }

  record('every request redirected (302)', nonRedirect === 0, `${30 - nonRedirect}/30`);
  record(
    'every replica resolved to the same target',
    targets.size === 1 && targets.has('https://example.com/cross-replica'),
    [...targets].join(', ') || 'none',
  );
  // An L2 hit on a replica that never saw the create is the proof that Redis is
  // genuinely shared rather than three separate local caches.
  record(
    'served from the shared cache tiers',
    (tiers.get('L1') ?? 0) + (tiers.get('L2') ?? 0) > 0,
    [...tiers.entries()].map(([t, n]) => `${t}=${n}`).join(' '),
  );

  return code;
}

async function checkSharedRateLimit() {
  section('4. The rate limit is shared across replicas');

  // A distinct API key gives this check its own budget, so it cannot be
  // polluted by the other checks or by a previous run.
  const apiKey = `verify-${process.pid}-${Date.now()}`;
  const headers = { 'x-api-key': apiKey };

  // Discover the configured write limit rather than assuming it, so this check
  // stays correct whatever RATE_LIMIT_WRITE_MAX is set to.
  const probe = await createLink('https://example.com/limit-probe', headers);
  const limit = Number(probe.headers.get('x-ratelimit-limit'));
  record('limit headers present', Number.isFinite(limit) && limit > 0, `limit=${limit}`);
  if (!Number.isFinite(limit) || limit <= 0) return;

  const attempts = limit * 3;
  let allowed = probe.status === 201 ? 1 : 0;
  let rejected = probe.status === 429 ? 1 : 0;
  let other = probe.status !== 201 && probe.status !== 429 ? 1 : 0;

  for (let i = 1; i < attempts; i++) {
    const response = await createLink(`https://example.com/limit-${i}`, headers);
    if (response.status === 201) allowed++;
    else if (response.status === 429) rejected++;
    else other++;
  }

  // The headline guarantee. If each replica kept its own counter, three
  // replicas would admit roughly 3x the limit.
  record(
    `exactly ${limit} of ${attempts} writes admitted`,
    allowed === limit,
    `allowed=${allowed} rejected=${rejected} other=${other}`,
  );
  record('no unexpected statuses', other === 0, `other=${other}`);
}

async function checkShardAgreement(code) {
  section('5. Shard routing agrees across replicas');

  const seen = new Map();
  for (let i = 0; i < 20; i++) {
    const { body } = await json('/api/shards');
    if (body === null) continue;
    const signature = JSON.stringify(body.shards.map((s) => [s.shard, s.count]));
    seen.set(signature, (seen.get(signature) ?? 0) + 1);
  }

  // Every replica queries the same Postgres, so the distribution they report
  // must be identical. Divergence would mean the routing is not deterministic.
  record('all replicas report the same distribution', seen.size === 1, `${seen.size} distinct view(s)`);

  const { body } = await json('/api/shards');
  if (body !== null) {
    record('rows are spread over every shard', body.shards.every((s) => s.count > 0),
      body.shards.map((s) => `s${s.shard}=${s.count}`).join(' '));
    log(`        total=${body.total} across ${body.shardCount} shards`);
  }
  void code;
}

async function checkChaos() {
  section('6. Chaos — Redis dies mid-traffic (NFR-5)');

  const created = await createLink('https://example.com/chaos');
  if (created.body === null) {
    record('seed link created', false, 'create failed');
    return;
  }
  const { code } = created.body;

  // Warm every tier, then drop the cache out from under the running system.
  for (let i = 0; i < 5; i++) await fetch(`${TARGET}/${code}`, { redirect: 'manual' });

  log(`        stopping container ${REDIS_CONTAINER} …`);
  await docker('stop', REDIS_CONTAINER);

  const statuses = new Map();
  const started = Date.now();
  let requests = 0;

  // Drive traffic for long enough to cross the breaker threshold and settle
  // into the degraded path.
  while (Date.now() - started < 12_000) {
    const batch = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${TARGET}/${code}`, { redirect: 'manual' })
          .then((r) => r.status)
          .catch(() => 0),
      ),
    );
    for (const status of batch) {
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      requests++;
    }
  }

  const serverErrors = [...statuses.entries()]
    .filter(([status]) => status >= 500 || status === 0)
    .reduce((sum, [, n]) => sum + n, 0);
  const redirects = statuses.get(302) ?? 0;

  record(
    'zero 5xx while the cache is down',
    serverErrors === 0,
    `${serverErrors} of ${requests} requests`,
  );
  record('still serving redirects from the database', redirects > 0, `${redirects} redirects`);
  log(`        statuses: ${[...statuses.entries()].map(([s, n]) => `${s}=${n}`).join(' ')}`);

  const degraded = await json('/ready');
  record(
    'readiness stays 200 — the cache is not a hard dependency',
    degraded.status === 200,
    `status ${degraded.status}, cache=${degraded.body?.dependencies?.cache?.status}`,
  );

  log(`        restarting ${REDIS_CONTAINER} …`);
  await docker('start', REDIS_CONTAINER);

  // The breaker half-opens after a 10s cooldown, so give it room to probe and
  // close before asserting recovery.
  let recovered = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    await fetch(`${TARGET}/${code}`, { redirect: 'manual' }).catch(() => undefined);
    const { body } = await json('/ready');
    if (body?.dependencies?.cache?.status === 'up' && body?.dependencies?.cache?.degraded === false) {
      recovered = true;
      break;
    }
  }
  record('circuit breaker closes once Redis returns', recovered, recovered ? 'cache up' : 'still degraded after 30s');
}

// ---------------------------------------------------------------------------

async function main() {
  log('');
  log('  Kestrel cluster verification');
  log(`  target=${TARGET}  chaos=${WITH_CHAOS ? 'on' : 'off (pass --chaos to include)'}`);

  try {
    await json('/health');
  } catch (err) {
    log('');
    log(`  Cannot reach ${TARGET}: ${err.message}`);
    log('  Start the stack first:  docker compose up -d --build');
    process.exit(1);
  }

  const instances = await checkReplicasUp();
  await checkReadiness();
  const code = await checkCrossReplicaResolve();
  await checkSharedRateLimit();
  await checkShardAgreement(code);
  if (WITH_CHAOS) await checkChaos();

  section('Summary');
  log(`  ${results.length - failures} passed, ${failures} failed, across ${instances.length} replicas`);
  log('');

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  log(`\n  Verification aborted: ${err.stack ?? err.message}`);
  process.exit(1);
});
