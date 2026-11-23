import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { scopeFor, rpcScopeFor, policyScopesFor, createRbacMiddleware } from "../../middleware/rbac-policy.js";
import type { RbacDeps } from "../../middleware/rbac-policy.js";
import { getScopeForRequest } from "../../app-scope.js";

describe("scopeFor — granular route-family scopes", () => {
  it("recall stays memory:read", () => {
    expect(scopeFor("POST", "/recall")).toBe("memory:read");
  });
  it("GET stays memory:read", () => {
    expect(scopeFor("GET", "/facts")).toBe("memory:read");
  });
  it("webhook endpoints are registered, changed, tested and removed by admins only (APP-005)", () => {
    // An endpoint receives every event of the workspace and makes the server
    // call a URL of the caller's choosing: not something a write key decides.
    expect(scopeFor("POST", "/webhooks")).toBe("memory:admin");
    expect(scopeFor("PATCH", "/webhooks/w-1")).toBe("memory:admin");
    expect(scopeFor("DELETE", "/webhooks/w-1")).toBe("memory:admin");
    expect(scopeFor("POST", "/webhooks/w-1/test")).toBe("memory:admin");
    expect(scopeFor("GET", "/webhooks")).toBe("memory:read");
    // The API-key scope guard reads its own map: both must agree.
    expect(getScopeForRequest("POST", "/webhooks")).toBe("memory:admin");
    expect(getScopeForRequest("PATCH", "/webhooks/w-1")).toBe("memory:admin");
    expect(getScopeForRequest("DELETE", "/webhooks/w-1")).toBe("memory:admin");
    expect(getScopeForRequest("POST", "/webhooks/w-1/test")).toBe("memory:admin");
    expect(getScopeForRequest("GET", "/webhooks/w-1/deliveries")).toBe("memory:read");
  });
  it("task writes → memory:task", () => {
    expect(scopeFor("POST", "/tasks")).toBe("memory:task");
    expect(scopeFor("POST", "/tasks/t-1/delegate")).toBe("memory:task");
    expect(scopeFor("PATCH", "/tasks/t-1")).toBe("memory:task");
  });
  it("event writes → memory:event", () => {
    expect(scopeFor("POST", "/events")).toBe("memory:event");
  });
  it("harness probe and events explicitly require memory:session", () => {
    expect(scopeFor("POST", "/harness/v1/probe")).toBe("memory:session");
    expect(scopeFor("POST", "/harness/v1/events")).toBe("memory:session");
  });
  it("self-edit writes → memory:self_edit", () => {
    expect(scopeFor("POST", "/self/edit")).toBe("memory:self_edit");
  });
  it("procedural writes → memory:procedural", () => {
    expect(scopeFor("POST", "/procedural")).toBe("memory:procedural");
    expect(scopeFor("POST", "/workflows")).toBe("memory:procedural");
    expect(scopeFor("POST", "/skills")).toBe("memory:procedural");
    expect(scopeFor("POST", "/strategies")).toBe("memory:procedural");
  });
  it("reasoning writes → memory:reasoning", () => {
    expect(scopeFor("POST", "/reasoning")).toBe("memory:reasoning");
  });
  it("export → memory:export", () => {
    expect(scopeFor("GET", "/export")).toBe("memory:export");
    expect(scopeFor("POST", "/export")).toBe("memory:export");
  });
  it("session writes → memory:session", () => {
    expect(scopeFor("POST", "/sessions")).toBe("memory:session");
    // APP-076 (audit 2026-11-22): the real routes are /session/* (singular),
    // which matched neither map, so memory:session never decided them.
    // The session scope opens them; memory:write still does (any-of), so
    // existing read+write keys keep their sessions.
    expect(getScopeForRequest("POST", "/session/start")).toEqual(["memory:session", "memory:write"]);
    expect(getScopeForRequest("POST", "/session/s-1/turn")).toEqual(["memory:session", "memory:write"]);
    // Reads stay reads.
    expect(getScopeForRequest("GET", "/session/s-1")).toBe("memory:read");
  });
  it("governance writes → memory:governance", () => {
    expect(scopeFor("POST", "/governance")).toBe("memory:governance");
  });
  it("federation writes → memory:federation", () => {
    expect(scopeFor("POST", "/federation/sync")).toBe("memory:federation");
  });
  // P55: this resolver is a SEPARATE map from app-scope.ts's getScopeForRequest()
  // — it feeds the §19 per-agent policy plane (rbac-policy.ts) and returns
  // SpecScope only, which does not (and per design D1 must not) include
  // federation:admin. Pin the pre-existing behaviour so a future editor does
  // not "fix" the apparent inconsistency between the two scope planes: the
  // key-scope gate (app-scope.ts) treats /federation/peers* as admin-tier,
  // this resolver does not distinguish peer sub-paths at all.
  it("does not distinguish peer sub-paths — stays memory:federation (separate plane from app-scope.ts)", () => {
    expect(scopeFor("GET", "/memory/federation/peers")).toBe("memory:federation");
  });
  it("deletes unchanged", () => {
    expect(scopeFor("DELETE", "/facts/f-1")).toBe("memory:delete");
    expect(scopeFor("DELETE", "/facts/f-1/hard")).toBe("memory:hard_delete");
  });
  it("generic write fallback stays memory:write", () => {
    expect(scopeFor("POST", "/facts")).toBe("memory:write");
  });
});

