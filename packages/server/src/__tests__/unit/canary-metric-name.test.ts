import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The SLO queries of .github/workflows/deploy-canary.yml live in this script.
const wf = readFileSync(
  fileURLToPath(new URL("../../../../../scripts/canary-slo-check.mjs", import.meta.url)),
  "utf8"
);

describe("canary SLO metric name (C9)", () => {
  it("queries the emitted histogram name mnemo_recall_duration_seconds_bucket", () => {
    expect(wf).toMatch(/mnemo_recall_duration_seconds_bucket/);
  });
  it("no longer queries the stale mnemo_recall_latency_seconds_bucket", () => {
    expect(wf).not.toMatch(/mnemo_recall_latency_seconds_bucket/);
  });
});
