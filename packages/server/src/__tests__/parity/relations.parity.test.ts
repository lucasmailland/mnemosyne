/**
 * Tier A parity — `routes/relations.ts` (design.md D3).
 *
 * HTTP characterization contract for GET/POST /relations, PATCH /relations/:id
 * (judgment), and POST /relations/traverse. Originally written and merged
 * green against the legacy `deps.core.{listRelations,createRelation,
 * patchRelation}` (`CoreLike`) implementation (flatten-legacy-dual-core PR8,
 * when the port was blocked — see apply-progress.md PR8 "Scope finding:
 * relations.ts"). The port commit (PR9d, design.md D6.4/D6.6) swapped the
 * route to `deps.storage.{getRelations,createRelation,applyRelationJudgment}`
 * (v3 `StorageAdapter`, widened by PR9c to the full judgment-workflow column
 * set that PR8 found genuinely missing).
 *
 * Per D3, response-body assertions (`validate(item, relationSchema)`,
 * status codes) are unchanged by the port — the HTTP-observable contract is
 * identical. Two disclosed exceptions to a byte-identical diff, both
 * unavoidable renames forced by the port (not behavior changes):
 *   1. `buildApp`'s deps-fake wiring moved from `deps.core.{listRelations,
 *      createRelation,patchRelation}` to `deps.storage.{getRelations,
 *      createRelation,applyRelationJudgment}` — the v3 method names differ
 *      from their legacy counterparts (`list`->`get`, `patch`->`apply...
 *      Judgment`), so `expect(...).toHaveBeenCalledWith(...)` assertions
 *      that verify which mock fired now target `deps.storage.X` instead of
 *      `deps.core.X`.
 *   2. The `toHaveBeenCalledWith(...)` argument shape for `createRelation`/
 *      `applyRelationJudgment` uses v3 `CreateRelationInput`/
 *      `ApplyRelationJudgmentInput` field names (`sourceType`/`targetType`/
 *      `verb`) instead of the legacy wire-shaped field names (`sourceKind`/
 *      `targetKind`/`relation`) — same pattern `conflicts.ts`'s B5 port and
 *      `decisions.parity.test.ts` (PR8) already established for composed
 *      calls whose port target has a different parameter shape than the
 *      legacy call it replaced.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountRelations } from "../../routes/relations.js";

const PLAINTEXT_KEY = "mns_live_relationsparitytest0001";
const WS_ID = "00000000-0000-0000-0000-000000000f01";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "relations-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

// flatten-legacy-dual-core PR9d: fixture shape is now the v3 `MnemoRelation`
// domain object (`sourceType`/`targetType`/`verb`, real `Date` fields —
// `relationToWire()` calls `.toISOString()` on them), not the legacy
// wire-shaped `CoreRelation`. `mountRelations` maps this to the wire shape
// (`sourceKind`/`targetKind`/`relation`, ISO strings) via `relationToWire()`
// before it ever reaches an `expect(...)` assertion.
function relationRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    sourceId: "fact_1",
    sourceType: "fact" as const,
    targetId: "fact_2",
    targetType: "fact" as const,
    verb: "related" as const,
    weight: 1,
    coRecallCount: 0,
    directionality: 0,
    judgmentStatus: "pending" as const,
    reason: null,
    evidence: null,
    confidence: null,
    markedByUserId: null,
    markedByKind: "user" as const,
    markedByModel: null,
    markedByPromptVersion: null,
    provenance: null,
    conversationId: null,
    supersededByRelationId: null,
    validFrom: new Date(NOW),
    validTo: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

async function buildApp(
  storage: Partial<{
    getRelations: ReturnType<typeof vi.fn>;
    createRelation: ReturnType<typeof vi.fn>;
    applyRelationJudgment: ReturnType<typeof vi.fn>;
    getFact: ReturnType<typeof vi.fn>;
    getDecision: ReturnType<typeof vi.fn>;
    getEntity: ReturnType<typeof vi.fn>;
    getStrategy: ReturnType<typeof vi.fn>;
    getWorkflow: ReturnType<typeof vi.fn>;
  }> = {}
) {
  const deps = {
    storage: {
      // PRIM-13: POST /relations looks both endpoints up (existence + ceiling).
      getFact: vi.fn().mockResolvedValue({ sensitivity: "internal" }),
      getDecision: vi.fn().mockResolvedValue({ sensitivity: "internal" }),
      getEntity: vi.fn().mockResolvedValue({ sensitivity: "internal" }),
      getRelations: vi.fn().mockResolvedValue([relationRecord("rel_1")]),
      createRelation: vi.fn().mockResolvedValue(relationRecord("rel_new")),
      applyRelationJudgment: vi
        .fn()
        .mockResolvedValue(relationRecord("rel_1", { judgmentStatus: "judged" })),
      ...storage,
    },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountRelations]);
  return { app, deps };
}

describe("Tier A parity: GET /relations", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/relations");
    expect(res.status).toBe(401);
  });

  it("returns 200 with items conforming to relation.schema.json", async () => {
    const relationSchema = loadSchema("relation");
    const { app } = await buildApp();
    const res = await app.request("/relations", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      const err = validate(item, relationSchema);
      expect(err).toBeNull();
    }
  });

  it("forwards judgmentStatus + limit query params", async () => {
    const { app, deps } = await buildApp();
    await app.request("/relations?judgmentStatus=judged&limit=10", { headers: authed() });
    expect(deps.storage.getRelations).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      judgmentStatus: "judged",
      openOnly: true,
      maxSensitivity: "internal",
      limit: 10,
    });
  });

  it("forwards sourceId (outgoing) and targetId (incoming) so `from` is honoured (CLIENTS-8)", async () => {
    const { app, deps } = await buildApp();
    await app.request("/relations?sourceId=fact_a&limit=5", { headers: authed() });
    expect(deps.storage.getRelations).toHaveBeenLastCalledWith({
      workspaceId: WS_ID,
      sourceId: "fact_a",
      openOnly: true,
      maxSensitivity: "internal",
      limit: 5,
    });
    await app.request("/relations?targetId=fact_b", { headers: authed() });
    expect(deps.storage.getRelations).toHaveBeenLastCalledWith({
      workspaceId: WS_ID,
      targetId: "fact_b",
      openOnly: true,
      maxSensitivity: "internal",
      limit: 50,
    });
  });

  it("includeClosed=true drops the open-only filter (history on request)", async () => {
    const { app, deps } = await buildApp();
    await app.request("/relations?includeClosed=true", { headers: authed() });
    // The storage default is open rows only, so history is an explicit opt-out.
    expect(deps.storage.getRelations).toHaveBeenLastCalledWith({
      workspaceId: WS_ID,
      openOnly: false,
      maxSensitivity: "internal",
      limit: 50,
    });
  });

  it("returns 400 when limit exceeds the max (500)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/relations?limit=501", { headers: authed() });
    expect(res.status).toBe(400);
  });
});

describe("PRIM-13: POST /relations endpoint integrity", () => {
  const post = (app: Awaited<ReturnType<typeof buildApp>>["app"], body: Record<string, unknown>) =>
    app.request("/relations", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: "fact_1",
        targetKind: "fact",
        targetId: "fact_2",
        relation: "related",
        markedByKind: "user",
        ...body,
      }),
    });

  it("rejects a self-loop with 400 and writes nothing", async () => {
    const { app, deps } = await buildApp();
    const res = await post(app, { targetId: "fact_1" });
    expect(res.status).toBe(400);
    expect(deps.storage.createRelation).not.toHaveBeenCalled();
  });

  it("answers 404 when an endpoint does not exist (or is another workspace's)", async () => {
    const { app, deps } = await buildApp({ getFact: vi.fn().mockResolvedValue(null) });
    const res = await post(app, {});
    expect(res.status).toBe(404);
    expect(deps.storage.createRelation).not.toHaveBeenCalled();
  });

  it("looks an endpoint up under its declared kind: a fact id sent as an entity is a 404", async () => {
    const { app, deps } = await buildApp({ getEntity: vi.fn().mockResolvedValue(null) });
    const res = await post(app, { targetKind: "entity", targetId: "fact_2" });
    expect(res.status).toBe(404);
    expect(deps.storage.createRelation).not.toHaveBeenCalled();
  });

  it("answers the same 404 for an endpoint above the caller's sensitivity ceiling", async () => {
    const { app } = await buildApp({
      getFact: vi.fn().mockResolvedValue({ sensitivity: "restricted" }),
    });
    const res = await post(app, {});
    expect(res.status).toBe(404);
  });

  it("accepts the widened kinds (strategy -> workflow)", async () => {
    const { app } = await buildApp({
      getStrategy: vi.fn().mockResolvedValue({ sensitivity: "internal" }),
      getWorkflow: vi.fn().mockResolvedValue({ sensitivity: "internal" }),
    });
    const res = await post(app, {
      sourceKind: "strategy",
      sourceId: "s1",
      targetKind: "workflow",
      targetId: "w1",
      relation: "supersedes",
    });
    expect(res.status).toBe(201);
  });
});

describe("Tier A parity: POST /relations", () => {
  it("returns 201 with the created relation conforming to relation.schema.json", async () => {
    const relationSchema = loadSchema("relation");
    const { app } = await buildApp();
    const res = await app.request("/relations", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: "fact_1",
        targetKind: "fact",
        targetId: "fact_2",
        relation: "related",
        markedByKind: "user",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as unknown;
    const err = validate(body, relationSchema);
    expect(err).toBeNull();
  });

  it("returns 400 on an unknown verb (not in the locked vocabulary)", async () => {
    // Zod's RelationVerbEnum rejects the unknown verb before the handler's
    // own explicit §34.6 guard runs, so this exercises request validation,
    // not the handler-level "invalid_verb" branch (see PATCH test below for
    // that path via a value that passes Zod but not the runtime guard —
    // there is none; the two checks are fully redundant by construction).
    const { app } = await buildApp();
    const res = await app.request("/relations", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: "fact_1",
        targetKind: "fact",
        targetId: "fact_2",
        relation: "not_a_real_verb",
        markedByKind: "user",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("forwards source/target/verb/markedByKind + provenance to deps.storage.createRelation", async () => {
    const { app, deps } = await buildApp();
    await app.request("/relations", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: "fact_1",
        targetKind: "decision",
        targetId: "dec_1",
        relation: "supersedes",
        markedByKind: "agent",
        reason: "newer info",
      }),
    });
    expect(deps.storage.createRelation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        sourceType: "fact",
        sourceId: "fact_1",
        targetType: "decision",
        targetId: "dec_1",
        verb: "supersedes",
        markedByKind: "agent",
        reason: "newer info",
      })
    );
  });
});

describe("Tier A parity: PATCH /relations/:id", () => {
  it("returns 200 with the updated relation", async () => {
    const relationSchema = loadSchema("relation");
    const { app } = await buildApp();
    const res = await app.request("/relations/rel_1", {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ relation: "conflicts_with", markedByKind: "llm_judge" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const err = validate(body, relationSchema);
    expect(err).toBeNull();
  });

  it("returns 404 when the relation does not exist", async () => {
    const { app } = await buildApp({ applyRelationJudgment: vi.fn().mockResolvedValue(null) });
    const res = await app.request("/relations/rel_missing", {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ relation: "related", markedByKind: "user" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 on an unknown verb", async () => {
    const { app } = await buildApp();
    const res = await app.request("/relations/rel_1", {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ relation: "bogus", markedByKind: "user" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Tier A parity: POST /relations/traverse", () => {
  it("returns 200 with nodes+edges for a single-layer BFS", async () => {
    const { app } = await buildApp();
    const res = await app.request("/relations/traverse", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ rootId: "fact_1", rootKind: "fact", maxDepth: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });

  it("forwards the caller's ceiling to each layer's getRelations call", async () => {
    const { app, deps } = await buildApp();
    await app.request("/relations/traverse", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ rootId: "fact_1", rootKind: "fact", maxDepth: 1 }),
    });
    expect(deps.storage.getRelations).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      sourceIds: ["fact_1"],
      openOnly: true,
      limit: 2001,
      maxSensitivity: "internal",
    });
  });

  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/relations/traverse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootId: "fact_1", rootKind: "fact" }),
    });
    expect(res.status).toBe(401);
  });
});
