import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountSelf } from "../../routes/self.js";

const WS = "11111111-1111-1111-1111-111111111111";

function makeApp(
  storage: InMemoryStorageAdapter,
  auth: Partial<AuthVariables> = {},
  cache?: ServerDeps["cache"]
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", auth.apiKeyPrefix ?? "mk_live_prefix");
    c.set("actorId", auth.actorId ?? "key-record-actor");
    c.set("userId", auth.userId ?? "user-1");
    c.set("scopes", auth.scopes ?? []);
    if (auth.maxSensitivity) c.set("maxSensitivity", auth.maxSensitivity);
    await next();
  });
  mountSelf(app, { storage, cache } as unknown as ServerDeps);
  app.onError((error, c) => {
    const { status, body } = toErrorBody(error);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app.request.bind(app);
}

async function replace(
  request: ReturnType<typeof makeApp>,
  factId: string,
  agentId = "spoofed-body-agent"
) {
  return request("/self/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "replace",
      target: factId,
      content: "replacement statement",
      reason: "correction",
      agentId,
      sessionId: crypto.randomUUID(),
    }),
  });
}

describe("HTTP fact replacement authorization", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  it("applies without edit_entity approval and uses authenticated identities (userId match)", async () => {
    const fact = await storage.createFact({
      workspaceId: WS,
      userId: "user-1",
      scope: "global",
      statement: "original",
      subject: "test",
      kind: "other",
      sensitivity: "internal",
    });
    const replaceSpy = vi.spyOn(storage, "replaceFact");

    const response = await replace(makeApp(storage), fact.id);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      applied: true,
      action: "replace",
      targetKind: "fact",
    });
    expect(body.replacementId).toBeTruthy();
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: "user-1",
        agentId: "key:key-record-actor",
      })
    );
    // A userId-only match now forwards userIsolationId, activating the
    // user-isolation RLS backstop (mnemo_fact_user_isolation_select) —
    // it must NOT set actorIsolationId, since that GUC compares against
    // the actor_id column specifically.
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userIsolationId: fact.userId })
    );
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ actorIsolationId: expect.anything() })
    );
  });

  it("applies via actorId match and forwards it as actorIsolationId", async () => {
    const fact = await storage.createFact({
      workspaceId: WS,
      actorId: "key:key-record-actor",
      scope: "global",
      statement: "original",
      subject: "test",
      kind: "other",
      sensitivity: "internal",
    });
    const replaceSpy = vi.spyOn(storage, "replaceFact");

    const response = await replace(makeApp(storage), fact.id);

    expect(response.status).toBe(200);
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        // requestedBy prefers userId when the key has one bound, even though
        // the ownership match itself happened via actorId here — the key is
        // both user-bound AND its actorId happens to own this particular fact.
        requestedBy: "user-1",
        actorIsolationId: "key:key-record-actor",
        agentId: "key:key-record-actor",
      })
    );
  });

  it("returns the same 404 for foreign ownership and a sensitivity ceiling violation", async () => {
    const foreign = await storage.createFact({
      workspaceId: WS,
      actorId: "other-user",
      scope: "global",
      statement: "foreign",
      subject: "test",
      kind: "other",
      sensitivity: "internal",
    });
    const sensitive = await storage.createFact({
      workspaceId: WS,
      actorId: "user-1",
      scope: "global",
      statement: "sensitive",
      subject: "test",
      kind: "other",
      sensitivity: "confidential",
    });
    const request = makeApp(storage, { maxSensitivity: "internal" });

    const foreignResponse = await replace(request, foreign.id);
    const sensitiveResponse = await replace(request, sensitive.id);

    expect(foreignResponse.status).toBe(404);
    expect(sensitiveResponse.status).toBe(404);
    expect(await foreignResponse.json()).toEqual(await sensitiveResponse.json());
  });

  it("allows memory:admin to replace a foreign-owned fact without actor isolation", async () => {
    const fact = await storage.createFact({
      workspaceId: WS,
      actorId: "other-user",
      scope: "global",
      statement: "foreign",
      subject: "test",
      kind: "other",
      sensitivity: "internal",
    });
    const replaceSpy = vi.spyOn(storage, "replaceFact");

    const response = await replace(makeApp(storage, { scopes: ["memory:admin"] }), fact.id);

    expect(response.status).toBe(200);
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ actorIsolationId: expect.anything() })
    );
  });

  it("returns 404 for a closed fact", async () => {
    const fact = await storage.createFact({
      workspaceId: WS,
      actorId: "user-1",
      scope: "global",
      statement: "closed",
      subject: "test",
      kind: "other",
    });
    await storage.updateFact(fact.id, WS, { status: "forgotten", validTo: new Date() }); // determinism-ok: test date

    expect((await replace(makeApp(storage), fact.id)).status).toBe(404);
  });

  it("returns the committed replacement when Redis counter writes fail", async () => {
    const fact = await storage.createFact({
      workspaceId: WS,
      userId: "user-1",
      scope: "global",
      statement: "original",
      subject: "test",
      kind: "other",
    });
    const cache = {
      get: vi.fn().mockResolvedValue(null),
      incrWithTtl: vi.fn().mockRejectedValue(new Error("redis down")),
      set: vi.fn().mockRejectedValue(new Error("redis down")),
    } as unknown as ServerDeps["cache"];

    const response = await replace(makeApp(storage, {}, cache), fact.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      applied: true,
      targetKind: "fact",
      replacementId: expect.any(String),
    });
  });

  it("p50 PR7: emits action:self_edit with the resolved HTTP-transport provenance", async () => {
    const fact = await storage.createFact({
      workspaceId: WS,
      userId: "user-1",
      scope: "global",
      statement: "original",
      subject: "test",
      kind: "other",
      sensitivity: "internal",
    });
    const appendAuditEntrySpy = vi.spyOn(storage, "appendAuditEntry");

    const response = await replace(makeApp(storage), fact.id);

    expect(response.status).toBe(200);
    expect(appendAuditEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        actorType: "user",
        actorId: "key:key-record-actor",
        action: "self_edit",
        resourceKind: "self_edit",
        resourceId: fact.id,
        isTerminal: false,
        detail: expect.objectContaining({
          userId: "user-1",
          action: "replace",
          targetKind: "fact",
        }),
      })
    );
  });
});
