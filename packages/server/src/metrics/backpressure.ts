/**
 * §34.8 + §34.10 backpressure metrics (MEMORY_IMPROVEMENT.md:3686-3690, 3766-3768).
 * Local Gauge primitive — if Wave V's Gauge is already exported from ./index.js,
 * delete this class and import from there instead.
 */
interface GaugeSample { labels: Record<string, string>; value: number; }

class Gauge {
  private samples = new Map<string, GaugeSample>();
  constructor(readonly name: string, readonly help: string) {}
  set(labels: Record<string, string>, value: number): void {
    this.samples.set(JSON.stringify(labels), { labels, value });
  }
  toLines(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const s of this.samples.values()) lines.push(`${this.name}${fmt(s.labels)} ${s.value}`);
    return lines;
  }
}

class Counter {
  private samples = new Map<string, { labels: Record<string, string>; value: number }>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Record<string, string>, value = 1): void {
    const k = JSON.stringify(labels);
    const e = this.samples.get(k);
    if (e) e.value += value; else this.samples.set(k, { labels, value });
  }
  toLines(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const s of this.samples.values()) lines.push(`${this.name}${fmt(s.labels)} ${s.value}`);
    return lines;
  }
}

function fmt(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

export const queueDepth = new Gauge("mnemo_queue_depth", "Queue depth by priority + job key");
export const queueLagSeconds = new Gauge("mnemo_queue_lag_seconds", "Seconds a job is behind schedule");
export const queueShedTotal = new Counter("mnemo_queue_shed_total", "Jobs shed by backpressure stage");
export const pgPoolUtilization = new Gauge("mnemo_pg_pool_utilization", "Active/total PG pool ratio");
export const wsBufferDepth = new Gauge("mnemo_ws_buffer_depth", "Per-connection WS buffer depth");
export const wsDropsTotal = new Counter("mnemo_ws_drops_total", "WS events dropped by reason");
export const wsSlowConsumers = new Gauge("mnemo_ws_slow_consumers", "Connections currently in slow-consumer mode");

const ALL: Array<Gauge | Counter> = [
  queueDepth, queueLagSeconds, queueShedTotal, pgPoolUtilization,
  wsBufferDepth, wsDropsTotal, wsSlowConsumers,
];

export function renderBackpressureMetrics(): string {
  return ALL.flatMap((m) => m.toLines()).join("\n") + "\n";
}
