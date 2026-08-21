/**
 * A minimal Prometheus registry — counters, gauges, and histograms, no
 * dependency (Rules.md §1).
 *
 * Scope is chosen to stay honest about cardinality: labels are bounded sets
 * (route template, method, status class), never raw paths or codes. A label per
 * short code would mint a new time series per link and take down the scrape
 * target long before it took down the app.
 */

export type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${escapeLabel(labels[k] as string)}"`).join(',');
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: string,
  ) {}
  abstract render(): string[];
}

class Counter extends Metric {
  private readonly values = new Map<string, number>();

  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string[] {
    return [...this.values.entries()].map(
      ([key, value]) => `${this.name}${key === '' ? '' : `{${key}}`} ${value}`,
    );
  }
}

class Gauge extends Metric {
  private readonly values = new Map<string, number>();

  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), value);
  }

  render(): string[] {
    return [...this.values.entries()].map(
      ([key, value]) => `${this.name}${key === '' ? '' : `{${key}}`} ${value}`,
    );
  }
}

/** Cumulative histogram in the Prometheus sense: each bucket counts <= le. */
class Histogram extends Metric {
  private readonly buckets: number[];
  private readonly counts = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly totals = new Map<string, number>();

  constructor(name: string, help: string, buckets: number[]) {
    super(name, help, 'histogram');
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let counts = this.counts.get(key);
    if (counts === undefined) {
      counts = new Array<number>(this.buckets.length).fill(0);
      this.counts.set(key, counts);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] as number)) counts[i] = (counts[i] as number) + 1;
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
  }

  render(): string[] {
    const lines: string[] = [];
    for (const [key, counts] of this.counts) {
      const prefix = key === '' ? '' : `${key},`;
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket{${prefix}le="${this.buckets[i]}"} ${counts[i]}`);
      }
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${this.totals.get(key) ?? 0}`);
      lines.push(`${this.name}_sum${key === '' ? '' : `{${key}}`} ${this.sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count${key === '' ? '' : `{${key}}`} ${this.totals.get(key) ?? 0}`);
    }
    return lines;
  }
}

/**
 * The application's metric set.
 *
 * `instance` is attached to every series so a scrape across replicas shows
 * which replica served what — the evidence that the load balancer is actually
 * spreading traffic (Phases.md Phase 6).
 */
export class Metrics {
  readonly registry: Metric[] = [];

  readonly httpRequests = this.register(
    new Counter('kestrel_http_requests_total', 'HTTP requests by route, method and status'),
  );
  readonly httpDuration = this.register(
    new Histogram(
      'kestrel_http_request_duration_seconds',
      'HTTP request latency in seconds',
      [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    ),
  );
  readonly cacheEvents = this.register(
    new Counter('kestrel_cache_events_total', 'Cache lookups by tier and outcome'),
  );
  readonly rateLimitRejections = this.register(
    new Counter('kestrel_rate_limit_rejections_total', 'Requests rejected by the rate limiter'),
  );
  readonly shardQueries = this.register(
    new Counter('kestrel_shard_queries_total', 'Database queries by shard and operation'),
  );
  readonly redirects = this.register(
    new Counter('kestrel_redirects_total', 'Redirects served by outcome'),
  );
  readonly linksCreated = this.register(new Counter('kestrel_links_created_total', 'Links created'));
  readonly clicksBuffered = this.register(
    new Gauge('kestrel_clicks_buffered', 'Click deltas awaiting flush'),
  );
  readonly l1Size = this.register(new Gauge('kestrel_l1_cache_entries', 'Entries in the L1 cache'));
  readonly dependencyUp = this.register(
    new Gauge('kestrel_dependency_up', 'Dependency reachability, 1 = up'),
  );
  readonly buildInfo = this.register(new Gauge('kestrel_build_info', 'Build and instance metadata'));

  constructor(private readonly instance: string) {
    this.buildInfo.set(1, { instance });
  }

  private register<T extends Metric>(metric: T): T {
    this.registry.push(metric);
    return metric;
  }

  /** Fold the instance label into every series so cross-replica scrapes stay distinguishable. */
  withInstance(labels: Labels = {}): Labels {
    return { ...labels, instance: this.instance };
  }

  recordCache(tier: 'l1' | 'l2' | 'l3', outcome: 'hit' | 'miss' | 'negative'): void {
    this.cacheEvents.inc(this.withInstance({ tier, outcome }));
  }

  recordShardQuery(shard: number, operation: string): void {
    this.shardQueries.inc(this.withInstance({ shard: String(shard), operation }));
  }

  /** Prometheus text exposition format v0.0.4. */
  render(): string {
    const lines: string[] = [];
    for (const metric of this.registry) {
      const body = metric.render();
      if (body.length === 0) continue;
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      lines.push(...body);
    }
    return `${lines.join('\n')}\n`;
  }
}
