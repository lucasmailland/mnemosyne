import { OpenAPIHono } from "@hono/zod-openapi";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import bcrypt from "bcrypt";
import { describe, expect, it, vi } from "vitest";
import { MnemosyneService } from "../gen/mnemosyne_pb.js";
import { createAuthInterceptor, createMnemosyneRoutes } from "../grpc.js";
import { mountRecallTiering } from "../routes/recallTiering.js";
import { makeMockCognitive } from "./helpers/mockCognitive.js";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountSession } from "../routes/session.js";
import { InMemoryStorageAdapter } from "../../../types/src/testing/InMemoryStorageAdapter.js";
import { parseTrafficOriginBindings, resolveTrafficOrigin } from "../provenance.js";
it("binds evaluation to the actual authenticated principal and preserves actor provenance", async () => {
  const storage = new InMemoryStorageAdapter();
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", "ws");
    c.set("actorId", "evaluation-key");
    c.set("actorType", "agent");
    await next();
  });
  const trafficOrigins = parseTrafficOriginBindings('{"key:evaluation-key":"evaluation"}');
  app.get("/effects", (c) => {
    const trafficOrigin = resolveTrafficOrigin(c, trafficOrigins);
    return c.json({ trafficOrigin, applyOrganicEffects: trafficOrigin === "organic" });
  });
  mountSession(app, { storage, trafficOrigins } as unknown as ServerDeps);
  const response = await app.request("/session/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"trafficOrigin":"evaluation"}',
  });
  expect(response.status).toBe(201);
  const session = await response.json();
  const row = await storage.getSession(session.id, "ws");
  expect(row).toMatchObject({
    trafficOrigin: "evaluation",
    metadata: { actorId: "key:evaluation-key", actorType: "agent" },
  });
  expect(await (await app.request("/effects")).json()).toEqual({
    trafficOrigin: "evaluation",
    applyOrganicEffects: false,
  });
});
it("rejects malformed operator bindings at startup", () => {
  for (const value of ["[]", '{"bare-id":"evaluation"}', '{"key:valid":"invented"}'])
    expect(() => parseTrafficOriginBindings(value)).toThrow();
});

describe("every recall entry point carries the credential's traffic effects", () => {
  const trafficOrigins = parseTrafficOriginBindings('{"key:evaluation-key":"evaluation"}');
  const synthetic = { trafficOrigin: "evaluation", applyOrganicEffects: false };

  it.each(["/recall/unified", "/recall/explain"])("HTTP %s", async (path) => {
    const cognitive = makeMockCognitive();
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", "ws");
      c.set("actorId", "evaluation-key");
      c.set("actorType", "agent");
      await next();
    });
    mountRecallTiering(app, { cognitive, trafficOrigins } as unknown as ServerDeps);
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"query":"q"}',
    });
    expect(response.status).toBe(200);
    expect(vi.mocked(cognitive.recall).mock.calls[0]![0].effects).toEqual(synthetic);
  });

  it("gRPC Recall", async () => {
    const token = "mns_live_abcdefghijklmnopqrstu";
    const keyHash = await bcrypt.hash(token, 4);
    const cognitive = makeMockCognitive();
    const deps = {
      cognitive,
      trafficOrigins: parseTrafficOriginBindings('{"key:k1":"evaluation"}'),
      apiKeys: {
        listActive: vi.fn().mockResolvedValue([]),
        touch: vi.fn(),
        findByLookupHash: vi.fn().mockResolvedValue({
          id: "k1",
          keyHash,
          workspaceId: "00000000-0000-0000-0000-000000000001",
          scopes: ["memory:read"],
        }),
      },
    } as unknown as ServerDeps;
    const transport = createRouterTransport((r) => createMnemosyneRoutes(r, deps), {
      router: { interceptors: [createAuthInterceptor(deps)] },
    });
    await createClient(MnemosyneService, transport).recall(
      { query: "q", limit: 5 },
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(vi.mocked(cognitive.recall).mock.calls[0]![0].effects).toEqual(synthetic);
  });
});
