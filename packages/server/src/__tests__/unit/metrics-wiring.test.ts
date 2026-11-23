import { describe, it, expect } from "vitest";

// Import counters we want to verify are wired (OPS-2)
// B1.3: consolidationTotal → consolidationDecisionsTotal (label "outcome" → "decision")
import {
  authFailuresTotal,
  consolidationDecisionsTotal,
  vectorUpsertTotal,
} from "../../metrics/index.js";

// Access private sample map via renderMetrics text output
import { renderMetrics } from "../../metrics/index.js";

describe("domain counters are exported and incrementable (OPS-2)", () => {
  it("authFailuresTotal increments and renders in Prometheus output", () => {
    authFailuresTotal.inc({ adapter: "test", reason: "wiring_check" });
    const output = renderMetrics();
    expect(output).toContain("mnemo_auth_failures_total");
    expect(output).toContain('adapter="test"');
    expect(output).toContain('reason="wiring_check"');
  });

  // B1.3: renamed mnemo_consolidation_total{outcome} → mnemo_consolidation_decisions_total{decision}
  it("consolidationDecisionsTotal increments by value and renders correct count", () => {
    consolidationDecisionsTotal.inc({ decision: "merged" }, 3);
    const output = renderMetrics();
    expect(output).toContain("mnemo_consolidation_decisions_total");
    expect(output).toContain('decision="merged"');
    // The line should contain a number >= 3
    const match = output.match(/mnemo_consolidation_decisions_total\{decision="merged"\} (\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(3);
  });

  it("vectorUpsertTotal increments and renders", () => {
    vectorUpsertTotal.inc({ tier: "team", kind: "fact" });
    const output = renderMetrics();
    expect(output).toContain("mnemo_vector_upsert_total");
    expect(output).toContain('tier="team"');
  });
});
