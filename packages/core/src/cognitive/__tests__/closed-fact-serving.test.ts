import { describe, expect, it, vi } from "vitest";
import { ftsFallbackRecall } from "../recall-cold.js";
import type { AuthContext, PointerCandidate } from "@mnemo-ai/types";

describe("closed fact serving", () => {
  it("rejects closed FTS-only candidates", async () => {
    const candidate: PointerCandidate = {
      factId: "closed",
      statement: "closed statement",
      embedding: null,
      sensitivity: "internal",
      worth: 0.9,
      attribution: "user_stated",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      status: "forgotten",
      validTo: new Date("2026-02-01T00:00:00Z"),
    };
    const ctx = {
      storage: { ftsCandidates: vi.fn(async () => [candidate]) },
      config: {},
    } as never;
    const auth = { sensitivityCeiling: "restricted", scopes: [] } as unknown as AuthContext;

    await expect(ftsFallbackRecall(
      ctx,
      { workspaceId: "ws", text: "closed", limit: 10 } as never,
      auth,
    )).resolves.toEqual([]);
  });
});
