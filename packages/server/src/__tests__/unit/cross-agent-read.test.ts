import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AccessPolicyRecord } from "@mnemo-ai/types";
import { createRbacMiddleware, triggerFor } from "../../middleware/rbac-policy.js";

function policy(): AccessPolicyRecord {
  return {
    agentId: "agent-a",
    workspaceId: "ws-1",
    readScopes: ["memory:read"],
    writeScopes: ["memory:write"],
    selfEdit: { enabled: false },
    taskScopes: { canCreate: true, canDelegate: true, canDelegateTo: ["*"] },
    limits: {
      maxRecallsPerMinute: 0,
      maxWritesPerMinute: 0,
      maxSessionsConcurrent: 0,
      maxSelfEditsPerSession: 0,
    },
    requireApprovalFor: ["cross_agent_read"],
    federationAccess: "none",
  };
}

describe("triggerFor — cross_agent_read", () => {
  it("does NOT produce cross_agent_read from path alone (it is request-state-derived)", () => {
    expect(triggerFor("GET", "/recall")).toBeUndefined();
  });
});

describe("createRbacMiddleware — cross_agent_read enforcement", () => {
  function mk() {
    const create = vi.fn(async () => ({ id: "appr-1" }));
    const deps = {
      accessPolicies: { getPolicy: vi.fn(async () => policy()) },
      approvals: { get: vi.fn(), create },
    } as never;
    const app = new Hono<{ Variables: Record<string, unknown> }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", "ws-1");
      c.set("actorId", "agent-a");
      c.set("userId", "agent-a");
      await next();
    });
    app.use("*", createRbacMiddleware(deps));
    app.post("/recall", (c) => c.json({ hits: [] }));
    return { app, create };
  }

  it("202s when reading another agent's memory and policy requires approval", async () => {
    const { app, create } = mk();
    const res = await app.request("/recall", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mnemo-target-agent": "agent-b" },
      body: "{}",
    });
    expect(res.status).toBe(202);
    expect(create).toHaveBeenCalledOnce();
  });

  it("passes through when the target agent is the caller itself", async () => {
    const { app, create } = mk();
    const res = await app.request("/recall", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mnemo-target-agent": "agent-a" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });
});
