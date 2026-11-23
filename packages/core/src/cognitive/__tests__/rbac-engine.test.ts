import { describe, it, expect } from "vitest";
import { evaluateAccess, type AccessRequest } from "../rbac-engine.js";
import type { AgentMemoryAccess } from "@mnemo-ai/types";

function policy(over: Partial<AgentMemoryAccess> = {}): AgentMemoryAccess {
  return {
    agentId: "a1", workspaceId: "ws1",
    readScopes: ["memory:read"],
    writeScopes: ["memory:write"],
    selfEdit: { enabled: false },
    taskScopes: { canCreate: true, canDelegate: false, canDelegateTo: [] },
    limits: { maxRecallsPerMinute: 600, maxWritesPerMinute: 120, maxSessionsConcurrent: 10, maxSelfEditsPerSession: 3 },
    requireApprovalFor: [],
    federationAccess: "none",
    ...over,
  };
}
const req = (over: Partial<AccessRequest>): AccessRequest =>
  ({ scope: "memory:read", action: "read", ...over });

describe("evaluateAccess — spec §19 enforcement", () => {
  it("allows a read within readScopes", () => {
    expect(evaluateAccess(policy(), req({ scope: "memory:read" })).decision).toBe("allow");
  });

  it("denies a write when scope not granted", () => {
    const r = evaluateAccess(policy({ writeScopes: [] }), req({ scope: "memory:write", action: "write" }));
    expect(r.decision).toBe("deny");
    expect(r.decision === "deny" && r.reason).toMatch(/scope/i);
  });

  it("returns approval_required when the op matches a requireApprovalFor trigger", () => {
    const r = evaluateAccess(
      policy({ writeScopes: ["memory:delete"], requireApprovalFor: ["delete_fact"] }),
      req({ scope: "memory:delete", action: "write", trigger: "delete_fact" }),
    );
    expect(r.decision).toBe("approval_required");
    expect(r.decision === "approval_required" && r.trigger).toBe("delete_fact");
  });

  it("denies a write outside the namespace allow-list", () => {
    const r = evaluateAccess(
      { ...policy({ writeScopes: ["memory:write"] }), namespaces: ["proj:*"] } as any,
      req({ scope: "memory:write", action: "write", namespace: "secret:x" }),
    );
    expect(r.decision).toBe("deny");
  });

  it("allows a write inside the namespace allow-list", () => {
    const r = evaluateAccess(
      { ...policy({ writeScopes: ["memory:write"] }), namespaces: ["proj:*"] } as any,
      req({ scope: "memory:write", action: "write", namespace: "proj:alpha" }),
    );
    expect(r.decision).toBe("allow");
  });

  it("enforces federationAccess for federation ops", () => {
    expect(
      evaluateAccess(policy({ federationAccess: "none", readScopes: ["memory:federation"] }),
        req({ scope: "memory:federation", action: "read", federation: true })).decision,
    ).toBe("deny");
    expect(
      evaluateAccess(policy({ federationAccess: "read", readScopes: ["memory:federation"] }),
        req({ scope: "memory:federation", action: "read", federation: true })).decision,
    ).toBe("allow");
  });
});
