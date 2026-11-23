// Self-contained Prometheus metrics for the adapter-redis package.
// Intentionally imports NOTHING from @mnemo-ai/server or @mnemo-ai/core —
// adapter-layer must not depend upward (hexagonal purity).

function formatLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
  );
  return parts.length ? `{${parts.join(",")}}` : "";
}

// ─── Counter ──────────────────────────────────────────────────────────────────

interface CounterSample {
  labels: Record<string, string>;
  value: number;
}

class Counter {
  private samples = new Map<string, CounterSample>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  clearSamples(): void {
    this.samples.clear();
  }

  inc(labels: Record<string, string>, value = 1): void {
    const key = JSON.stringify(labels);
    const existing = this.samples.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.samples.set(key, { labels, value });
    }
  }

  toLines(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const s of this.samples.values()) {
      lines.push(`${this.name}${formatLabels(s.labels)} ${s.value}`);
    }
    return lines;
  }
}

// ─── Gauge ────────────────────────────────────────────────────────────────────

interface GaugeSample {
  labels: Record<string, string>;
  value: number;
}

class Gauge {
  private samples = new Map<string, GaugeSample>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  clearSamples(): void {
    this.samples.clear();
  }

  set(labels: Record<string, string>, value: number): void {
    const key = JSON.stringify(labels);
    this.samples.set(key, { labels, value });
  }

  toLines(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const s of this.samples.values()) {
      lines.push(`${this.name}${formatLabels(s.labels)} ${s.value}`);
    }
    return lines;
  }
}

// ─── Histogram ────────────────────────────────────────────────────────────────

interface HistogramSample {
  labels: Record<string, string>;
  buckets: Map<number, number>;
  count: number;
  sum: number;
}

class Histogram {
  private samples = new Map<string, HistogramSample>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {}

  clearSamples(): void {
    this.samples.clear();
  }

  observe(labels: Record<string, string>, value: number): void {
    const key = JSON.stringify(labels);
    let s = this.samples.get(key);
    if (!s) {
      s = { labels, buckets: new Map(), count: 0, sum: 0 };
      for (const le of this.buckets) s.buckets.set(le, 0);
      this.samples.set(key, s);
    }
    for (const le of this.buckets) {
      if (value <= le) s.buckets.set(le, (s.buckets.get(le) ?? 0) + 1);
    }
    s.count++;
    s.sum += value;
  }

  toLines(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const s of this.samples.values()) {
      for (const [le, cnt] of s.buckets) {
        lines.push(
          `${this.name}_bucket${formatLabels({ ...s.labels, le: String(le) })} ${cnt}`,
        );
      }
      lines.push(
        `${this.name}_bucket${formatLabels({ ...s.labels, le: "+Inf" })} ${s.count}`,
      );
      lines.push(`${this.name}_sum${formatLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${formatLabels(s.labels)} ${s.count}`);
    }
    return lines;
  }
}

// ─── Metric instances ─────────────────────────────────────────────────────────

export const redisOperations = new Counter(
  "mnemo_redis_operations_total",
  "Redis operations by type",
);

export const redisLatency = new Histogram(
  "mnemo_redis_latency_seconds",
  "Redis operation latency",
  [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
);

export const redisMemoryUsed = new Gauge(
  "mnemo_redis_memory_used_bytes",
  "Redis used memory in bytes",
);

type AnyMetric = Counter | Histogram | Gauge;

const ALL_REDIS_METRICS: AnyMetric[] = [
  redisOperations,
  redisLatency,
  redisMemoryUsed,
];

export function renderRedisMetrics(): string {
  return ALL_REDIS_METRICS.flatMap((m) => m.toLines()).join("\n") + "\n";
}

/** For test isolation only — clears all metric samples. */
export function resetRedisMetricsForTesting(): void {
  for (const m of ALL_REDIS_METRICS) m.clearSamples();
}
