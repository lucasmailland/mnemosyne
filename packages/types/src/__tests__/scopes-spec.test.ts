import { describe, it, expect } from "vitest";
import {
  SPEC_SCOPES,
  type SpecScope,
  type AgentMemoryAccess,
  type ApprovalTrigger,
} from "../security.js";

describe("spec §6 — 15 memory scopes", () => {
  it("contains exactly the 15 spec scopes", () => {
    expect([...SPEC_SCOPES].sort()).toEqual(
      [
        "memory:read",
        "memory:write",
        "memory:delete",
        "memory:hard_delete",
        "memory:session",
        "memory:task",
        "memory:event",
        "memory:self_edit",
        "memory:procedural",
        "memory:reasoning",
        "memory:export",
        "memory:admin",
        "memory:federation",
        "memory:governance",
        "memory:subscribe",
      ].sort()
    );
  });

  // P55: federation:admin (peer trust administration) is instance-operator
  // provisioned only — same precedent as admin:workspace, which is also
  // absent from SPEC_SCOPES. It MUST stay out of the set a workspace-scoped
  // dashboard/MCP flow can mint, or any tenant admin could self-mint
  // peer-approval power (the exact escalation P55 closes).
  it("does NOT expose federation:admin as tenant-mintable", () => {
    expect([...SPEC_SCOPES]).not.toContain("federation:admin");
  });

  it("AgentMemoryAccess carries the spec fields", () => {
    const a: AgentMemoryAccess = {
      agentId: "agent-1",
      workspaceId: "ws-1",
      readScopes: ["memory:read"],
      writeScopes: ["memory:write"],
      selfEdit: { enabled: false },
      taskScopes: { canCreate: true, canDelegate: false, canDelegateTo: [] },
      limits: {
        maxRecallsPerMinute: 600,
        maxWritesPerMinute: 120,
        maxSessionsConcurrent: 10,
        maxSelfEditsPerSession: 3,
      },
      requireApprovalFor: ["delete_fact"],
      federationAccess: "none",
    };
    expect(a.limits.maxSessionsConcurrent).toBe(10);
    expect(a.federationAccess).toBe("none");
  });

  it("ApprovalTrigger union covers the 8 spec triggers", () => {
    const all: ApprovalTrigger[] = [
      "delete_fact",
      "overwrite_decision",
      "write_entity",
      "cross_agent_read",
      "bulk_export",
      "federation_share",
      "procedural_evolution",
      "task_delegation",
    ];
    expect(all).toHaveLength(8);
  });
});
