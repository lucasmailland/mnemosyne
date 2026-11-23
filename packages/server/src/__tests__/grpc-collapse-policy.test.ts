import { describe, it, expect } from "vitest";
import { resolveCollapsePolicyForSession } from "../grpc-collapse-policy.js";

describe("resolveCollapsePolicyForSession (gRPC, F2)", () => {
  it("returns the agent profile policy when storage + agentId resolve", async () => {
    const storage: any = {
      getSession: async () => ({ id: "s1", workspaceId: "ws", agentId: "ag" }),
      getAgentProfile: async () => ({
        workspaceId: "ws", agentId: "ag", summary: "",
        metadata: { collapsePolicy: { maxTurns: 7, mode: "explicit" } },
        createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      }),
    };
    const p = await resolveCollapsePolicyForSession(storage, "s1", "ws");
    expect(p.maxTurns).toBe(7);
    expect(p.mode).toBe("explicit");
    expect(p.maxTokens).toBe(8192); // default overlay
  });

  it("returns documented defaults when storage is undefined", async () => {
    const p = await resolveCollapsePolicyForSession(undefined, "s1", "ws");
    expect(p.maxTurns).toBe(50);
    expect(p.mode).toBe("auto");
  });

  it("returns defaults when the session has no agentId", async () => {
    const storage: any = { getSession: async () => ({ id: "s1", workspaceId: "ws", agentId: undefined }) };
    const p = await resolveCollapsePolicyForSession(storage, "s1", "ws");
    expect(p.maxTurns).toBe(50);
  });
});
