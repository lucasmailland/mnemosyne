/**
 * p45 Slice C — POST /procedural/optimize emits an admin_access audit entry
 * carrying resolveProvenance()'s actor triple (§C.4 of the p45 design).
 *
 * Mirrors the fake-auth + fake-deps pattern used across the other route unit
 * tests (governance-route.test.ts, composition-route.test.ts). `@mnemo-ai/core`
 * is mocked so no real LLM call or DB tx is attempted.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import { mountProcedural } from "../../routes/procedural.js";
import { toErrorBody } from "../../errors.js";

vi.mock("@mnemo-ai/core", () => ({
  runProceduralOptimization: vi.fn().mockResolvedValue({ outcome: "skipped", reason: "no budget" }),
  decideProceduralTransition: vi.fn(),
}));

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function makeApp(storageOverrides: Partial<StorageAdapter> = {}) {
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
      ...storageOverrides,
    } as unknown as StorageAdapter,
    llm: { embed: vi.fn() },
  } as unknown as ServerDeps;

  mountProcedural(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return { app, fakeDeps };
}

describe("POST /procedural/optimize — p45 Slice C audit", () => {
  it("emits an admin_access audit entry carrying resolveProvenance()'s actor", async () => {
    const { app, fakeDeps } = makeApp();

    const res = await app.request("/procedural/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });

    expect(res.status).toBe(200);
    const storage = fakeDeps.storage as unknown as { appendAuditEntry: ReturnType<typeof vi.fn> };
    expect(storage.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorId: "key:tester",
        actorType: "user",
        action: "admin_access",
        resourceKind: "procedural",
        resourceId: "agent-1",
      })
    );
  });
});
