// Self-contained Prometheus metrics for the adapter-postgres package.
// Intentionally imports NOTHING from @mnemo-ai/server or @mnemo-ai/core —
// adapter-layer must not depend upward (hexagonal purity).

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

function formatLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
  );
  return parts.length ? `{${parts.join(",")}}` : "";
}

const BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

export const pgQueryDuration = new Histogram(
  "mnemo_pg_query_duration_seconds",
  "PG query latency by class",
  BUCKETS,
);

export const pgPoolWaitDuration = new Histogram(
  "mnemo_pg_pool_wait_duration_seconds",
  "Time spent waiting for a pooled PG connection",
  BUCKETS,
);

const ALL_ADAPTER_METRICS: Histogram[] = [pgQueryDuration, pgPoolWaitDuration];

export function renderAdapterMetrics(): string {
  return ALL_ADAPTER_METRICS.flatMap((m) => m.toLines()).join("\n") + "\n";
}

/** For test isolation only — clears all histogram samples. */
export function resetAdapterMetricsForTesting(): void {
  for (const m of ALL_ADAPTER_METRICS) m.clearSamples();
}
