/**
 * Tier A parity — `routes/decisions.ts` (design.md D3).
 *
 * HTTP characterization contract for GET/POST /decisions, GET /decisions/:id,
 * PATCH /decisions/:id (supersede). Originally written and merged green
 * against the legacy
 * `deps.core.{listDecisions,getDecision,createDecision,supersedeDecision}`
 * (`CoreLike`) implementation (flatten-legacy-dual-core PR8); the port
 * commit in this same PR swapped the route to `deps.storage`'s v3 methods.
 *
 * Per D3, most of this file's `expect(...)` lines are unchanged by the port
 * — only `buildApp`'s deps-fake wiring changed (`core: {...}` →
 * `storage: {...}`). Two DISCLOSED exceptions (documented inline at each
 * site, matching the precedent `health.parity.test.ts` established for
 * `vitals`/`getWorkspaceVitals`'s calling-convention difference):
 *
 *   1. POST /decisions: the legacy core's single `createDecision()` call did
 *      topic-key upsert + hash dedup INSIDE one helper. v3 splits that into
 *      two separate `StorageAdapter` methods (`mergeDecisionByTopicKey` +
 *      `createDecision`), composed in the route to preserve the exact same
 *      idempotent-by-topic_key HTTP behavior — the internal call shape
 *      genuinely differs, the observable contract does not.
 *   2. PATCH /decisions/:id: legacy `supersedeDecision(oldId, newId)` is one
 *      call returning a found/not-found boolean. v3 has no 1:1 equivalent —
 *      composed via `getDecision` (existence check) + `updateDecision`.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountDecisions } from "../../routes/decisions.js";

const PLAINTEXT_KEY = "mns_live_decisionsparitytest0001";
const WS_ID = "00000000-0000-0000-0000-000000000d01";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "decisions-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

function decisionRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    agentId: null,
    conversationId: null,
    kind: "architecture" as const,
    title: "Use event sourcing",
    body: "Because audit trail matters.",
    topicKey: null,
    revisionCount: 1,
    normalizedHash: "abc123",
    decidedByUserId: null,
    status: "active" as const,
    supersededById: null,
    sensitivity: "internal" as const,
    metadata: {},
    validFrom: NOW,
    validTo: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// buildApp returns the individual mock fns by stable local name (not
// `deps.storage.X`) so future changes to the deps-fake wiring don't force
// `expect(...)` edits — same pattern as audit.parity.test.ts /
// health.parity.test.ts.
async function buildApp(
  overrides: Partial<{
    queryDecisions: ReturnType<typeof vi.fn>;
    getDecision: ReturnType<typeof vi.fn>;
    mergeDecisionByTopicKey: ReturnType<typeof vi.fn>;
    createDecision: ReturnType<typeof vi.fn>;
    updateDecision: ReturnType<typeof vi.fn>;
    supersedeDecision: ReturnType<typeof vi.fn>;
  }> = {}
) {
  const queryDecisions =
    overrides.queryDecisions ??
    vi.fn().mockResolvedValue({
      items: [decisionRecord("dec_1")],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
    });
  const getDecision = overrides.getDecision ?? vi.fn().mockResolvedValue(decisionRecord("dec_1"));
  const mergeDecisionByTopicKey =
    overrides.mergeDecisionByTopicKey ?? vi.fn().mockResolvedValue(null);
  const createDecision =
    overrides.createDecision ?? vi.fn().mockResolvedValue(decisionRecord("dec_new"));
  const updateDecision =
    overrides.updateDecision ?? vi.fn().mockResolvedValue(decisionRecord("dec_1"));
  const supersedeDecision =
    overrides.supersedeDecision ??
    vi
      .fn()
      .mockResolvedValue(
        decisionRecord("dec_1", { status: "superseded", supersededById: "dec_2" })
      );
  const deps = {
    storage: {
      supersedeDecision,
      queryDecisions,
      getDecision,
      mergeDecisionByTopicKey,
      createDecision,
      updateDecision,
    },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountDecisions]);
  return {
    app,
    queryDecisions,
    getDecision,
    mergeDecisionByTopicKey,
    createDecision,
    updateDecision,
    supersedeDecision,
  };
}

describe("Tier A parity: GET /decisions", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/decisions");
    expect(res.status).toBe(401);
  });

  it("returns 200 with items conforming to decision.schema.json", async () => {
    const decisionSchema = loadSchema("decision");
    const { app } = await buildApp();
    const res = await app.request("/decisions", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      const err = validate(item, decisionSchema);
      expect(err).toBeNull();
    }
  });

  it("forwards workspaceId + default limit (50)", async () => {
    const { app, queryDecisions } = await buildApp();
    await app.request("/decisions", { headers: authed() });
    expect(queryDecisions).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      // PRIM-16: current decisions by default.
      status: "active",
      openOnly: true,
      limit: 50,
    });
  });

  it("forwards status + scopeRef + limit query params", async () => {
    const { app, queryDecisions } = await buildApp();
    await app.request("/decisions?status=superseded&scopeRef=project-x&limit=10", {
      headers: authed(),
    });
    expect(queryDecisions).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      status: "superseded",
      scopeRef: "project-x",
      limit: 10,
    });
  });

  it("returns 400 when limit exceeds the max (500)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/decisions?limit=501", { headers: authed() });
    expect(res.status).toBe(400);
  });

  it("returns an empty items array when the store has no matches", async () => {
    const { app } = await buildApp({
      queryDecisions: vi
        .fn()
        .mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50, hasMore: false }),
    });
    const res = await app.request("/decisions", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});

describe("Tier A parity: GET /decisions/:id", () => {
  it("returns 200 with the decision conforming to decision.schema.json", async () => {
    const decisionSchema = loadSchema("decision");
    const { app } = await buildApp();
    const res = await app.request("/decisions/dec_1", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const err = validate(body, decisionSchema);
    expect(err).toBeNull();
  });

  it("returns 404 when the decision does not exist", async () => {
    const { app } = await buildApp({ getDecision: vi.fn().mockResolvedValue(null) });
    const res = await app.request("/decisions/dec_missing", { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("returns 404 (anti-probing, S6) when the decision is above the default ceiling (internal)", async () => {
    const { app } = await buildApp({
      getDecision: vi
        .fn()
        .mockResolvedValue(decisionRecord("dec_1", { sensitivity: "restricted" })),
    });
    const res = await app.request("/decisions/dec_1", { headers: authed() });
    expect(res.status).toBe(404);
  });
});

describe("Tier A parity: POST /decisions", () => {
  it("returns 201 with the created decision", async () => {
    const decisionSchema = loadSchema("decision");
    const { app } = await buildApp();
    const res = await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "architecture", title: "T", body: "B" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as unknown;
    const err = validate(body, decisionSchema);
    expect(err).toBeNull();
  });

  it("returns 400 on an invalid body (missing title)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "architecture", body: "B" }),
    });
    expect(res.status).toBe(400);
  });

  it("without topicKey: forwards scopeRef/decidedByUserId directly to createDecision", async () => {
    // DISCLOSED exception (see file header, item 1): no topicKey means the
    // merge-by-topic-key branch is skipped entirely, so this exercises the
    // plain create path 1:1 against the legacy call shape.
    const { app, createDecision, mergeDecisionByTopicKey } = await buildApp();
    await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({
        kind: "policy",
        title: "T",
        body: "B",
        scopeRef: "project-x",
        decidedByUserId: "user_1",
      }),
    });
    expect(mergeDecisionByTopicKey).not.toHaveBeenCalled();
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        kind: "policy",
        title: "T",
        body: "B",
        scopeRef: "project-x",
        decidedByUserId: "user_1",
      })
    );
  });

  it("with topicKey + no existing active row: tries merge first, falls back to createDecision", async () => {
    // DISCLOSED exception (see file header, item 1).
    const { app, createDecision, mergeDecisionByTopicKey } = await buildApp();
    await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "policy", title: "T", body: "B", topicKey: "infra/pg" }),
    });
    expect(mergeDecisionByTopicKey).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        topicKey: "infra/pg",
        title: "T",
        body: "B",
        kind: "policy",
      })
    );
    expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ topicKey: "infra/pg" }));
  });

  it("with topicKey + an existing active row: merges in place, never calls createDecision", async () => {
    // DISCLOSED exception (see file header, item 1) — this is the
    // idempotent-by-topic_key HTTP behavior the legacy single-call helper
    // also provided ("a duplicate by (workspace_id, topic_key) returns the
    // existing row rather than 409-ing").
    const merged = decisionRecord("dec_existing", { topicKey: "infra/pg", revisionCount: 2 });
    const { app, createDecision, mergeDecisionByTopicKey } = await buildApp({
      mergeDecisionByTopicKey: vi.fn().mockResolvedValue(merged),
    });
    const res = await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "policy", title: "T2", body: "B2", topicKey: "infra/pg" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; revisionCount: number };
    expect(body.id).toBe("dec_existing");
    expect(body.revisionCount).toBe(2);
    expect(mergeDecisionByTopicKey).toHaveBeenCalled();
    expect(createDecision).not.toHaveBeenCalled();
  });
});

describe("Tier A parity: PATCH /decisions/:id (supersede)", () => {
  it("returns 200 with the updated (post-supersede) decision", async () => {
    const decisionSchema = loadSchema("decision");
    const { app } = await buildApp({
      supersedeDecision: vi
        .fn()
        .mockResolvedValue(
          decisionRecord("dec_1", { status: "superseded", supersededById: "dec_2" })
        ),
    });
    const res = await app.request("/decisions/dec_1", {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ supersededById: "dec_2" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; supersededById: string };
    const err = validate(body, decisionSchema);
    expect(err).toBeNull();
    expect(body.status).toBe("superseded");
    expect(body.supersededById).toBe("dec_2");
  });

  it("returns 404 when the decision does not exist", async () => {
    const { app } = await buildApp({ getDecision: vi.fn().mockResolvedValue(null) });
    const res = await app.request("/decisions/dec_missing", { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("returns 404 (anti-probing, S6) when the decision is above the default ceiling (internal)", async () => {
    const { app } = await buildApp({
      getDecision: vi
        .fn()
        .mockResolvedValue(decisionRecord("dec_1", { sensitivity: "restricted" })),
    });
    const res = await app.request("/decisions/dec_1", { headers: authed() });
    expect(res.status).toBe(404);
  });
});

describe("Tier A parity: POST /decisions", () => {
  it("returns 201 with the created decision", async () => {
    const decisionSchema = loadSchema("decision");
    const { app } = await buildApp();
    const res = await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "architecture", title: "T", body: "B" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as unknown;
    const err = validate(body, decisionSchema);
    expect(err).toBeNull();
  });

  it("returns 400 on an invalid body (missing title)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "architecture", body: "B" }),
    });
    expect(res.status).toBe(400);
  });

  it("without topicKey: forwards scopeRef/decidedByUserId directly to createDecision", async () => {
    // DISCLOSED exception (see file header, item 1): no topicKey means the
    // merge-by-topic-key branch is skipped entirely, so this exercises the
    // plain create path 1:1 against the legacy call shape.
    const { app, createDecision, mergeDecisionByTopicKey } = await buildApp();
    await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({
        kind: "policy",
        title: "T",
        body: "B",
        scopeRef: "project-x",
        decidedByUserId: "user_1",
      }),
    });
    expect(mergeDecisionByTopicKey).not.toHaveBeenCalled();
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        kind: "policy",
        title: "T",
        body: "B",
        scopeRef: "project-x",
        decidedByUserId: "user_1",
      })
    );
  });

  it("with topicKey + no existing active row: tries merge first, falls back to createDecision", async () => {
    // DISCLOSED exception (see file header, item 1).
    const { app, createDecision, mergeDecisionByTopicKey } = await buildApp();
    await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "policy", title: "T", body: "B", topicKey: "infra/pg" }),
    });
    expect(mergeDecisionByTopicKey).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        topicKey: "infra/pg",
        title: "T",
        body: "B",
        kind: "policy",
      })
    );
    expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ topicKey: "infra/pg" }));
  });

  it("with topicKey + an existing active row: merges in place, never calls createDecision", async () => {
    // DISCLOSED exception (see file header, item 1) — this is the
    // idempotent-by-topic_key HTTP behavior the legacy single-call helper
    // also provided ("a duplicate by (workspace_id, topic_key) returns the
    // existing row rather than 409-ing").
    const merged = decisionRecord("dec_existing", { topicKey: "infra/pg", revisionCount: 2 });
    const { app, createDecision, mergeDecisionByTopicKey } = await buildApp({
      mergeDecisionByTopicKey: vi.fn().mockResolvedValue(merged),
    });
    const res = await app.request("/decisions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "policy", title: "T2", body: "B2", topicKey: "infra/pg" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; revisionCount: number };
    expect(body.id).toBe("dec_existing");
    expect(body.revisionCount).toBe(2);
    expect(mergeDecisionByTopicKey).toHaveBeenCalled();
    expect(createDecision).not.toHaveBeenCalled();
  });
});

describe("Tier A parity: PATCH /decisions/:id (supersede)", () => {
  it("returns 200 with the updated (post-supersede) decision", async () => {
    const decisionSchema = loadSchema("decision");
    const { app } = await buildApp({
      getDecision: vi
        .fn()
        .mockResolvedValue(
          decisionRecord("dec_1", { status: "superseded", supersededById: "dec_2" })
        ),
    });
    const res = await app.request("/decisions/dec_1", {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ supersededById: "dec_2" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; supersededById: string };
    const err = validate(body, decisionSchema);
    expect(err).toBeNull();
    expect(body.status).toBe("superseded");
    expect(body.supersededById).toBe("dec_2");
  });

  it("returns 404 when the decision does not exist", async () => {
    // DISCLOSED exception (see file header, item 2): the port checks
    // existence via getDecision (not a boolean-returning supersedeDecision
    // call) — mocking getDecision to miss reproduces the same 404.
    const { app } = await buildApp({ getDecision: vi.fn().mockResolvedValue(null) });
    const res = await app.request("/decisions/dec_missing", {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ supersededById: "dec_2" }),
    });
    expect(res.status).toBe(404);
  });

  it("forwards id + supersededById to the atomic supersedeDecision", async () => {
    const { app, supersedeDecision, updateDecision } = await buildApp();
    await app.request("/decisions/dec_1", {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ supersededById: "dec_2" }),
    });
    expect(supersedeDecision).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_ID, id: "dec_1", supersededById: "dec_2" })
    );
    // The two-write dance (status here, pointer there) is gone.
    expect(updateDecision).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing successor and writes nothing", async () => {
    const getDecision = vi
      .fn()
      .mockResolvedValueOnce(decisionRecord("dec_1"))
      .mockResolvedValueOnce(null);
    const { app, supersedeDecision } = await buildApp({ getDecision });
    const res = await app.request("/decisions/dec_1", {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ supersededById: "ghost" }),
    });
    expect(res.status).toBe(404);
    expect(supersedeDecision).not.toHaveBeenCalled();
  });

  it("maps the storage's typed failures: self-supersede 400, conflict 409", async () => {
    const { StorageValidationError, StorageConflictError } = await import("@mnemo-ai/types");
    const supersedeDecision = vi
      .fn()
      .mockRejectedValueOnce(new StorageValidationError("A decision cannot supersede itself"))
      .mockRejectedValueOnce(new StorageConflictError("already superseded by another"));
    const { app } = await buildApp({ supersedeDecision });
    const patch = (supersededById: string) =>
      app.request("/decisions/dec_1", {
        method: "PATCH",
        headers: { ...authed(), "content-type": "application/json" },
        body: JSON.stringify({ supersededById }),
      });
    expect((await patch("dec_1")).status).toBe(400);
    expect((await patch("dec_2")).status).toBe(409);
  });
});
