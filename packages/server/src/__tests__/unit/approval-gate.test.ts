import { describe, it, expect, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { InMemoryAccessPolicyStore } from "@mnemo-ai/types/testing";
import { InMemoryApprovalStore } from "@mnemo-ai/types/testing";
import { createRbacMiddleware } from "../../middleware/rbac-policy.js";
import { mountApprovals } from "../../routes/approvals.js";
import type { AuthVariables } from "../../auth.js";
import { toErrorBody } from "../../errors.js";

const WS = "11111111-1111-1111-1111-111111111111";

function buildApp(
  policies: InMemoryAccessPolicyStore,
  approvals: InMemoryApprovalStore,
  actorId = "agent-1"
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("actorId", actorId);
    c.set("userId", actorId);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", ["memory:read", "memory:delete"]);
    await next();
  });
  app.use("*", createRbacMiddleware({ accessPolicies: policies, approvals }));
  app.delete("/facts/:id", (c) => c.json({ deleted: true }, 200));
  mountApprovals(app, { approvals } as any);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app;
}

describe("approval-gate — spec §19 (202 + resume)", () => {
  let policies: InMemoryAccessPolicyStore;
  let approvals: InMemoryApprovalStore;
  beforeEach(async () => {
    policies = new InMemoryAccessPolicyStore();
    approvals = new InMemoryApprovalStore();
    await policies.putPolicy({
      agentId: "agent-1",
      workspaceId: WS,
      readScopes: ["memory:read"],
      writeScopes: ["memory:delete"],
      selfEdit: { enabled: false },
      taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
      limits: {
        maxRecallsPerMinute: 600,
        maxWritesPerMinute: 120,
        maxSessionsConcurrent: 10,
        maxSelfEditsPerSession: 3,
      },
      requireApprovalFor: ["delete_fact"],
      federationAccess: "none",
    });
  });

  it("returns 202 with approval_request_id when the op needs approval", async () => {
    const app = buildApp(policies, approvals);
    const res = await app.request("/facts/f1", { method: "DELETE" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.approval_request_id).toBeTruthy();
    expect(body.status).toBe("pending");
  });

  it("resumes: after a DIFFERENT actor's approval, the original op succeeds (200)", async () => {
    const app = buildApp(policies, approvals);
    const resolverApp = buildApp(policies, approvals, "admin-approver");
    const gate = await (await app.request("/facts/f1", { method: "DELETE" })).json();
    const ap = await resolverApp.request(`/approvals/${gate.approval_request_id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(ap.status).toBe(200);
    const retry = await app.request("/facts/f1", {
      method: "DELETE",
      headers: { "x-mnemo-approval-id": gate.approval_request_id },
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).deleted).toBe(true);
  });

  it("a denied approval (by a different actor) blocks the retry (403)", async () => {
    const app = buildApp(policies, approvals);
    const resolverApp = buildApp(policies, approvals, "admin-approver");
    const gate = await (await app.request("/facts/f1", { method: "DELETE" })).json();
    await resolverApp.request(`/approvals/${gate.approval_request_id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "denied" }),
    });
    const retry = await app.request("/facts/f1", {
      method: "DELETE",
      headers: { "x-mnemo-approval-id": gate.approval_request_id },
    });
    expect(retry.status).toBe(403);
  });

  // ── SEC-2 (PR #166, CRITICAL): self-approval bypass ─────────────────────────
  //
  // /approvals/ is intentionally exempt from the standard RBAC scope check
  // (rbac-policy.ts: "Approval meta-requests are exempt from RBAC — they are
  // control-plane, not data-plane"), so the resolve route itself is the ONLY
  // place that can enforce who may resolve a request. It used to trust a
  // client-supplied `resolvedBy` string in the body with no identity
  // verification at all — the actual authenticated requester could resolve
  // their own gated request by simply POSTing any resolvedBy value, defeating
  // the entire human-in-the-loop control for delete_fact/bulk_export/
  // federation_share/procedural_evolution.

  it("SEC-2 FIX: the same actor who requested an approval cannot resolve it themselves (403)", async () => {
    const app = buildApp(policies, approvals); // actorId: "agent-1" for both the request and the resolve attempt
    const gate = await (await app.request("/facts/f1", { method: "DELETE" })).json();
    const selfResolve = await app.request(`/approvals/${gate.approval_request_id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(selfResolve.status).toBe(403);

    // The approval must remain pending — the retry must still be gated.
    const retry = await app.request("/facts/f1", {
      method: "DELETE",
      headers: { "x-mnemo-approval-id": gate.approval_request_id },
    });
    expect(retry.status).toBe(202);
  });

  it("SEC-2 FIX: resolvedBy is derived from the authenticated actor, never trusted from the request body", async () => {
    const app = buildApp(policies, approvals);
    const resolverApp = buildApp(policies, approvals, "admin-approver");
    const gate = await (await app.request("/facts/f1", { method: "DELETE" })).json();
    // Even if the body tries to claim a different resolvedBy identity, the
    // route must ignore it and use the authenticated actor ("admin-approver").
    await resolverApp.request(`/approvals/${gate.approval_request_id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", resolvedBy: "someone-else-entirely" }),
    });
    const check = await resolverApp.request(`/approvals/${gate.approval_request_id}`);
    expect((await check.json()).status).toBe("approved");
  });

  it("SEC-2 FIX: an already-resolved approval cannot be re-resolved (409)", async () => {
    const app = buildApp(policies, approvals);
    const resolverApp = buildApp(policies, approvals, "admin-approver");
    const gate = await (await app.request("/facts/f1", { method: "DELETE" })).json();
    const first = await resolverApp.request(`/approvals/${gate.approval_request_id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(first.status).toBe(200);

    const second = await resolverApp.request(`/approvals/${gate.approval_request_id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "denied" }),
    });
    expect(second.status).toBe(409);
  });
});

