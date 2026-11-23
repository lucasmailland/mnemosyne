/**
 * p45 Slice C — POST /admin/graph/semantic-backfill emits an admin_access
 * audit entry carrying resolveProvenance()'s actor triple (§C.4 of the p45
 * design). Mirrors the fake-auth + fake-deps pattern used across the other
 * route unit tests.
 *
 * flatten-legacy-dual-core PR9g fixture update (design.md D6.5): the route's
 * `backfillSemanticNeighbors` call moved from the legacy `CoreLike` client
 * to `deps.storage` (v3 StorageAdapter) — `fakeDeps` updated to match, no
 * assertion changed.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import { mountGraph } from "../../routes/graph.js";
import { toErrorBody } from "../../errors.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function makeApp() {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "tester");
    c.set("actorType", "user");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage: {
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
      backfillSemanticNeighbors: vi.fn().mockResolvedValue(7),
    } as unknown as StorageAdapter,
  } as unknown as ServerDeps;

  mountGraph(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return { app, fakeDeps };
}

describe("POST /admin/graph/semantic-backfill — p45 Slice C audit", () => {
  it("emits an admin_access audit entry carrying resolveProvenance()'s actor", async () => {
    const { app, fakeDeps } = makeApp();

    const res = await app.request("/admin/graph/semantic-backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { edgesWritten: number };
    expect(body.edgesWritten).toBe(7);

    const storage = fakeDeps.storage as unknown as { appendAuditEntry: ReturnType<typeof vi.fn> };
    expect(storage.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorId: "key:tester",
        actorType: "user",
        action: "admin_access",
        resourceKind: "graph_backfill",
        resourceId: WORKSPACE_ID,
      })
    );
  });
});
