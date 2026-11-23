/**
 * GET /graph/traverse, GET /graph/path and POST /relations/traverse honour the
 * caller's sensitivity ceiling: a capped caller never receives the id, the
 * connectivity or the relation verbs of a node above it. The real in-memory
 * adapter sits behind the routes; the graph is A - B and A -> Secret -> C, so
 * C is reachable only through the restricted node.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountGraph } from "../routes/graph.js";
import { mountRelations } from "../routes/relations.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_graphtraverseceiling0001";
const WS_ID = "00000000-0000-0000-0000-000000000903";

async function makeApp() {
  const storage = new InMemoryStorageAdapter();
  const entity = (name: string, sensitivity?: "restricted") =>
    storage.createEntity({
      workspaceId: WS_ID,
      name,
      kind: "concept",
      ...(sensitivity ? { sensitivity } : {}),
    });
  const a = await entity("A");
  const b = await entity("B");
  const c = await entity("C");
  const secret = await entity("Secret", "restricted");
  for (const [source, target] of [
    [a, b],
    [a, secret],
    [secret, c],
  ] as const) {
    await storage.createRelation({
      workspaceId: WS_ID,
      sourceId: source.id,
      sourceType: "entity",
      targetId: target.id,
      targetType: "entity",
      verb: "related",
    });
  }

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: ["memory:read"], plan: "free" },
    ],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const app = buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [
    mountGraph,
    mountRelations,
  ]);
  const call = async (path: string, body?: unknown) => {
    const res = await app.request(path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    return { text, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { call, a, b, c, secret };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("graph traversal — default ceiling (internal)", () => {
  it("GET /graph/traverse stops at the hidden node and never names it", async () => {
    const { call, a, b, c, secret } = await makeApp();
    const fromA = await call(`/graph/traverse?root=${a.id}&maxHops=3`);
    expect(fromA.json.hits).toEqual([{ id: b.id, hop: 1, relevance: 0.6 }]);
    expect(fromA.text).not.toContain(secret.id);
    // Starting at (or behind) the hidden node looks like an unknown id.
    expect((await call(`/graph/traverse?root=${secret.id}`)).json.hits).toEqual([]);
    expect((await call(`/graph/traverse?root=${c.id}`)).json.hits).toEqual([]);
  });

  it("GET /graph/path returns no path that runs through the hidden node", async () => {
    const { call, a, c, secret } = await makeApp();
    const res = await call(`/graph/path?from=${a.id}&to=${c.id}`);
    expect(res.json).toEqual({ path: [], edges: [] });
    expect((await call(`/graph/path?from=${a.id}&to=${secret.id}`)).json).toEqual({
      path: [],
      edges: [],
    });
  });

  it("POST /relations/traverse returns only visible nodes and edges", async () => {
    const { call, a, b, secret } = await makeApp();
    const res = await call("/relations/traverse", {
      rootId: a.id,
      rootKind: "entity",
      maxDepth: 3,
    });
    expect(res.json.nodes).toEqual([
      { id: a.id, kind: "entity" },
      { id: b.id, kind: "entity" },
    ]);
    expect(res.json.edges).toHaveLength(1);
    expect(res.text).not.toContain(secret.id);
    const fromSecret = await call("/relations/traverse", { rootId: secret.id, rootKind: "entity" });
    expect(fromSecret.json).toEqual({ nodes: [{ id: secret.id, kind: "entity" }], edges: [] });
  });
});

describe("graph traversal — ceiling raised to restricted", () => {
  it("walks through the restricted node on all three routes", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const { call, a, b, c, secret } = await makeApp();
    const hits = (await call(`/graph/traverse?root=${a.id}&maxHops=3`)).json.hits as Array<{
      id: string;
    }>;
    expect(hits.map((h) => h.id).sort()).toEqual([b.id, c.id, secret.id].sort());
    expect((await call(`/graph/path?from=${a.id}&to=${c.id}`)).json.path).toEqual([
      a.id,
      secret.id,
      c.id,
    ]);
    const traversed = await call("/relations/traverse", {
      rootId: a.id,
      rootKind: "entity",
      maxDepth: 3,
    });
    expect((traversed.json.nodes as Array<{ id: string }>).map((n) => n.id).sort()).toEqual(
      [a.id, b.id, c.id, secret.id].sort()
    );
  });
});