describe("namespace allow-list — spec §19 (deep re-audit RBAC)", () => {
  function buildNsApp(policies: InMemoryAccessPolicyStore) {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", WS);
      c.set("actorId", "agent-ns");
      c.set("apiKeyPrefix", "mns_live_");
      c.set("scopes", ["memory:read"]);
      await next();
    });
    app.use(
      "*",
      createRbacMiddleware({ accessPolicies: policies, approvals: new InMemoryApprovalStore() })
    );
    app.get("/facts", (c) => c.json({ ok: true }, 200));
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as Parameters<typeof c.json>[1]);
    });
    return app;
  }

  let policies: InMemoryAccessPolicyStore;
  beforeEach(async () => {
    policies = new InMemoryAccessPolicyStore();
    await policies.putPolicy({
      agentId: "agent-ns",
      workspaceId: WS,
      readScopes: ["memory:read"],
      writeScopes: [],
      selfEdit: { enabled: false },
      taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
      limits: {
        maxRecallsPerMinute: 600,
        maxWritesPerMinute: 120,
        maxSessionsConcurrent: 10,
        maxSelfEditsPerSession: 3,
      },
      requireApprovalFor: [],
      federationAccess: "none",
      namespaces: ["team-a/*"],
    });
  });

  it("denies a request whose x-mnemo-namespace is outside the allow-list (403)", async () => {
    const res = await buildNsApp(policies).request("/facts", {
      headers: { "x-mnemo-namespace": "team-b/secret" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a request whose namespace matches the allow-list (200)", async () => {
    const res = await buildNsApp(policies).request("/facts", {
      headers: { "x-mnemo-namespace": "team-a/notes" },
    });
    expect(res.status).toBe(200);
  });

  it("allows when no namespace header is sent (check is per-request opt-in)", async () => {
    const res = await buildNsApp(policies).request("/facts");
    expect(res.status).toBe(200);
  });
});

describe("per-agent rate limits — spec §19 (limits.*)", () => {
  function makeCounter() {
    const map = new Map<string, number>();
    return {
      map,
      incrWithTtl: async (key: string) => {
        const v = (map.get(key) ?? 0) + 1;
        map.set(key, v);
        return v;
      },
    };
  }

  function buildRlApp(
    policies: InMemoryAccessPolicyStore,
    counter?: { incrWithTtl: (k: string, ttl: number) => Promise<number> }
  ) {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", WS);
      c.set("actorId", "agent-rl");
      c.set("apiKeyPrefix", "mns_live_");
      c.set("scopes", ["memory:read", "memory:write"]);
      await next();
    });
    app.use(
      "*",
      createRbacMiddleware({
        accessPolicies: policies,
        approvals: new InMemoryApprovalStore(),
        // Fixed clock so all requests land in the same 60s window.
        now: () => 1_000_000,
        ...(counter ? { rateCounter: counter } : {}),
      })
    );
    app.get("/facts", (c) => c.json({ ok: true }, 200));
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as Parameters<typeof c.json>[1]);
    });
    return app;
  }

  let policies: InMemoryAccessPolicyStore;
  beforeEach(async () => {
    policies = new InMemoryAccessPolicyStore();
    await policies.putPolicy({
      agentId: "agent-rl",
      workspaceId: WS,
      readScopes: ["memory:read"],
      writeScopes: ["memory:write"],
      selfEdit: { enabled: false },
      taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
      limits: {
        maxRecallsPerMinute: 2,
        maxWritesPerMinute: 1,
        maxSessionsConcurrent: 10,
        maxSelfEditsPerSession: 3,
      },
      requireApprovalFor: [],
      federationAccess: "none",
    });
  });

  it("allows up to maxRecallsPerMinute, then returns 429 with limit headers", async () => {
    const app = buildRlApp(policies, makeCounter());
    expect((await app.request("/facts")).status).toBe(200); // 1
    expect((await app.request("/facts")).status).toBe(200); // 2
    const third = await app.request("/facts"); // 3 > 2 → over limit
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();
    expect(third.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(third.headers.get("Mnemosyne-Rate-Limited-Reason")).toBe("agent_recall_per_minute");
  });

  it("fails open when no rateCounter is wired", async () => {
    const app = buildRlApp(policies); // no counter
    for (let i = 0; i < 5; i++) {
      expect((await app.request("/facts")).status).toBe(200);
    }
  });

  it("fails open when the counter store throws", async () => {
    const throwing = {
      incrWithTtl: async () => {
        throw new Error("redis down");
      },
    };
    const app = buildRlApp(policies, throwing);
    for (let i = 0; i < 5; i++) {
      expect((await app.request("/facts")).status).toBe(200);
    }
  });
});

