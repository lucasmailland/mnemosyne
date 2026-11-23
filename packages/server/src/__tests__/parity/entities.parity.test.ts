/**
 * Tier A parity — `routes/entities.ts`'s handlers (design.md D3):
 * GET /entities, GET /entities/:id, GET /entities/:id/facts, POST /entities,
 * PATCH /entities/:id.
 *
 * Originally written and merged green against the legacy
 * `deps.core.{listEntities,getEntity,listFactsForEntity,createEntity,
 * updateEntity,entityExists}` (`CoreLike`) implementation
 * (flatten-legacy-dual-core PR8). `POST/DELETE /entities/:id/link-user`
 * already ran on `deps.storage` before this PR and are covered by their own
 * existing test files — not duplicated here.
 *
 * flatten-legacy-dual-core PR9a note (D6.2 — T1 field additions): all 3
 * remaining `deps.core`-backed handlers are PORTED by this PR, closing
 * `entities.ts` FULLY off `deps.core`:
 *
 *   - `listEntitiesRoute`: NEW `EntityFilter.q` (case-insensitive substring
 *     across name+aliases, distinct from the pre-existing exact-match
 *     `name`) closes the gap. No pre-port test existed for this route (a
 *     gap in PR8's coverage) — the "GET /entities" describe block below is
 *     new, written and merged green against `deps.storage.queryEntities`
 *     directly per this PR's launch scope (already the target shape, since
 *     no `deps.core` fixture ever existed for this route to preserve).
 *   - `getEntityFactsRoute`: NEW `MnemoFact.linkedMemoryIds` (D6.2) closes
 *     the gap — `queryFacts` + `toMemoryFact()` replace `listFactsForEntity`.
 *   - `patchEntityRoute`: NEW `kind` on `UpdateEntityInput`/
 *     `EntityRepository.updateEntity` closes the gap. Also required
 *     widening `UpdateEntityInput.canonicalId`/`description` to accept
 *     `null` (matching legacy `CoreLike.updateEntity`'s already-nullable
 *     shape) — a real, disclosed additional fix found while porting: the
 *     Pick<MnemoEntity,...>-derived type only supported `undefined`
 *     ("untouched"), not `null` ("explicitly clear"), for these two fields.
 *
 * DISCLOSED exceptions to D3's zero-`expect()`-diff rule for `GET
 * /entities/:id/facts` and `PATCH /entities/:id` (the two routes with
 * PRE-EXISTING pre-port test bodies): `listFactsForEntity` returned
 * `{entity, facts}` in one round-trip using the legacy-shaped
 * `legacyEntityRecord`/`factRecord` fixtures; the port is getEntity() +
 * queryFacts() + entityToWire()/toMemoryFact(), which changes the WIRING
 * (mock names/call shape) but was written to still satisfy the same
 * `expect(...)` assertions unchanged. `patchEntityRoute`'s pre-existing
 * `entityExists` mock is replaced by a `getEntity`-based existence check
 * (v3 has no 1:1 `entityExists` equivalent) — same "swap the call"
 * substitution pattern used throughout this PR chain.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountEntities } from "../../routes/entities.js";

const PLAINTEXT_KEY = "mns_live_entitiesparitytest0001";
const WS_ID = "00000000-0000-0000-0000-000000001001";
const ENTITY_ID = "ment_a23bcdef0123456789ghijkl";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "entities-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

// v3 MnemoEntity fixture — Date fields as real Date objects (matches what
// `deps.storage.getEntity`/`createEntity` actually return; `entityToWire`
// then collapses them to ISO strings, same as the pre-existing link/unlink
// route tests do).
function v3EntityRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    name: "Acme",
    kind: "organization" as const,
    aliases: [] as string[],
    canonicalId: null,
    description: null,
    sensitivity: "internal" as const,
    metadata: {},
    linkedUserId: null,
    firstSeenAt: new Date(NOW),
    lastSeenAt: new Date(NOW),
    mentionCount: 1,
    // P120: response schemas project the bitemporal interval.
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

// v3 MnemoFact fixture (Date fields) — feeds queryFacts, mapped through
// toMemoryFact() by getEntityFactsRoute (D6.2: linkedMemoryIds now present).
function v3FactRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    agentId: undefined,
    scope: "global" as const,
    scopeRef: undefined,
    kind: "other" as const,
    subject: "Acme",
    statement: "is a client",
    confidence: 1,
    pinned: false,
    relevance: 1,
    hitCount: 0,
    lastRecalledAt: undefined,
    sourceMessageIds: [] as string[],
    attributedTo: undefined,
    linkedMemoryIds: [] as string[],
    metadata: {},
    status: "active" as const,
    mergedIntoId: undefined,
    validFrom: new Date(NOW),
    validTo: undefined,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

// buildApp returns individual mock fns by stable local name (not
// `deps.core.X`/`deps.storage.X`) so the port doesn't force `expect(...)`
// edits — same pattern as audit.parity.test.ts / decisions.parity.test.ts.
async function buildApp(
  overrides: Partial<{
    queryEntities: ReturnType<typeof vi.fn>;
    getEntity: ReturnType<typeof vi.fn>;
    queryFacts: ReturnType<typeof vi.fn>;
    createEntity: ReturnType<typeof vi.fn>;
    updateEntity: ReturnType<typeof vi.fn>;
  }> = {}
) {
  const queryEntities =
    overrides.queryEntities ??
    vi.fn().mockResolvedValue({
      items: [v3EntityRecord(ENTITY_ID)],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
    });
  const getEntity = overrides.getEntity ?? vi.fn().mockResolvedValue(v3EntityRecord(ENTITY_ID));
  // Default serves BOTH GET /entities/:id's linkedFactCount (via `.total`)
  // AND GET /entities/:id/facts' `.items` (via toMemoryFact()) — tests that
  // need divergent shapes override explicitly.
  const queryFacts =
    overrides.queryFacts ??
    vi.fn().mockResolvedValue({
      items: [v3FactRecord("fact_1")],
      total: 2,
      offset: 0,
      limit: 1,
      hasMore: false,
    });
  const createEntity =
    overrides.createEntity ??
    vi.fn().mockResolvedValue(v3EntityRecord("ment_new0000000000000000000"));
  const updateEntity =
    overrides.updateEntity ??
    vi.fn().mockResolvedValue(v3EntityRecord(ENTITY_ID, { name: "Renamed" }));
  // Every entity response counts its mentions under the caller's ceiling.
  const countEntityMentions = vi.fn().mockResolvedValue({ [ENTITY_ID]: 7 });
  const deps = {
    core: {},
    storage: {
      queryEntities,
      getEntity,
      queryFacts,
      createEntity,
      updateEntity,
      countEntityMentions,
    },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountEntities]);
  return {
    app,
    queryEntities,
    getEntity,
    queryFacts,
    createEntity,
    updateEntity,
    countEntityMentions,
  };
}

describe("mentionCount", () => {
  it("comes from countEntityMentions under the caller's ceiling, not the stored column", async () => {
    const { app, countEntityMentions } = await buildApp();
    const res = await app.request(`/entities/${ENTITY_ID}`, { headers: authed() });
    const body = (await res.json()) as { entity: { mentionCount: number } };
    expect(body.entity.mentionCount).toBe(7);
    expect(countEntityMentions).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      entityIds: [ENTITY_ID],
      maxSensitivity: "internal",
    });
  });
});

describe("Tier A parity: GET /entities/:id", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/entities/${ENTITY_ID}`);
    expect(res.status).toBe(401);
  });

  it("returns 200 with entity+linkedFactCount conforming to entity.schema.json", async () => {
    const entitySchema = loadSchema("entity");
    const { app } = await buildApp();
    const res = await app.request(`/entities/${ENTITY_ID}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity: unknown; linkedFactCount: number };
    const err = validate(body.entity, entitySchema);
    expect(err).toBeNull();
    expect(body.linkedFactCount).toBe(2);
  });

  it("returns 404 when the entity does not exist", async () => {
    const { app } = await buildApp({ getEntity: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/entities/${ENTITY_ID}`, { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("returns 400 on a malformed entity id", async () => {
    const { app } = await buildApp();
    const res = await app.request("/entities/not-a-valid-id", { headers: authed() });
    expect(res.status).toBe(400);
  });

  it("returns 404 (anti-probing, S6) when the entity is above the default ceiling", async () => {
    const { app } = await buildApp({
      getEntity: vi
        .fn()
        .mockResolvedValue(v3EntityRecord(ENTITY_ID, { sensitivity: "restricted" })),
    });
    const res = await app.request(`/entities/${ENTITY_ID}`, { headers: authed() });
    expect(res.status).toBe(404);
  });
});

describe("Tier A parity: GET /entities (list)", () => {
  // No pre-port fixture existed for this route (see file header) — written
  // fresh against `deps.storage.queryEntities` per this PR's launch scope.
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/entities");
    expect(res.status).toBe(401);
  });

  it("returns 200 with items conforming to entity.schema.json", async () => {
    const entitySchema = loadSchema("entity");
    const { app } = await buildApp();
    const res = await app.request("/entities", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBe(1);
    for (const item of body.items) {
      const err = validate(item, entitySchema);
      expect(err).toBeNull();
    }
  });

  it("forwards q + kind + limit to queryEntities", async () => {
    const { app, queryEntities } = await buildApp();
    await app.request("/entities?q=fich&kind=organization&limit=10", { headers: authed() });
    expect(queryEntities).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      kind: "organization",
      q: "fich",
      openOnly: true, // PRIM-16: current entities by default
      limit: 10,
    });
  });

  it("omits above-ceiling entities from the response (sensitivity filter)", async () => {
    const { app } = await buildApp({
      queryEntities: vi.fn().mockResolvedValue({
        items: [v3EntityRecord(ENTITY_ID, { sensitivity: "restricted" })],
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
      }),
    });
    const res = await app.request("/entities", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBe(0);
  });
});

describe("Tier A parity: GET /entities/:id/facts", () => {
  it("returns 200 with facts for the entity", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/entities/${ENTITY_ID}/facts`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { facts: unknown[] };
    expect(Array.isArray(body.facts)).toBe(true);
    expect(body.facts.length).toBe(1);
  });

  it("returns 404 when the entity does not exist", async () => {
    const { app } = await buildApp({ getEntity: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/entities/${ENTITY_ID}/facts`, { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("forwards entityId + status:active + limit to queryFacts", async () => {
    const { app, queryFacts } = await buildApp();
    await app.request(`/entities/${ENTITY_ID}/facts?limit=25`, { headers: authed() });
    expect(queryFacts).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      entityId: ENTITY_ID,
      status: "active",
      // The caller's ceiling (default env ceiling: internal).
      maxSensitivity: "internal",
      limit: 25,
    });
  });
});

describe("Tier A parity: POST /entities", () => {
  it("returns 201 with the created entity conforming to entity.schema.json", async () => {
    const entitySchema = loadSchema("entity");
    const { app } = await buildApp();
    const res = await app.request("/entities", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ name: "New Co", kind: "organization" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as unknown;
    const err = validate(body, entitySchema);
    expect(err).toBeNull();
  });

  it("returns 400 on an invalid body (empty name)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/entities", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ name: "", kind: "organization" }),
    });
    expect(res.status).toBe(400);
  });

  it("forwards name/kind/aliases + provenance to createEntity", async () => {
    const { app, createEntity } = await buildApp();
    await app.request("/entities", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ name: "New Co", kind: "organization", aliases: ["newco"] }),
    });
    expect(createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        name: "New Co",
        kind: "organization",
        aliases: ["newco"],
      })
    );
  });
});

describe("Tier A parity: PATCH /entities/:id", () => {
  it("returns 200 with the updated entity", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/entities/${ENTITY_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("Renamed");
  });

  it("returns 200 and forwards kind to updateEntity (D6.2 — previously silently dropped)", async () => {
    const { app, updateEntity } = await buildApp({
      updateEntity: vi.fn().mockResolvedValue(v3EntityRecord(ENTITY_ID, { kind: "project" })),
    });
    const res = await app.request(`/entities/${ENTITY_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "project" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("project");
    expect(updateEntity).toHaveBeenCalledWith(
      ENTITY_ID,
      expect.objectContaining({ workspaceId: WS_ID, kind: "project" })
    );
  });

  it("returns 400 on an empty patch", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/entities/${ENTITY_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the entity does not exist", async () => {
    const { app } = await buildApp({ getEntity: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/entities/${ENTITY_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when canonicalId equals the entity's own id", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/entities/${ENTITY_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ canonicalId: ENTITY_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when canonicalId target does not exist", async () => {
    const CANONICAL_TARGET_ID = "ment_other00000000000000000";
    const { app } = await buildApp({
      getEntity: vi
        .fn()
        .mockImplementation((entityId: string) =>
          Promise.resolve(entityId === CANONICAL_TARGET_ID ? null : v3EntityRecord(ENTITY_ID))
        ),
    });
    const res = await app.request(`/entities/${ENTITY_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ canonicalId: CANONICAL_TARGET_ID }),
    });
    expect(res.status).toBe(400);
  });
});
