/**
 * Tier A parity — `routes/conflicts.ts` (design.md D3, B5).
 *
 * HTTP characterization contract for GET /conflicts and
 * POST /conflicts/:id/resolve. Written and merged green against the legacy
 * `deps.core.{listRelations,getFact,closeFact,patchRelation,createFact,
 * createRelation}` (`CoreLike`) implementation FIRST (flatten-legacy-dual-core
 * PR11); the port commit in this same PR swaps the route to
 * `deps.storage.{getRelations,getFact,resolveConflict}` (v3 `StorageAdapter`).
 *
 * DISCLOSED exception (same class as `decisions.parity.test.ts`'s file-header
 * exceptions): legacy chained 4-6 independently-transactional `deps.core`
 * calls per resolution (the B5 bug — see `ResolveConflictInput`'s doc comment
 * in ports.ts); v3 replaces them with ONE atomic composite
 * `deps.storage.resolveConflict` call. The internal call shape genuinely
 * differs (that IS the fix), the observable HTTP contract does not — the 3
 * action-specific tests below (`supersede_a`/`supersede_b`/`merge`) assert
 * against `resolveConflict`'s forwarded arguments instead of the old
 * `closeFact`/`createRelation`/`createFact` call sites; every other test in
 * this file (status codes, response shape, relation lookup/filtering) is
 * unchanged.
 *
 * B5 atomicity itself (the merge becoming one transaction, no partial state
 * on mid-sequence failure) is NOT testable through this HTTP-level fake —
 * that is a real-Postgres integration test
 * (`__tests__/integration/conflict-resolution-atomicity.integration.test.ts`,
 * testcontainers, DB-level failure injection).
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountConflicts } from "../../routes/conflicts.js";

const PLAINTEXT_KEY = "mns_live_conflictsparitytest0001";
const WS_ID = "00000000-0000-0000-0000-0000000c0001";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "conflicts-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

// v3 `MnemoRelation` shape (`sourceType`/`targetType`/`verb`), not legacy's
// `sourceKind`/`targetKind`/`relation`.
function v3ConflictRelation(overrides: Record<string, unknown> = {}) {
  return {
    id: "rel_conflict_1",
    workspaceId: WS_ID,
    sourceId: "fact_a",
    sourceType: "fact",
    targetId: "fact_b",
    targetType: "fact",
    verb: "conflicts_with",
    weight: 1,
    confidence: 0.8,
    validTo: null, // MnemoRelation.validTo is Date | null (never undefined) — null means open
    ...overrides,
  };
}

// v3 `MnemoFact` shape (subject/statement/worth are native fields, not a
// simplified content/attribution/tags shape reached via `unknown` cast).
function v3FactRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    subject: "workspace",
    statement: "Some statement",
    worth: 0.7,
    validFrom: new Date(NOW),
    validTo: undefined,
    ...overrides,
  };
}

async function buildApp(
  overrides: Partial<{
    getRelations: ReturnType<typeof vi.fn>;
    getFact: ReturnType<typeof vi.fn>;
    resolveConflict: ReturnType<typeof vi.fn>;
  }> = {}
) {
  const getRelations = overrides.getRelations ?? vi.fn().mockResolvedValue([v3ConflictRelation()]);
  const getFact =
    overrides.getFact ?? vi.fn().mockImplementation(async (id: string) => v3FactRow(id));
  const resolveConflict =
    overrides.resolveConflict ?? vi.fn().mockResolvedValue({ mergedFactId: null });
  const deps = {
    storage: {
      getRelations,
      getFact,
      resolveConflict,
      countOpenConflicts: vi.fn().mockResolvedValue(0),
    },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountConflicts]);
  return { app, getRelations, getFact, resolveConflict };
}

describe("Tier A parity: GET /conflicts", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/conflicts");
    expect(res.status).toBe(401);
  });

  it("returns 200 with pairs conforming to conflict-pair.schema.json", async () => {
    const schema = loadSchema("conflict-pair");
    const { app } = await buildApp();
    const res = await app.request("/conflicts", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairs: unknown[] };
    expect(Array.isArray(body.pairs)).toBe(true);
    expect(body.pairs.length).toBeGreaterThan(0);
    for (const pair of body.pairs) {
      const err = validate(pair, schema);
      expect(err).toBeNull();
    }
  });

  it("returns an empty pairs array when there are no conflicts_with relations", async () => {
    const { app } = await buildApp({ getRelations: vi.fn().mockResolvedValue([]) });
    const res = await app.request("/conflicts", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairs: unknown[] };
    expect(body.pairs).toEqual([]);
  });

  it("skips already-closed pairs", async () => {
    const { app } = await buildApp({
      getRelations: vi
        .fn()
        .mockResolvedValue([
          v3ConflictRelation({ id: "rel_closed", validTo: new Date("2026-01-01T00:00:00.000Z") }),
          v3ConflictRelation({ id: "rel_open" }),
        ]),
    });
    const res = await app.request("/conflicts", { headers: authed() });
    const body = (await res.json()) as { pairs: Array<{ relationId: string }> };
    expect(body.pairs.map((p) => p.relationId)).toEqual(["rel_open"]);
  });

  it("fills the page after dropping pairs with a missing or closed fact (PRIM-19)", async () => {
    // The route used to slice to `limit` BEFORE dropping unjudgeable pairs, so
    // every dropped pair cost a slot: `limit=N` returned N-1 pairs in the
    // eval workspace, and a page of dangling relations hid every live one.
    const { app } = await buildApp({
      getRelations: vi
        .fn()
        .mockResolvedValue([
          v3ConflictRelation({ id: "rel_dangling", sourceId: "fact_gone" }),
          v3ConflictRelation({ id: "rel_closed_fact", targetId: "fact_closed" }),
          v3ConflictRelation({ id: "rel_1" }),
          v3ConflictRelation({ id: "rel_2" }),
          v3ConflictRelation({ id: "rel_3" }),
          v3ConflictRelation({ id: "rel_4" }),
        ]),
      getFact: vi.fn().mockImplementation(async (id: string) => {
        if (id === "fact_gone") return null;
        if (id === "fact_closed") return v3FactRow(id, { validTo: new Date(NOW) });
        return v3FactRow(id);
      }),
    });
    const res = await app.request("/conflicts?limit=3", { headers: authed() });
    const body = (await res.json()) as { pairs: Array<{ relationId: string }> };
    expect(body.pairs.map((p) => p.relationId)).toEqual(["rel_1", "rel_2", "rel_3"]);
  });

  it("respects the limit query param (default 5, max 20)", async () => {
    const { app } = await buildApp({ getRelations: vi.fn().mockResolvedValue([]) });
    const res = await app.request("/conflicts?limit=25", { headers: authed() });
    expect(res.status).toBe(400);
  });
});

describe("Tier A parity: POST /conflicts/:id/resolve", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/conflicts/rel_conflict_1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "keep_both" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the relation does not exist", async () => {
    const { app } = await buildApp({ getRelations: vi.fn().mockResolvedValue([]) });
    const res = await app.request("/conflicts/rel_missing/resolve", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ action: "keep_both" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the relation is not a conflicts_with relation", async () => {
    const { app } = await buildApp({
      getRelations: vi.fn().mockResolvedValue([v3ConflictRelation({ verb: "related" })]),
    });
    const res = await app.request("/conflicts/rel_conflict_1/resolve", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ action: "keep_both" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when action='merge' without mergedStatement", async () => {
    const { app } = await buildApp();
    const res = await app.request("/conflicts/rel_conflict_1/resolve", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ action: "merge" }),
    });
    expect(res.status).toBe(400);
  });

  it("keep_both: returns 200 resolved with a null mergedFactId", async () => {
    const { app } = await buildApp();
    const res = await app.request("/conflicts/rel_conflict_1/resolve", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ action: "keep_both" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolved: boolean;
      action: string;
      relationId: string;
      mergedFactId: string | null;
    };
    expect(body).toEqual({
      resolved: true,
      action: "keep_both",
      relationId: "rel_conflict_1",
      mergedFactId: null,
    });
  });

  // DISCLOSED exception (see file header) — asserts against
  // `resolveConflict`'s forwarded arguments, not the old
  // `closeFact`/`createRelation` call sites.
  it("supersede_a: forwards factA (source) as the loser and factB (target) as the winner", async () => {
    const { app, resolveConflict } = await buildApp();
    const res = await app.request("/conflicts/rel_conflict_1/resolve", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ action: "supersede_a" }),
    });
    expect(res.status).toBe(200);
    expect(resolveConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        relationId: "rel_conflict_1",
        sourceId: "fact_a",
        targetId: "fact_b",
        action: "supersede_a",
      })
    );
  });

  it("supersede_b: forwards factB (target) as the loser and factA (source) as the winner", async () => {
    const { app, resolveConflict } = await buildApp();
    const res = await app.request("/conflicts/rel_conflict_1/resolve", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ action: "supersede_b" }),
    });
    expect(res.status).toBe(200);
    expect(resolveConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        relationId: "rel_conflict_1",
        sourceId: "fact_a",
        targetId: "fact_b",
        action: "supersede_b",
      })
    );
  });

  it("merge: forwards mergedStatement + both fact ids, and returns the created fact's id", async () => {
    const { app, resolveConflict } = await buildApp({
      resolveConflict: vi.fn().mockResolvedValue({ mergedFactId: "fact_merged" }),
    });
    const res = await app.request("/conflicts/rel_conflict_1/resolve", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ action: "merge", mergedStatement: "Merged statement" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mergedFactId: string | null };
    expect(body.mergedFactId).toBe("fact_merged");
    expect(resolveConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        sourceId: "fact_a",
        targetId: "fact_b",
        action: "merge",
        mergedStatement: "Merged statement",
      })
    );
  });
});