// APP-007 (audit 2026-11-22). An approved approval id was accepted on ANY
// request whose trigger matched, by ANY actor, forever, and before the policy's
// own deny was evaluated: one approved delete_fact let whoever knew the id
// delete every fact in the workspace.
describe("APP-007 — an approval is one approved request, not a pass", () => {
  let policies: InMemoryAccessPolicyStore;
  let approvals: InMemoryApprovalStore;
  beforeEach(async () => {
    policies = new InMemoryAccessPolicyStore();
    approvals = new InMemoryApprovalStore();
    for (const agentId of ["agent-1", "agent-2"]) {
      await policies.putPolicy({
        agentId,
        workspaceId: WS,
        readScopes: ["memory:read"],
        writeScopes: ["memory:delete"],
        selfEdit: { enabled: false },
        taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
        limits: {
          maxRecallsPerMinute: 600,
          maxWritesPerMinute: 120,
          maxSessionsConcurrent: 10,
          maxSelfEditsPerSession: 3,
        },
        requireApprovalFor: ["delete_fact"],
        federationAccess: "none",
      });
    }
  });

  async function approvedFor(
    app: ReturnType<typeof buildApp>,
    path = "/facts/f1"
  ): Promise<string> {
    const gate = await (await app.request(path, { method: "DELETE" })).json();
    const resolver = buildApp(policies, approvals, "admin-approver");
    const ok = await resolver.request(`/approvals/${gate.approval_request_id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(ok.status).toBe(200);
    return gate.approval_request_id as string;
  }
  const withApproval = (app: ReturnType<typeof buildApp>, id: string, path = "/facts/f1") =>
    app.request(path, { method: "DELETE", headers: { "x-mnemo-approval-id": id } });

  it("is spent by the first request it lets through", async () => {
    const app = buildApp(policies, approvals);
    const id = await approvedFor(app);
    expect((await withApproval(app, id)).status).toBe(200);
    expect((await withApproval(app, id)).status).toBe(403);
  });

  it("only covers the request that asked for it", async () => {
    const app = buildApp(policies, approvals);
    const id = await approvedFor(app, "/facts/f1");
    expect((await withApproval(app, id, "/facts/f2")).status).toBe(403);
  });

  it("is redeemed only by the user who requested it", async () => {
    const app = buildApp(policies, approvals, "agent-1");
    const id = await approvedFor(app);
    const other = buildApp(policies, approvals, "agent-2");
    expect((await withApproval(other, id)).status).toBe(403);
    // and the requester can still use it afterwards
    expect((await withApproval(app, id)).status).toBe(200);
  });

  it("expires", async () => {
    const app = buildApp(policies, approvals);
    const id = await approvedFor(app);
    const ar = await approvals.get(WS, id);
    ar!.expiresAt = new Date(Date.now() - 1000); // determinism-ok: expiry is judged against the real clock
    expect((await withApproval(app, id)).status).toBe(403);
  });

  it("does not override a deny in the policy", async () => {
    const app = buildApp(policies, approvals);
    const id = await approvedFor(app);
    const p = await policies.getPolicy(WS, "agent-1");
    await policies.putPolicy({ ...p!, writeScopes: [] });
    // A fresh middleware: the policy is cached per instance.
    const after = buildApp(policies, approvals);
    expect((await withApproval(after, id)).status).toBe(403);
  });

  it("cannot be resolved after it expired", async () => {
    const app = buildApp(policies, approvals);
    const gate = await (await app.request("/facts/f1", { method: "DELETE" })).json();
    const ar = await approvals.get(WS, gate.approval_request_id);
    ar!.expiresAt = new Date(Date.now() - 1000); // determinism-ok: expiry is judged against the real clock
    const resolver = buildApp(policies, approvals, "admin-approver");
    const res = await resolver.request(`/approvals/${gate.approval_request_id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(409);
  });

  // Re-audit 2026-11-22: the binding was the bare path, so a soft
  // DELETE /forget/fact/X approval also redeemed DELETE /forget/fact/X?mode=hard.
  it("does not cover the same path with a different query string", async () => {
    const app = buildApp(policies, approvals);
    const id = await approvedFor(app, "/facts/f1");
    expect((await withApproval(app, id, "/facts/f1?mode=hard")).status).toBe(403);
    // still usable for the request it was granted for
    expect((await withApproval(app, id, "/facts/f1")).status).toBe(200);
  });

  it("covers its own query string whatever the parameter order", async () => {
    const app = buildApp(policies, approvals);
    const id = await approvedFor(app, "/facts/f1?mode=hard&reason=gdpr");
    expect((await withApproval(app, id, "/facts/f1?reason=gdpr&mode=hard")).status).toBe(200);
  });
});

// APP-031 (audit 2026-11-22): the triggers matched substrings of paths the
// routes do not use. A policy that requires approval for deletes was skipped by
// DELETE /forget/:kind/:id (the SDK's and MCP's forget), including mode=hard,
// and procedural_evolution never fired because the route is /self/edit.
describe("APP-031 — approval triggers match the routes that exist", () => {
  it.each([
    ["DELETE", "/facts/f1"],
    ["DELETE", "/forget/fact/f1"],
    ["DELETE", "/forget/decision/d1"],
    ["DELETE", "/forget/fact/f1?mode=hard"],
    ["DELETE", "/facts/f1/hard"],
  ])("%s %s is delete_fact", async (method, path) => {
    const { triggerFor } = await import("../../middleware/rbac-policy.js");
    expect(triggerFor(method, path)).toBe("delete_fact");
  });

  it("POST /self/edit is procedural_evolution", async () => {
    const { triggerFor } = await import("../../middleware/rbac-policy.js");
    expect(triggerFor("POST", "/self/edit")).toBe("procedural_evolution");
  });

  it("does not fire on reads", async () => {
    const { triggerFor } = await import("../../middleware/rbac-policy.js");
    expect(triggerFor("GET", "/forget/fact/f1")).toBeUndefined();
    expect(triggerFor("GET", "/facts/f1")).toBeUndefined();
  });
});
