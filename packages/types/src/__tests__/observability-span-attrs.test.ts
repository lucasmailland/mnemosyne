// packages/types/src/__tests__/observability-span-attrs.test.ts
import { describe, it, expect } from "vitest";
import { MNEMO_SPAN_NAMES } from "../observability.js";
import type { MnemoSpanAttributes } from "../observability.js";

describe("MnemoSpanAttributes — spec field coverage (F18)", () => {
  it("accepts every spec attribute key without type error", () => {
    // This object MUST compile. If any key is missing from the interface,
    // tsc fails the build (excess-property check on a typed literal).
    const a: MnemoSpanAttributes = {
      "mnemo.workspace_id": "ws1",
      "mnemo.agent_id": "agent1",
      "mnemo.session_id": "sess1",
      "mnemo.trace_id": "trace1",
      "mnemo.operation": "recall",
      "mnemo.tier_hit": "hot",
      "mnemo.cache_hit": true,
      "mnemo.result_count": 3,
      "mnemo.worth_avg": 0.42,
      "mnemo.tokens_saved": 0,
      "mnemo.llm_tokens_used": 0,
      "mnemo.llm_cost_usd": 0,
    };
    expect(a["mnemo.result_count"]).toBe(3);
    expect(a["mnemo.tier_hit"]).toBe("hot");
  });

  it("exposes a canonical `write` span name aliased to mnemo.remember", () => {
    expect(MNEMO_SPAN_NAMES.write).toBe("mnemo.remember");
    expect(MNEMO_SPAN_NAMES.recall).toBe("mnemo.recall");
  });
});
