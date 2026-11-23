/**
 * Unit tests for §19 per-agent limits enforcement in rbac-policy.ts:
 *   - maxSelfEditsPerSession (per-session 24 h counter via rateCounter)
 *   - maxSessionsConcurrent (concurrent probe via activeSessions)
 */
import { describe, it, expect, vi } from "vitest";
import { createRbacMiddleware } from "../../middleware/rbac-policy.js";
import type { RbacDeps } from "../../middleware/rbac-policy.js";
import type { AccessPolicyRecord } from "@mnemo-ai/types";

const WS = "ws-limits-test";
const ACTOR = "agent-limits";

function makePolicy(overrides: Partial<AccessPolicyRecord["limits"]> = {}): AccessPolicyRecord {
  return {
    workspaceId: WS,
    agentId: ACTOR,
    readScopes: ["memory:read", "memory:session"],
    writeScopes: ["memory:write", "memory:self_edit", "memory:session"],
    selfEdit: { enabled: true, allowedActions: ["update_belief"] },
    taskScopes: { canCreate: true, canDelegate: true, canDelegateTo: [] },
    namespaces: [],
    limits: { maxRecallsPerMinute: 0, maxWritesPerMinute: 0, maxSessionsConcurrent: 0, maxSelfEditsPerSession: 0, ...overrides },
    requireApprovalFor: [],
    federationAccess: "none",
  };
}

function makeCtx(method: string, path: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  return {
    req: {
      method,
      path,
      header: (name: string) => headers[name.toLowerCase()] ?? undefined,
      query: (name: string) => query[name] ?? undefined,
    },
    get: (key: string) => {
      if (key === "workspaceId") return WS;
      if (key === "actorId") return ACTOR;
      return undefined;
    },
    set: vi.fn(),
    header: vi.fn(),
    json: vi.fn().mockReturnValue(new Response("{}", { status: 202 })),
  };
}

function makeDeps(partial: Partial<RbacDeps>): RbacDeps {
  return {
    accessPolicies: {
      getPolicy: vi.fn().mockResolvedValue(makePolicy()),
    } as RbacDeps["accessPolicies"],
    approvals: {
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "approval-1" }),
    } as RbacDeps["approvals"],
    ...partial,
  };
}

describe("rbac-limits — maxSelfEditsPerSession", () => {
  it("allows self-edit when count is at or below the limit", async () => {
    let counter = 0;
    const deps = makeDeps({
      rateCounter: { incrWithTtl: vi.fn().mockImplementation(async () => ++counter) },
      accessPolicies: {
        getPolicy: vi.fn().mockResolvedValue(makePolicy({ maxSelfEditsPerSession: 2 })),
      } as RbacDeps["accessPolicies"],
    });
    const mw = createRbacMiddleware(deps);
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx("POST", "/memory/self/edit", { "x-mnemo-session-id": "sess-1" }) as never;
    await mw(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("throws 429 when self-edit count exceeds maxSelfEditsPerSession", async () => {
    const deps = makeDeps({
      rateCounter: { incrWithTtl: vi.fn().mockResolvedValue(2) }, // count=2 > limit=1
      accessPolicies: {
        getPolicy: vi.fn().mockResolvedValue(makePolicy({ maxSelfEditsPerSession: 1 })),
      } as RbacDeps["accessPolicies"],
    });
    const mw = createRbacMiddleware(deps);
    const next = vi.fn();
    const ctx = makeCtx("POST", "/memory/self/edit", { "x-mnemo-session-id": "sess-1" }) as never;
    await expect(mw(ctx, next)).rejects.toMatchObject({ status: 429 });
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT gate self-edits when no session id header/query is present", async () => {
    const deps = makeDeps({
      rateCounter: { incrWithTtl: vi.fn().mockResolvedValue(999) },
      accessPolicies: {
        getPolicy: vi.fn().mockResolvedValue(makePolicy({ maxSelfEditsPerSession: 1 })),
      } as RbacDeps["accessPolicies"],
    });
    const mw = createRbacMiddleware(deps);
    const next = vi.fn().mockResolvedValue(undefined);
    // No x-mnemo-session-id header, no sessionId query
    const ctx = makeCtx("POST", "/memory/self/edit") as never;
    await mw(ctx, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("rbac-limits — maxSessionsConcurrent", () => {
  it("allows session creation when active count is below the limit", async () => {
    const deps = makeDeps({
      activeSessions: { countActive: vi.fn().mockResolvedValue(1) },
      accessPolicies: {
        getPolicy: vi.fn().mockResolvedValue(makePolicy({ maxSessionsConcurrent: 2 })),
      } as RbacDeps["accessPolicies"],
    });
    const mw = createRbacMiddleware(deps);
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx("POST", "/sessions") as never;
    await mw(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("throws 429 when active sessions reach maxSessionsConcurrent", async () => {
    const deps = makeDeps({
      activeSessions: { countActive: vi.fn().mockResolvedValue(3) }, // 3 >= limit 3
      accessPolicies: {
        getPolicy: vi.fn().mockResolvedValue(makePolicy({ maxSessionsConcurrent: 3 })),
      } as RbacDeps["accessPolicies"],
    });
    const mw = createRbacMiddleware(deps);
    const next = vi.fn();
    const ctx = makeCtx("POST", "/sessions") as never;
    await expect(mw(ctx, next)).rejects.toMatchObject({ status: 429 });
    expect(next).not.toHaveBeenCalled();
  });

  // Re-audit 2026-11-22: sessions are created by POST /session/start (POST
  // /sessions is an alias that re-dispatches there), which the gate never matched.
  it("gates POST /session/start, the route that actually creates a session", async () => {
    const deps = makeDeps({
      activeSessions: { countActive: vi.fn().mockResolvedValue(3) },
      accessPolicies: {
        getPolicy: vi.fn().mockResolvedValue(makePolicy({ maxSessionsConcurrent: 3 })),
      } as RbacDeps["accessPolicies"],
    });
    const mw = createRbacMiddleware(deps);
    const next = vi.fn();
    await expect(mw(makeCtx("POST", "/session/start") as never, next)).rejects.toMatchObject({
      status: 429,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT gate GET /sessions (only POST)", async () => {
    const deps = makeDeps({
      activeSessions: { countActive: vi.fn().mockResolvedValue(99) },
      accessPolicies: {
        getPolicy: vi.fn().mockResolvedValue(makePolicy({ maxSessionsConcurrent: 1 })),
      } as RbacDeps["accessPolicies"],
    });
    const mw = createRbacMiddleware(deps);
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx("GET", "/sessions") as never;
    await mw(ctx, next);
    expect(next).toHaveBeenCalled();
  });
});
