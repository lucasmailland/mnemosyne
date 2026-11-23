/**
 * Bench regression gate. Compares bench-results.json against
 * bench-baseline.json. Fails (exit 1) if any task's hz drops by more
 * than TOLERANCE below baseline, or p99 grows by more than P99_TOLERANCE above
 * AND by more than P99_FLOOR_MS in absolute terms. The tail gets its own,
 * wider bar: a 500ms run leaves a handful of samples past p99, and back-to-back
 * runs of identical code moved it up to 66% while hz stayed within 5%.
 * New tasks (not in baseline) are reported but do not fail the gate.
 */
import { readFileSync } from "node:fs";

interface Task {
  name: string;
  hz: number;
  p99: number;
}
interface Bench {
  tasks: Task[];
}

const TOLERANCE = Number(process.env.BENCH_TOLERANCE ?? "0.25"); // 25%
const P99_TOLERANCE = Number(process.env.BENCH_P99_TOLERANCE ?? "1"); // 2x
const P99_FLOOR_MS = Number(process.env.BENCH_P99_FLOOR_MS ?? "0.05"); // 50µs

function load(path: string): Bench {
  return JSON.parse(readFileSync(path, "utf8")) as Bench;
}

const baseline = load(process.env.BENCH_BASELINE ?? "bench-baseline.json");
const current = load(process.env.BENCH_RESULTS ?? "bench-results.json");
const byName = new Map(baseline.tasks.map((t) => [t.name, t]));

const failures: string[] = [];
for (const t of current.tasks) {
  const base = byName.get(t.name);
  if (!base) {
    console.log(`NEW   ${t.name} (hz=${Math.round(t.hz)}) — not in baseline, skipping`);
    continue;
  }
  const hzDrop = (base.hz - t.hz) / base.hz; // >0 means slower
  const p99Grow = base.p99 > 0 ? (t.p99 - base.p99) / base.p99 : 0;
  const slowHz = hzDrop > TOLERANCE;
  const slowP99 = p99Grow > P99_TOLERANCE && t.p99 - base.p99 > P99_FLOOR_MS;
  const tag = slowHz || slowP99 ? "FAIL " : "ok   ";
  console.log(
    `${tag}${t.name}  hzΔ=${(hzDrop * 100).toFixed(1)}%  p99Δ=${(p99Grow * 100).toFixed(1)}%`
  );
  if (slowHz)
    failures.push(`${t.name}: hz dropped ${(hzDrop * 100).toFixed(1)}% (> ${TOLERANCE * 100}%)`);
  if (slowP99)
    failures.push(`${t.name}: p99 grew ${(p99Grow * 100).toFixed(1)}% (> ${P99_TOLERANCE * 100}%)`);
}

if (failures.length > 0) {
  console.error(`\nBenchmark regression gate FAILED:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log(
  `\nBenchmark regression gate passed (hz ${TOLERANCE * 100}%, p99 ${P99_TOLERANCE * 100}%).`
);
