import { describe, it, expect } from "vitest";
import { InMemoryAccessPolicyStore } from "../testing/InMemoryAccessPolicyStore.js";
import { InMemoryApprovalStore } from "../testing/InMemoryApprovalStore.js";

describe("InMemoryAccessPolicyStore", () => {
  it("round-trips a policy and isolates by workspace", async () => {
    const s = new InMemoryAccessPolicyStore();
    await s.putPolicy({
      agentId: "a1", workspaceId: "ws1",
      readScopes: ["memory:read"], writeScopes: [],
      selfEdit: { enabled: false },
      taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
      limits: { maxRecallsPerMinute: 1, maxWritesPerMinute: 1, maxSessionsConcurrent: 1, maxSelfEditsPerSession: 1 },
      requireApprovalFor: [], federationAccess: "none",
    });
    expect(await s.getPolicy("ws1", "a1")).not.toBeNull();
    expect(await s.getPolicy("ws2", "a1")).toBeNull();
  });
});

describe("InMemoryApprovalStore", () => {
  it("creates pending, then resolves", async () => {
    const s = new InMemoryApprovalStore();
    const ar = await s.create({
      workspaceId: "ws1", requestedBy: "a1", trigger: "delete_fact",
      resource: "fact", resourceId: "f1", payload: {}, expiresAt: new Date(Date.now() + 60_000), // determinism-ok: future expiry ensures non-expired; value not asserted
    });
    expect((await s.get("ws1", ar.id))?.status).toBe("pending");
    await s.resolve("ws1", ar.id, "approved", "operator");
    expect((await s.get("ws1", ar.id))?.status).toBe("approved");
  });
});
