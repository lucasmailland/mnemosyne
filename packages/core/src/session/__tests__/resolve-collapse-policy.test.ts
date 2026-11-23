import { describe, it, expect } from "vitest";
import { resolveCollapsePolicy, DEFAULT_COLLAPSE_POLICY } from "../collapse-policy.js";
import type { MnemoAgentProfile } from "@mnemo-ai/types";

function profile(metadata: Record<string, unknown>): MnemoAgentProfile {
  return {
    workspaceId: "ws",
    agentId: "a",
    summary: "",
    metadata,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  };
}

describe("resolveCollapsePolicy", () => {
  it("returns documented spec defaults when profile is null", () => {
    const p = resolveCollapsePolicy(null);
    expect(p).toEqual(DEFAULT_COLLAPSE_POLICY);
    expect(p.mode).toBe("auto");
    expect(p.maxTurns).toBe(50);
    expect(p.maxTokens).toBe(8192);
    expect(p.inactivityTimeout).toBe(1800);
    expect(p.minTurnsForCollapse).toBe(3);
    expect(p.recurrenceThreshold).toBe(0.6);
  });

  it("returns defaults when profile has no collapsePolicy in metadata", () => {
    expect(resolveCollapsePolicy(profile({ summary: "x" }))).toEqual(DEFAULT_COLLAPSE_POLICY);
  });

  it("overlays valid per-agent fields onto defaults", () => {
    const p = resolveCollapsePolicy(
      profile({ collapsePolicy: { maxTurns: 5, requirePin: true, mode: "hybrid" } }),
    );
    expect(p.maxTurns).toBe(5);
    expect(p.requirePin).toBe(true);
    expect(p.mode).toBe("hybrid");
    // untouched fields keep defaults
    expect(p.maxTokens).toBe(8192);
    expect(p.minTurnsForCollapse).toBe(3);
  });

  it("ignores fields with the wrong runtime type", () => {
    const p = resolveCollapsePolicy(
      profile({ collapsePolicy: { maxTurns: "lots", mode: "standard", requirePin: 1 } }),
    );
    expect(p.maxTurns).toBe(50);     // string rejected
    expect(p.mode).toBe("auto");      // invalid enum rejected
    expect(p.requirePin).toBe(false); // non-boolean rejected
  });

  it("never mutates DEFAULT_COLLAPSE_POLICY", () => {
    const p = resolveCollapsePolicy(profile({ collapsePolicy: { maxTurns: 1 } }));
    expect(p.maxTurns).toBe(1);
    expect(DEFAULT_COLLAPSE_POLICY.maxTurns).toBe(50);
  });
});
