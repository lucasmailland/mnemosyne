import { describe, it, expect } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { InMemoryBreakGlassStore } from "@mnemo-ai/types/testing";
import { mountBreakGlass } from "../../routes/break-glass.js";
import { toErrorBody } from "../../errors.js";
import type { AuthVariables } from "../../auth.js";

const WS = "33333333-3333-3333-3333-333333333333";

function appWith(store: InMemoryBreakGlassStore, actorId: string, prefix: string) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("actorId", actorId);
    c.set("userId", actorId);
    c.set("apiKeyPrefix", prefix as never);
    await next();
  });
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status);
  });
  mountBreakGlass(app, { breakGlass: store });
  return app;
}

describe("/break-glass routes", () => {
  it("admin A files a request, admin B approves it", async () => {
    const store = new InMemoryBreakGlassStore();
    const aApp = appWith(store, "admin-A", "mk_admin_");
    const reqRes = await aApp.request("/break-glass", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "incident-42", requestedScopes: ["memory:export"] }),
    });
    expect(reqRes.status).toBe(201);
    const { id } = (await reqRes.json()) as { id: string };

    const bApp = appWith(store, "admin-B", "mk_admin_");
    const apRes = await bApp.request(`/break-glass/${id}/approve`, { method: "POST" });
    expect(apRes.status).toBe(200);
    const grant = await store.getActiveApproved(WS, "admin-A");
    expect(grant?.id).toBe(id);
    expect(grant?.approvedBy).toBe("admin-B");
  });

  it("admin A cannot self-approve (403)", async () => {
    const store = new InMemoryBreakGlassStore();
    const aApp = appWith(store, "admin-A", "mk_admin_");
    const reqRes = await aApp.request("/break-glass", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "x", requestedScopes: ["memory:export"] }),
    });
    const { id } = (await reqRes.json()) as { id: string };
    const selfRes = await aApp.request(`/break-glass/${id}/approve`, { method: "POST" });
    expect(selfRes.status).toBe(403);
    expect(await store.getActiveApproved(WS, "admin-A")).toBeNull();
  });

  it("a non-admin key cannot file a request (403)", async () => {
    const store = new InMemoryBreakGlassStore();
    const app = appWith(store, "agent-1", "mk_live_");
    const res = await app.request("/break-glass", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "x", requestedScopes: ["memory:export"] }),
    });
    expect(res.status).toBe(403);
  });
});
