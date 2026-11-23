/**
 * packages/server/loadtest/run.ts — VER-2 autocannon load-test runner
 *
 * Targets a running loadtest server (started with `pnpm loadtest:server`).
 * Runs two scenarios back-to-back:
 *   1. Recall (read)  — 1000 RPS target, p99 ≤ 10 ms (hot-tier spec)
 *   2. Write (create) — 100  RPS target, p99 ≤ 100 ms
 *
 * Usage:
 *   LOADTEST_PORT=3939 MNEMO_API_KEY=mk_dev_... pnpm --filter @mnemo-ai/server loadtest:run
 *
 * Env vars:
 *   LOADTEST_PORT  — port the server is listening on (default 3939)
 *   LOADTEST_HOST  — hostname (default 127.0.0.1)
 *   MNEMO_API_KEY  — API key with read+write scopes (required)
 *   LT_DURATION    — test duration in seconds per scenario (default 30)
 *   LT_CONNECTIONS — concurrent connections (default 50)
 */

import autocannon from "autocannon";

const HOST = process.env["LOADTEST_HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["LOADTEST_PORT"] ?? 3939);
const API_KEY = process.env["MNEMO_API_KEY"];
const DURATION = Number(process.env["LT_DURATION"] ?? 30);
const CONNECTIONS = Number(process.env["LT_CONNECTIONS"] ?? 50);
const BASE_URL = `http://${HOST}:${PORT}`;

if (!API_KEY) {
  console.error("ERROR: MNEMO_API_KEY is required (e.g. mk_dev_...)");
  process.exit(1);
}

const AUTH = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

// ── Recall scenario ────────────────────────────────────────────────────────────

console.log("\n=== Scenario 1: Recall (read) — target 1000 RPS, p99 ≤ 10ms ===");

const recallBody = JSON.stringify({
  query: "load test query",
  workspaceId: "lt-workspace",
  k: 5,
  // Pass a pre-embedded zero-vector so we bypass LLM and hit only hot-tier.
  vector: new Array(1536).fill(0),
});

const recallResult = await new Promise<autocannon.Result>((resolve, reject) => {
  const instance = autocannon(
    {
      url: `${BASE_URL}/recall`,
      method: "POST",
      headers: AUTH,
      body: recallBody,
      duration: DURATION,
      connections: CONNECTIONS,
      pipelining: 1,
      timeout: 10,
    },
    (err, result) => {
      if (err) reject(err);
      else resolve(result);
    }
  );
  autocannon.track(instance, { renderProgressBar: true });
});

printResult("Recall", recallResult, { targetRps: 1000, p99ThresholdMs: 10 });

// ── Write scenario ─────────────────────────────────────────────────────────────

console.log("\n=== Scenario 2: Write (create fact) — target 100 RPS, p99 ≤ 100ms ===");

const writeBody = JSON.stringify({
  workspaceId: "lt-workspace",
  content: "load test fact content",
  kind: "other",
  source: "loadtest",
});

const writeResult = await new Promise<autocannon.Result>((resolve, reject) => {
  const instance = autocannon(
    {
      url: `${BASE_URL}/facts`,
      method: "POST",
      headers: AUTH,
      body: writeBody,
      duration: DURATION,
      connections: Math.min(CONNECTIONS, 20),
      pipelining: 1,
      timeout: 10,
    },
    (err, result) => {
      if (err) reject(err);
      else resolve(result);
    }
  );
  autocannon.track(instance, { renderProgressBar: true });
});

printResult("Write", writeResult, { targetRps: 100, p99ThresholdMs: 100 });

// ── Summary ────────────────────────────────────────────────────────────────────

function printResult(
  label: string,
  result: autocannon.Result,
  spec: { targetRps: number; p99ThresholdMs: number }
): void {
  const rps = result.requests.average;
  const p99 = result.latency.p99;
  const rpsOk = rps >= spec.targetRps;
  const p99Ok = p99 <= spec.p99ThresholdMs;

  console.log(`\n${label} results:`);
  console.log(`  RPS:    ${rps.toFixed(0)} ${rpsOk ? "✓" : `✗ (target: ${spec.targetRps})`}`);
  console.log(`  p50:    ${result.latency.p50} ms`);
  console.log(`  p99:    ${p99} ms ${p99Ok ? "✓" : `✗ (target: ≤${spec.p99ThresholdMs}ms)`}`);
  console.log(`  errors: ${result.errors} / ${result.requests.total} requests`);
  console.log(`  status: ${rpsOk && p99Ok ? "PASS ✓" : "FAIL ✗"}`);
}