describe("rpcScopeFor — granular RPC scopes", () => {
  it("CreateTask/UpdateTask → memory:task", () => {
    expect(rpcScopeFor("CreateTask")).toBe("memory:task");
    expect(rpcScopeFor("UpdateTask")).toBe("memory:task");
  });
  it("RecordEvent → memory:event", () => {
    expect(rpcScopeFor("RecordEvent")).toBe("memory:event");
  });
  it("SelfEdit → memory:self_edit", () => {
    expect(rpcScopeFor("SelfEdit")).toBe("memory:self_edit");
  });
  it("RecordReasoning → memory:reasoning", () => {
    expect(rpcScopeFor("RecordReasoning")).toBe("memory:reasoning");
  });
  it("Session → memory:session", () => {
    expect(rpcScopeFor("Session")).toBe("memory:session");
  });
  it("ImportMemory/IngestBatch → memory:export", () => {
    expect(rpcScopeFor("ImportMemory")).toBe("memory:export");
  });
  it("FederationSync → memory:federation", () => {
    expect(rpcScopeFor("FederationSync")).toBe("memory:federation");
  });
  it("Remember stays memory:write; Recall stays memory:read; Forget stays memory:delete", () => {
    expect(rpcScopeFor("Remember")).toBe("memory:write");
    expect(rpcScopeFor("Recall")).toBe("memory:read");
    expect(rpcScopeFor("Forget")).toBe("memory:delete");
  });
});

// Re-audit 2026-11-22 (APP-076 follow-up): app-scope.ts lets memory:session
// decide the /session/* writes (memory:write still accepted); the per-agent
// policy plane mapped only /sessions, so there memory:session decided nothing.
describe("the two scope maps agree on the session routes", () => {
  const SESSION_ROUTES: Array<[string, string]> = [
    ["GET", "/session/list"],
    ["GET", "/session/s-1"],
    ["GET", "/session/stats"],
    ["POST", "/session/start"],
    ["POST", "/session/s-1/turn"],
    ["POST", "/session/s-1/collapse"],
    ["POST", "/session/s-1/feedback"],
    ["POST", "/session/s-1/pin"],
    ["POST", "/session/s-1/scratch"],
    ["POST", "/session/s-1/discard"],
  ];
  it.each(SESSION_ROUTES)("%s %s accepts the same scopes in both maps", (method, path) => {
    const key = getScopeForRequest(method, path);
    expect(policyScopesFor(method, path)).toEqual(Array.isArray(key) ? key : [key]);
  });

  function policyMiddleware(writeScopes: string[]) {
    const policy = {
      workspaceId: "ws-1",
      agentId: "agent-1",
      readScopes: ["memory:read"],
      writeScopes,
      selfEdit: { enabled: false },
      taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
      limits: { maxRecallsPerMinute: 0, maxWritesPerMinute: 0, maxSessionsConcurrent: 0, maxSelfEditsPerSession: 0 },
      requireApprovalFor: [],
      federationAccess: "none",
    };
    return createRbacMiddleware({
      accessPolicies: { getPolicy: vi.fn().mockResolvedValue(policy) },
      approvals: { get: vi.fn(), create: vi.fn() },
    } as unknown as RbacDeps);
  }
  const ctx = (method: string, path: string) =>
    ({
      req: { method, path, header: () => undefined, query: () => undefined },
      get: (k: string) => (k === "workspaceId" ? "ws-1" : k === "actorId" ? "agent-1" : undefined),
      header: vi.fn(),
    }) as never;

  it.each([
    [["memory:session"], true],
    [["memory:write"], true],
    [["memory:task"], false],
  ])("a policy with write scopes %j may start a session: %s", async (writeScopes, allowed) => {
    const next = vi.fn().mockResolvedValue(undefined);
    const run = policyMiddleware(writeScopes)(ctx("POST", "/session/start"), next);
    if (allowed) {
      await run;
      expect(next).toHaveBeenCalled();
    } else {
      await expect(run).rejects.toMatchObject({ status: 403 });
    }
  });
});
