/**
 * Tier A parity — GET /graph, GET /graph/traverse, GET /graph/path,
 * POST /admin/graph/semantic-backfill (design.md D3).
 *
 * HTTP characterization contract for `packages/server/src/routes/graph.ts`.
 * Asserts the observable contract: status matrix, response key set/types
 * (via `contracts/graph.schema.json`), and query forwarding.
 *
 * flatten-legacy-dual-core PR9f port (design.md D6.5): `GET /graph`,
 * `GET /graph/traverse`, `GET /graph/path` are ported off `deps.core`.
 *
 * flatten-legacy-dual-core PR9g port (design.md D6.5): `POST /admin/graph/
 * semantic-backfill` is now ALSO ported off `deps.core` —
 * `deps.core.backfillSemanticNeighbors` replaced by `deps.storage.
 * backfillSemanticNeighbors` (v3 StorageAdapter). Same call-arg shape
 * (`{workspaceId, k?, threshold?}`), zero-`expect()`-diff port — only the
 * mock plumbing (`core.backfillSemanticNeighbors` moved onto `storage`)
 * changed. This closes `graph.ts` fully off `deps.core` (all 4 handlers now
 * ported across PR9f + PR9g).
 *
 * `GET /graph`'s describe block is also a zero-`expect()`-diff port: legacy
 * `deps.core.graph`'s call-arg shape (`GraphQueryOptions`) is field-for-field
 * identical to the new `deps.storage.getGraphSnapshot`'s `GraphSnapshotFilter`
 * — only the mock plumbing (`core.graph` → `storage.getGraphSnapshot`) changed.
 *
 * `GET /graph/traverse`/`GET /graph/path` are DISCLOSED exceptions to the
 * zero-`expect()`-diff rule (same class as PR6/PR9c/PR12's disclosed
 * exceptions): the route no longer makes ONE opaque call to
 * `deps.core.graphTraverse`/`graphPath` — it now calls the pure-core
 * `traverseGraph`/`findGraphPath` (`@mnemo-ai/core/cognitive`), which loop
 * `deps.storage.getRelations` per hop (up to 2 batched calls per hop,
 * `sourceIds` + `targetIds`, undirected). These 2 describe blocks were
 * rewritten to mock `deps.storage.getRelations` with fixture relation rows
 * and assert the resulting HTTP-observable `{hits}`/`{path,edges}` shape —
 * the real BFS/pathfinding algorithm itself is unit-tested against the pure
 * functions directly in `packages/core/src/cognitive/__tests__/
 * graph-traverse.test.ts`, and against real Postgres in
 * `packages/adapter-postgres/src/__tests__/graph-snapshot-and-traverse.
 * integration.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountGraph } from "../../routes/graph.js";

const PLAINTEXT_KEY = "mns_live_graphparitytest00000001";
const WS_ID = "00000000-0000-0000-0000-000000000901";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "graph-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json", ...extra };
}

function graphResult() {
  return {
    nodes: [
      {
        id: "ment_a23bcdef0123456789ghijkl",
        kind: "entity" as const,
        entityKind: "person" as const,
        label: "Ada",
        description: null,
        mentionCount: 1,
        factCount: 2,
        avgMemoryStrength: 0.5,
        createdAt: "2026-06-20T00:00:00.000Z",
      },
    ],
    edges: [],
    meta: { entityCount: 1, episodeCount: 0, decisionCount: 0, relationCount: 0 },
  };
}

interface Overrides {
  getGraphSnapshot?: ReturnType<typeof vi.fn>;
  getRelations?: ReturnType<typeof vi.fn>;
  backfillSemanticNeighbors?: ReturnType<typeof vi.fn>;
  storage?: Record<string, ReturnType<typeof vi.fn>>;
}

async function buildApp(overrides: Overrides = {}) {
  const getGraphSnapshot = overrides.getGraphSnapshot ?? vi.fn().mockResolvedValue(graphResult());
  const getRelations = overrides.getRelations ?? vi.fn().mockResolvedValue([]);
  const backfillSemanticNeighbors =
    overrides.backfillSemanticNeighbors ?? vi.fn().mockResolvedValue(12);
  const storage = overrides.storage ?? {
    appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    getGraphSnapshot,
    getRelations,
    backfillSemanticNeighbors,
  };

  const deps = {
    storage,
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountGraph]);
  return { app, deps, getGraphSnapshot, getRelations, backfillSemanticNeighbors, storage };
}

describe("Tier A parity: GET /graph", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/graph");
    expect(res.status).toBe(401);
  });

  it("returns 200 conforming to graph.schema.json, with Cache-Control: private, max-age=30", async () => {
    const graphSchema = loadSchema("graph");
    const { app } = await buildApp();
    const res = await app.request("/graph", { headers: authed() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=30");
    const body = (await res.json()) as unknown;
    expect(validate(body, graphSchema)).toBeNull();
  });

  it("forwards workspaceId and the caller's ceiling with no optional fields when focus/includeSemantic/asOf are absent", async () => {
    const { app, getGraphSnapshot } = await buildApp();
    await app.request("/graph", { headers: authed() });
    // H3-a: the caller's sensitivity ceiling (default env ceiling: internal).
    expect(getGraphSnapshot).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      maxSensitivity: "internal",
    });
  });

  it("forwards focus + includeSemantic + asOf query params", async () => {
    const { app, getGraphSnapshot } = await buildApp();
    await app.request(
      "/graph?focus=ment_a23bcdef0123456789ghijkl&includeSemantic=true&asOf=2026-01-01T00:00:00Z",
      { headers: authed() }
    );
    expect(getGraphSnapshot).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      maxSensitivity: "internal",
      focusEntityId: "ment_a23bcdef0123456789ghijkl",
      includeSemantic: true,
      asOf: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("forwards includeMentions", async () => {
    const { app, getGraphSnapshot } = await buildApp();
    await app.request("/graph?includeMentions=1", { headers: authed() });
    expect(getGraphSnapshot).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      maxSensitivity: "internal",
      includeMentions: true,
    });
  });

  it("returns 400 on a malformed focus id", async () => {
    const { app } = await buildApp();
    const res = await app.request("/graph?focus=not-a-valid-id!!", { headers: authed() });
    expect(res.status).toBe(400);
  });
});

// DISCLOSED exception (see file header): the route no longer makes one
// opaque call to deps.core.graphTraverse — it runs the real `traverseGraph`
// BFS over `deps.storage.getRelations`. This fixture models a single relation
// `ent_abc123 --related--> ent_1`: at hop 1 both the sourceIds and targetIds
// batched queries return it (a real adapter would only match one side per
// query; the mock ignores filter args, so `traverseGraph`'s own
// already-visited dedup collapses the duplicate — see graph-traverse.test.ts
// for the algorithm's real per-direction proof). Hop 2's frontier (`ent_1`)
// only re-discovers the already-visited root, so the walk terminates with
// exactly one hit.
const TRAVERSE_FIXTURE_RELATION = {
  sourceId: "ent_abc123",
  targetId: "ent_1",
  verb: "related",
  judgmentStatus: "pending",
};

describe("Tier A parity: GET /graph/traverse", () => {
  it("returns 200 with { hits } shape", async () => {
    const { app } = await buildApp({
      getRelations: vi.fn().mockResolvedValue([TRAVERSE_FIXTURE_RELATION]),
    });
    const res = await app.request("/graph/traverse?root=ent_abc123", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.hits).toEqual([{ id: "ent_1", hop: 1, relevance: 0.6 }]);
  });

  it("returns 400 when root is missing", async () => {
    const { app } = await buildApp();
    const res = await app.request("/graph/traverse", { headers: authed() });
    expect(res.status).toBe(400);
  });

  it("forwards root + maxHops + relations (split) + asOf to getRelations, batched sourceIds/targetIds", async () => {
    const { app, getRelations } = await buildApp({
      getRelations: vi.fn().mockResolvedValue([TRAVERSE_FIXTURE_RELATION]),
    });
    await app.request(
      "/graph/traverse?root=ent_abc123&maxHops=2&relations=related,derived_from&asOf=2026-01-01T00:00:00Z",
      { headers: authed() }
    );
    const base = {
      workspaceId: WS_ID,
      verbs: ["related", "derived_from"],
      validAt: new Date("2026-01-01T00:00:00Z"),
      limit: 2000,
      // The caller's ceiling (default env ceiling: internal).
      maxSensitivity: "internal",
    };
    expect(getRelations).toHaveBeenCalledWith({ ...base, sourceIds: ["ent_abc123"] });
    expect(getRelations).toHaveBeenCalledWith({ ...base, targetIds: ["ent_abc123"] });
  });
});

describe("Tier A parity: GET /graph/path", () => {
  // DISCLOSED exception (see file header): models a single relation
  // `ent_1 --related--> ent_2`, the exact edge the pre-port mock previously
  // returned verbatim — the ported route's { path, edges } output is
  // byte-identical to the pre-port fixture.
  const PATH_FIXTURE_RELATION = {
    sourceId: "ent_1",
    targetId: "ent_2",
    verb: "related",
    judgmentStatus: "pending",
  };

  it("returns 200 with { path, edges } shape", async () => {
    const { app } = await buildApp({
      getRelations: vi.fn().mockResolvedValue([PATH_FIXTURE_RELATION]),
    });
    const res = await app.request("/graph/path?from=ent_1&to=ent_2", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string[]; edges: unknown[] };
    expect(body.path).toEqual(["ent_1", "ent_2"]);
    expect(body.edges).toEqual([{ source: "ent_1", target: "ent_2", relation: "related" }]);
  });

  it("forwards the caller's ceiling to every getRelations call", async () => {
    const { app, getRelations } = await buildApp({
      getRelations: vi.fn().mockResolvedValue([PATH_FIXTURE_RELATION]),
    });
    await app.request("/graph/path?from=ent_1&to=ent_2", { headers: authed() });
    expect(getRelations).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      openOnly: true,
      limit: 2000,
      maxSensitivity: "internal",
      sourceIds: ["ent_1"],
    });
  });

  it("returns 400 when from/to are missing", async () => {
    const { app } = await buildApp();
    const res = await app.request("/graph/path?from=ent_1", { headers: authed() });
    expect(res.status).toBe(400);
  });
});

describe("Tier A parity: POST /admin/graph/semantic-backfill", () => {
  it("returns 200 with { edgesWritten } and emits an admin_access audit entry", async () => {
    const { app, storage } = await buildApp();
    const res = await app.request("/admin/graph/semantic-backfill", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ k: 5, threshold: 0.8 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edgesWritten: number };
    expect(body).toEqual({ edgesWritten: 12 });
    expect(storage.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        action: "admin_access",
        resourceKind: "graph_backfill",
        resourceId: WS_ID,
        detail: { edgesWritten: 12 },
      })
    );
  });

  it("forwards k + threshold body fields to deps.storage.backfillSemanticNeighbors", async () => {
    const { app, backfillSemanticNeighbors } = await buildApp();
    await app.request("/admin/graph/semantic-backfill", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ k: 5, threshold: 0.8 }),
    });
    expect(backfillSemanticNeighbors).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      k: 5,
      threshold: 0.8,
    });
  });

  it("defaults to no body fields when the request has no body/content-type", async () => {
    const { app, backfillSemanticNeighbors } = await buildApp();
    const res = await app.request("/admin/graph/semantic-backfill", {
      method: "POST",
      headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(backfillSemanticNeighbors).toHaveBeenCalledWith({ workspaceId: WS_ID });
  });
});
