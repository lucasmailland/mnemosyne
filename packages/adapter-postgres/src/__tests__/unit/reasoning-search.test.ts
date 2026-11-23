import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

const WS = "11111111-1111-1111-1111-111111111111";

describe("reasoning cache adapter methods (InMemory, spec §8)", () => {
  it("recordReasoningUse bumps usage_count and last_used_at; setReasoningStatus transitions", async () => {
    const s = new InMemoryStorageAdapter();
    const r = await s.createReasoning({
      workspaceId: WS,
      question: "How to deploy?",
      chain: [{ step: 0, reasoning: "check CI" }],
      conclusion: "merge then deploy",
    } as any);
    expect(r.usageCount).toBe(0);

    await s.recordReasoningUse(r.id, WS);
    const after = await s.getReasoning(r.id, WS);
    expect(after!.usageCount).toBe(1);
    expect(after!.lastUsedAt).toBeInstanceOf(Date);

    await s.setReasoningStatus(r.id, WS, "quarantined");
    expect((await s.getReasoning(r.id, WS))!.status).toBe("quarantined");
  });

  it("searchReasoning returns servable candidates and respects includeAllStatuses", async () => {
    const s = new InMemoryStorageAdapter();
    const active = await s.createReasoning({ workspaceId: WS, question: "q1", chain: [{ step: 0, reasoning: "r" }], conclusion: "c1" } as any);
    const quar = await s.createReasoning({ workspaceId: WS, question: "q2", chain: [{ step: 0, reasoning: "r" }], conclusion: "c2" } as any);
    await s.setReasoningStatus(quar.id, WS, "quarantined");

    const servable = await s.searchReasoning({ workspaceId: WS, vector: new Array(1536).fill(0), limit: 10 });
    expect(servable.map((c) => c.id)).toContain(active.id);
    expect(servable.map((c) => c.id)).not.toContain(quar.id);

    const all = await s.searchReasoning({ workspaceId: WS, vector: new Array(1536).fill(0), limit: 10, includeAllStatuses: true });
    expect(all.map((c) => c.id)).toContain(quar.id);
  });
});
