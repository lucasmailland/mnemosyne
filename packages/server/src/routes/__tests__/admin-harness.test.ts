import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountAdminHarness } from "../admin-harness.js";
import { scopeFor } from "../../middleware/rbac-policy.js";
import { toErrorBody } from "../../errors.js";

function fixture(scopes = ["admin:workspace"], liveLeaseCount = 0) {
  const storage = {
    disableHarnessIngestion: vi.fn(async () => ({ ingestionEnabled: false, fenceEpoch: 1 })),
    quiesceManagedLifecycle: vi.fn(async () => ({
      pendingCount: liveLeaseCount,
      liveLeaseCount,
      reactivatedCount: 2,
    })),
  };
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.onError((error, c) => {
    const { status, body } = toErrorBody(error);
    return c.json(body, status as 403 | 500 | 503);
  });
  app.use("*", async (c, next) => {
    c.set("workspaceId", "workspace-a");
    c.set("scopes", scopes);
    await next();
  });
  mountAdminHarness(app, { storage } as unknown as ServerDeps);
  return { app, storage };
}
afterEach(() => vi.unstubAllEnvs());
describe("admin harness quiesce", () => {
  it("requires administrative scope before changing the workspace fence", async () => {
    const { app, storage } = fixture(["memory:session"]);
    expect((await app.request("/admin/harness/quiesce", { method: "POST" })).status).toBe(403);
    expect(storage.disableHarnessIngestion).not.toHaveBeenCalled();
    expect(scopeFor("POST", "/v1/admin/harness/quiesce")).toBe("memory:admin");
  });
  it("commits disable before quiescing and reports a drained workspace", async () => {
    const { app, storage } = fixture();
    storage.quiesceManagedLifecycle.mockImplementation(async () => {
      expect(storage.disableHarnessIngestion).toHaveBeenCalledWith({ workspaceId: "workspace-a" });
      return { pendingCount: 0, liveLeaseCount: 0, reactivatedCount: 2 };
    });
    const response = await app.request("/admin/harness/quiesce", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      quiesced: true,
      ingestionEnabled: false,
      liveLeaseCount: 0,
      inFlightCount: 0,
    });
  });
  it("reports live leases without claiming rollback is safe and permits idempotent retries", async () => {
    const { app, storage } = fixture(["admin:workspace"], 1);
    const pending = await app.request("/admin/harness/quiesce", { method: "POST" });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ quiesced: false, inFlightCount: 1 });
    storage.quiesceManagedLifecycle.mockResolvedValue({
      pendingCount: 0,
      liveLeaseCount: 0,
      reactivatedCount: 0,
    });
    expect((await app.request("/admin/harness/quiesce", { method: "POST" })).status).toBe(200);
  });
});
