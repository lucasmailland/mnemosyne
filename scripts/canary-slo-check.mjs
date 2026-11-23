#!/usr/bin/env node
// SLO gate for .github/workflows/deploy-canary.yml. Asks Prometheus for the 5xx
// ratio and the recall p99 of the machines on the candidate image and of a
// baseline, passes both to evaluateCanary (packages/core/src/cognitive/canary.ts)
// and writes `decision=<...>` to $GITHUB_OUTPUT. Exits 0 only on "promote".
//
// Series are split by image through mnemo_build_info{image} (FLY_IMAGE_REF),
// joined on `instance`, so Prometheus must scrape each machine as its own
// target. Mode "split" (canary stages): candidate machines vs the others, now.
// Mode "history" (after the full rollout): candidate machines now vs the others
// one hour earlier. A missing or empty series (no traffic, no per-machine
// scrape, an image ref without the tag) is no data, so the decision is "hold".
//
//   PROMETHEUS_URL=https://prom.example/api/v1 CANARY_IMAGE_TAG=sha-abc1234 \
//     node scripts/canary-slo-check.mjs "1 machine" split

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** PromQL label matcher for the image ref of `tag` ("registry/app:tag" or "...:tag@sha256:..."). */
export function imageMatcher(tag, negate = false) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag ?? "")) {
    throw new Error(`CANARY_IMAGE_TAG is not a valid image tag: "${tag}"`);
  }
  return `image${negate ? "!~" : "=~"}".*:${tag.replace(/\./g, "\\\\.")}(@.*)?"`;
}

// `off` is "" for now or " offset 1h"; it applies to every selector.
const byImage = (sel, off) => `* on(instance) group_left mnemo_build_info{${sel}}${off}`;
const errorRatio = (sel, off) =>
  `sum(rate(mnemo_requests_total{status=~"5.."}[5m]${off}) ${byImage(sel, off)})` +
  ` / sum(rate(mnemo_requests_total[5m]${off}) ${byImage(sel, off)})`;
const recallP99Ms = (sel, off) =>
  `histogram_quantile(0.99, sum by (le) (rate(mnemo_recall_duration_seconds_bucket[5m]${off}) ${byImage(sel, off)})) * 1000`;

export async function checkStage({ prom, tag, mode, evaluate, fetchImpl = fetch }) {
  if (!prom) return { decision: "hold", reason: "PROMETHEUS_URL is not set" };
  if (mode !== "split" && mode !== "history") throw new Error(`unknown mode "${mode}"`);
  const candidate = imageMatcher(tag);
  const others = imageMatcher(tag, true);
  const baseOff = mode === "history" ? " offset 1h" : "";
  const query = async (expr) => {
    const res = await fetchImpl(`${prom}/query?query=${encodeURIComponent(expr)}`);
    const v = parseFloat((await res.json())?.data?.result?.[0]?.value?.[1]);
    // 0/0 (no requests in the window) is NaN: no data, never a pass.
    return Number.isFinite(v) ? v : null;
  };
  const [baseErr, candErr, baseP99, candP99] = await Promise.all([
    query(errorRatio(others, baseOff)),
    query(errorRatio(candidate, "")),
    query(recallP99Ms(others, baseOff)),
    query(recallP99Ms(candidate, "")),
  ]);
  const baseline = baseErr != null && baseP99 != null ? { errorRate: baseErr, p99: baseP99 } : null;
  const canary = candErr != null && candP99 != null ? { errorRate: candErr, p99: candP99 } : null;
  return { decision: evaluate(baseline, canary), baseline, canary };
}

async function main() {
  const [stage = "stage", mode = "split"] = process.argv.slice(2);
  const { evaluateCanary } = await import(
    new URL("../packages/core/dist/cognitive.js", import.meta.url).href
  );
  const result = await checkStage({
    prom: process.env.PROMETHEUS_URL,
    tag: process.env.CANARY_IMAGE_TAG,
    mode,
    evaluate: evaluateCanary,
  });
  console.log(`SLO decision at ${stage}:`, JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `decision=${result.decision}\n`);
  }
  if (result.decision === "promote") return;
  console.error(
    result.decision === "rollback"
      ? `SLO degraded at ${stage}.`
      : `Not enough data at ${stage} (${result.reason ?? "no candidate or baseline series"}).`
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
