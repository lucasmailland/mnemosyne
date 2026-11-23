/**
 * Tier A parity — `routes/facts.ts`'s SURVIVING handlers (design.md D3, D2
 * step 2): GET /facts/:id, POST /facts/:id/pin, DELETE /facts/purge,
 * DELETE /facts/:id, DELETE /facts/:id/hard, GET /facts (list), PATCH
 * /facts/:id, GET /facts/:id/citations, POST /facts/:id/restore.
 *
 * `POST /facts` (create) is DELETED in this PR (D2 step 2 — its behavior was
 * ported to `POST /remember` in PR7) and is NOT covered here.
 *
 * Originally written and merged green against the legacy
 * `deps.core.{getFact,pinFact,closeFact,hardDeleteFact,purgeClosedFacts,
 * listFacts,patchFact,getFactCitations,restoreFact}` (`CoreLike`)
 * implementation (flatten-legacy-dual-core PR8).
 *
 * flatten-legacy-dual-core PR9a note (D6.1 — T0 reclassification): `GET
 * /facts/:id` and `POST /facts/:id/pin` are PORTED to `deps.storage` by this
 * PR. PR8's "no v3 equivalent" finding was WRONG — legacy never actually
 * persists or reads `tags` (`factory-mappers.ts`'s `rowToFact` hard-codes
 * `tags: []` on every read; `packages/core/src/db/schema/fact.ts` has no
 * `tags` column at all), and legacy `Fact.attribution` is literally
 * `row.metadata ?? {}` — the SAME column as `MnemoFact.metadata`. The port
 * is a wire mapper (`toApiFact()`, `mappers.ts`), not a new port method.
 * `GET /facts` (list), `DELETE /facts/purge`, and `PATCH /facts/:id` STAY on
 * the legacy core client in this PR — out of PR9a's assigned scope
 * (facts.ts remains partially blocked; `GET /facts`/`DELETE /facts/purge`
 * are PR9b's scope per D6.3, and `PATCH /facts/:id` — though
 * `linkedMemoryIds` (D6.2) is now available on `MnemoFact` — was not
 * assigned to this PR and is left for a follow-up so this PR's diff stays
 * scoped to exactly the 5 handlers design.md's PR9a launch scope names).
 *
 * flatten-legacy-dual-core PR15 note (Phase 6c, task 6c.2): `PATCH
 * /facts/:id` is PORTED to `deps.storage.updateFact` by this PR — the
 * `linkedMemoryIds` gap was already fixed by PR9a; this PR is the first to
 * actually port this handler. Required an additive widening of
 * `UpdateFactInput` (`subject`/`kind` — both already physical columns on
 * `MnemoFact`, just never exposed on this port-interface method). DISCLOSED
 * behavior tightening: legacy `patchFact()`'s active-only WHERE guard only
 * applied when `statement` was part of the patch; this port always requires
 * the row to be active, matching `GET /facts/:id`/`POST /facts/:id/pin`'s
 * established active-only guard (PR9a) for consistency across all 3
 * single-fact mutation routes — new tests below cover this (DISCLOSED,
 * same pattern PR9a used when introducing the guard on the other 2 routes).
 * The 3 pre-existing tests below are otherwise UNCHANGED except `buildApp`'s
 * deps-fake wiring (`patchFact` -> the shared `updateFact` mock) and the
 * response now being wire-mapped via `toMemoryFact()` instead of returned
 * raw from the legacy call.
 *
 * DISCLOSED exception to D3's zero-`expect()`-diff rule, for the 2 ported
 * routes only: the response-body VALUES changed (not just wiring) because
 * `toApiFact()` was previously unused, untested-in-production dead code
 * whose `attribution`/`tags` derivation was itself WRONG relative to real
 * legacy behavior (see `mappers.test.ts`'s PR9a note) — fixed as part of
 * wiring it up for the first time. A second, narrower behavior difference:
 * `POST /facts/:id/pin` on a fact mid-consolidation-merge
 * (`__mnemoConsolidationPending`) now returns 404 instead of legacy's
 * 200-with-unchanged-pinned-state, because v3 `updateFact`'s guarded UPDATE
 * returns null (no re-read fallback) where legacy's `pinFact` always
 * re-reads the row regardless of whether its own guarded UPDATE matched.
 * Both are real, disclosed, and match this PR's task instructions verbatim
 * (`updateFact(id, workspaceId, {pinned})` "already carries the same
 * `__mnemoConsolidationPending` guard legacy hand-writes").
 *
 * Scope (see apply-progress.md PR8 "Scope finding: facts.ts" for the full
 * investigation) — `DELETE /facts/:id`, `DELETE /facts/:id/hard`,
 * `GET /facts/:id/citations`, and `POST /facts/:id/restore` were ported to
 * `deps.storage` in PR8:
 *
 *   - `GET /facts` (list) and `DELETE /facts/purge` STAYED on `deps.core`
 *     through PR8/PR9a — v3 `FactFilter`/`queryFacts` had no cursor
 *     pagination, FTS `q`, `sortBy` enum, `scopeRef`, or `status:'all'`
 *     support, and there was no bulk-purge-forgotten v3 method — same class
 *     of port-surface gap PR5 documented for export/graph/citations. PORTED
 *     by PR9b (D6.3, additive `queryFactsPage`/`purgeForgottenFacts`) — see
 *     the PR9b note below.
 *   - `PATCH /facts/:id` stays on `deps.core` — see PR9a note above; not
 *     part of PR9b's scope either (see the PR9b note below).
 *
 * Per D3, the port commit's diff touches ZERO `expect(...)` lines below for
 * the PR8-ported routes' tests (`DELETE /facts/:id`, `DELETE /facts/:id/hard`,
 * `GET /facts/:id/citations`, `POST /facts/:id/restore`) — only `buildApp`'s
 * deps-fake wiring changes.
 *
 * flatten-legacy-dual-core PR9b note (D6.3 — the last item in the 9a-9h D6.6
 * closure sequence to touch `facts.ts`): `GET /facts` (list) and `DELETE
 * /facts/purge` are PORTED to `deps.storage` by this PR — new, ADDITIVE
 * `StorageAdapter.queryFactsPage`/`purgeForgottenFacts` methods (`@mnemo-ai/
 * types`, implemented in `adapter-postgres`'s `FactRepository`), ported 1:1
 * from legacy `CoreLike.listFacts`/`purgeClosedFacts` (factory.ts) — same
 * keyset cursor wire format, same `sortBy`/`order` whitelist, same FTS
 * predicate, same `total`-before-cursor snapshot, same
 * `__mnemoConsolidationPending` purge guard. `queryFacts`/`FactFilter`
 * (the EXISTING offset-paginated method) is left UNTOUCHED — see
 * `FactPageFilter`'s doc comment in `ports.ts`. `PATCH /facts/:id` STAYS on
 * `deps.core` — it was NOT part of D6.3's or this PR's assigned scope (PR9a
 * disclosed it as a deferred gap; still un-ported), so `facts.ts` correctly
 * STAYS on `legacy-core-usage.test.ts`'s allowlist even after this PR.
 *
 * Coverage widened BEFORE the port (written and merged green against legacy
 * `deps.core.listFacts`/`purgeClosedFacts` first, per D3): cursor forwarding,
 * every `sortBy` option, `q` (FTS) forwarding, and the full filter set
 * (`kind`/`scope`/`scopeRef`/`status`/`pinned`/`sensitivity`/`limit`). Real
 * cursor-pagination/FTS/consolidation-pending-skip BEHAVIOR (not just param
 * forwarding) is proven separately by
 * `fact-page-and-purge.integration.test.ts` (Node 22, real Postgres,
 * `adapter-postgres` package).
 *
 * DISCLOSED call-shape difference (same class PR6/PR12 already documented
 * for `getWorkspaceVitals`): legacy `purgeClosedFacts` took an options bag
 * (`{workspaceId}`); `deps.storage.purgeForgottenFacts` takes a positional
 * string. `listFacts`'s DEFAULT mock return switched from the legacy
 * wire-shaped fixture (`memoryFactRecord`, ISO strings) to the v3
 * domain-shaped fixture (`v3FactRecord`, Date fields) that `queryFactsPage`
 * actually returns — the route now wire-maps the response itself via
 * `toMemoryFact()` (the same mapper PR9a's `getEntityFactsRoute` already
 * uses for this exact wire shape). The HTTP-observable response shape is
 * unchanged; only the local mock fixture's TYPE changed.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountFacts } from "../../routes/facts.js";

const PLAINTEXT_KEY = "mns_live_factsparitytest00000001";
const WS_ID = "00000000-0000-0000-0000-000000001101";
const FACT_ID = "fact_1";

async function makeKeyLookup(scopes: string[] = []): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "facts-key-001", keyHash, workspaceId: WS_ID, scopes }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

// v3 MnemoFact fixture (Date fields) for the routes ported to deps.storage.
function v3FactRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    scope: "global" as const,
    statement: "prefers dark mode",
    subject: "user",
    kind: "preference" as const,
    confidence: 1,
    relevance: 1,
    hitCount: 0,
    worthSuccess: 0,
    worthFailure: 0,
    worthAlpha: 1,
    worthBeta: 1,
    worth: 1,
    memoryType: "semantic" as const,
    memoryStrength: 1,
    memoryStability: 1,
    attribution: "user_stated" as const,
    sourceMessageIds: ["msg_1", "msg_2"],
    linkedMemoryIds: [] as string[],
    revisionCount: 1,
    protocolVersion: "v3",
    status: "active" as const,
    pinned: false,
    canonical: false,
    sensitivity: "internal" as const,
    embeddingStale: false,
    validFrom: new Date(NOW),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    metadata: {},
    ...overrides,
  };
}

// buildApp returns individual mock fns by stable local name (not
// `deps.core.X`/`deps.storage.X`) so the port doesn't force `expect(...)`
// edits — same pattern as audit.parity.test.ts / decisions.parity.test.ts.
async function buildApp(
  overrides: Partial<{
    purgeClosedFacts: ReturnType<typeof vi.fn>;
    listFacts: ReturnType<typeof vi.fn>;
    storageGetFact: ReturnType<typeof vi.fn>;
    archiveFact: ReturnType<typeof vi.fn>;
    hardDeleteFact: ReturnType<typeof vi.fn>;
    updateFact: ReturnType<typeof vi.fn>;
  }> = {},
  scopes: string[] = []
) {
  // flatten-legacy-dual-core PR9b: purgeClosedFacts/listFacts now back
  // `deps.storage.purgeForgottenFacts`/`deps.storage.queryFactsPage` (D6.3)
  // instead of the legacy core client — LOCAL VARIABLE NAMES kept unchanged
  // (same "buildApp returns individual mock fns by stable local name"
  // convention this file's header comment already establishes) so the
  // port's diff stays wiring-only wherever the assertion doesn't inspect
  // the response VALUE shape. `listFacts`'s default return switches from
  // the legacy wire-shaped `MemoryFact` (memoryFactRecord, ISO strings) to
  // the v3 domain-shaped `MnemoFact` (v3FactRecord, Date fields) that
  // `queryFactsPage` actually returns — the route now wire-maps via
  // `toMemoryFact()` itself (same mapper PR9a's `getEntityFactsRoute`
  // already uses for this exact wire shape).
  const purgeClosedFacts = overrides.purgeClosedFacts ?? vi.fn().mockResolvedValue(3);
  const listFacts =
    overrides.listFacts ??
    vi.fn().mockResolvedValue({ items: [v3FactRecord(FACT_ID)], nextCursor: null, total: 1 });
  // flatten-legacy-dual-core PR9a: storageGetFact now also backs GET
  // /facts/:id (D6.1 — previously backed only DELETE/:id, DELETE/:id/hard,
  // GET /:id/citations from PR8).
  const storageGetFact =
    overrides.storageGetFact ?? vi.fn().mockResolvedValue(v3FactRecord(FACT_ID));
  const archiveFact = overrides.archiveFact ?? vi.fn().mockResolvedValue(undefined);
  const hardDeleteFact = overrides.hardDeleteFact ?? vi.fn().mockResolvedValue(undefined);
  // flatten-legacy-dual-core PR9a: updateFact now also backs POST
  // /facts/:id/pin (D6.1 — previously backed only POST /:id/restore from
  // PR8). PR15: updateFact ALSO now backs PATCH /facts/:id (task 6c.2).
  // Default return favors restore's status:'active' shape; pin/PATCH tests
  // override explicitly (same pattern restore's 404 test already used).
  const updateFact =
    overrides.updateFact ?? vi.fn().mockResolvedValue(v3FactRecord(FACT_ID, { status: "active" }));
  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
  const deps = {
    storage: {
      getFact: storageGetFact,
      archiveFact,
      hardDeleteFact,
      updateFact,
      queryFactsPage: listFacts,
      purgeForgottenFacts: purgeClosedFacts,
      appendAuditEntry,
      appendOutbox: vi.fn().mockResolvedValue(undefined),
      findHiddenIds: vi.fn().mockResolvedValue([]),
    },
    apiKeys: await makeKeyLookup(scopes),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountFacts]);
  return {
    app,
    purgeClosedFacts,
    listFacts,
    storageGetFact,
    archiveFact,
    hardDeleteFact,
    updateFact,
    appendAuditEntry,
  };
}

describe("Tier A parity: GET /facts/:id", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/facts/${FACT_ID}`);
    expect(res.status).toBe(401);
  });

  it("returns 200 with the legacy simplified Fact shape (content/attribution/tags), derived via toApiFact()", async () => {
    // NOTE: GET /facts/:id returns the legacy simplified `Fact` shape
    // (content/attribution/tags/pinned), which predates and is DISTINCT from
    // `contracts/fact.schema.json` (the v3 `MnemoFact`-derived shape `GET
    // /facts` (list) and `POST /remember` use) — see design.md D2's table.
    // Asserting the fields directly rather than against fact.schema.json,
    // which does not apply to this route. D6.1: `attribution` = metadata,
    // `tags` is always [] (phantom legacy field) — see mappers.ts.
    const { app } = await buildApp();
    const res = await app.request(`/facts/${FACT_ID}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: FACT_ID,
      workspaceId: WS_ID,
      content: "prefers dark mode",
      attribution: {},
      tags: [],
      pinned: false,
      validFrom: NOW,
      validTo: null,
      createdAt: NOW,
      sensitivity: "internal",
      // WP-5 / CLIENTS-20: additive fields, the legacy ones above unchanged.
      kind: "preference",
      subject: "user",
      scopeRef: null,
      confidence: 1,
      topicKey: null,
      episodeId: null,
      status: "active",
      revisionCount: 1,
      hitCount: 0,
    });
  });

  it("returns 404 when the fact does not exist", async () => {
    const { app } = await buildApp({ storageGetFact: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/facts/${FACT_ID}`, { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("returns 404 (anti-probing, S6) when the fact is above the default ceiling", async () => {
    const { app } = await buildApp({
      storageGetFact: vi
        .fn()
        .mockResolvedValue(v3FactRecord(FACT_ID, { sensitivity: "restricted" })),
    });
    const res = await app.request(`/facts/${FACT_ID}`, { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an archived/forgotten fact (validTo set) — matches legacy readFact's active-only filter", async () => {
    // Real regression this PR found and fixed: deps.storage.getFact() is a
    // plain by-id read with no active-only filter (unlike legacy readFact,
    // which explicitly excludes forgotten facts) — conflicts.integration.
    // test.ts's conflict-resolution-loser check depends on this 404.
    const { app } = await buildApp({
      storageGetFact: vi.fn().mockResolvedValue(v3FactRecord(FACT_ID, { validTo: new Date(NOW) })),
    });
    const res = await app.request(`/facts/${FACT_ID}`, { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a forgotten fact (status !== 'active', validTo still null)", async () => {
    const { app } = await buildApp({
      storageGetFact: vi.fn().mockResolvedValue(v3FactRecord(FACT_ID, { status: "forgotten" })),
    });
    const res = await app.request(`/facts/${FACT_ID}`, { headers: authed() });
    expect(res.status).toBe(404);
  });
});

describe("Tier A parity: POST /facts/:id/pin", () => {
  it("returns 200 with the updated (pinned) fact", async () => {
    const { app } = await buildApp({
      updateFact: vi.fn().mockResolvedValue(v3FactRecord(FACT_ID, { pinned: true })),
    });
    const res = await app.request(`/facts/${FACT_ID}/pin`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pinned: boolean };
    expect(body.pinned).toBe(true);
  });

  it("returns 404 when the fact does not exist", async () => {
    const { app } = await buildApp({ updateFact: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/facts/${FACT_ID}/pin`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an archived/forgotten fact (validTo set) — matches legacy readFact's active-only filter", async () => {
    const { app } = await buildApp({
      updateFact: vi
        .fn()
        .mockResolvedValue(v3FactRecord(FACT_ID, { pinned: true, validTo: new Date(NOW) })),
    });
    const res = await app.request(`/facts/${FACT_ID}/pin`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the fact is mid-consolidation (DISCLOSED behavior change — see file header)", async () => {
    // v3 updateFact()'s guarded UPDATE returns null when the
    // __mnemoConsolidationPending predicate excludes the row; legacy
    // pinFact() re-reads unconditionally and returns 200-unchanged instead.
    const { app } = await buildApp({ updateFact: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/facts/${FACT_ID}/pin`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe("Tier A parity: DELETE /facts/:id", () => {
  it("returns 204 on successful soft-delete", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/facts/${FACT_ID}`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).toBe(204);
  });

  it("returns 404 when the fact does not exist", async () => {
    const { app } = await buildApp({ storageGetFact: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/facts/${FACT_ID}`, { method: "DELETE", headers: authed() });
    expect(res.status).toBe(404);
  });

  it("calls archiveFact after the existence check", async () => {
    const { app, archiveFact } = await buildApp();
    await app.request(`/facts/${FACT_ID}`, { method: "DELETE", headers: authed() });
    expect(archiveFact).toHaveBeenCalledWith(FACT_ID, WS_ID);
  });

  // PRIM-3 / CHAOS-8: a concurrent DELETE closed the fact between the
  // pre-check and the archive — the loser is a 404 (like a sequential
  // repeat), not a 500 and not a second audited delete.
  it("returns 404 without an audit entry when archiveFact reports no transition", async () => {
    const { app, appendAuditEntry } = await buildApp({
      archiveFact: vi.fn().mockResolvedValue(false),
    });
    const res = await app.request(`/facts/${FACT_ID}`, { method: "DELETE", headers: authed() });
    expect(res.status).toBe(404);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("Tier A parity: DELETE /facts/:id/hard", () => {
  it("returns 403 without memory:hard_delete scope", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/facts/${FACT_ID}/hard`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).toBe(403);
  });

  it("returns 200 {deleted:true} with memory:hard_delete scope", async () => {
    const { app } = await buildApp({}, ["memory:hard_delete"]);
    const res = await app.request(`/facts/${FACT_ID}/hard`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("returns 404 when the fact does not exist", async () => {
    const { app } = await buildApp({ storageGetFact: vi.fn().mockResolvedValue(null) }, [
      "memory:hard_delete",
    ]);
    const res = await app.request(`/facts/${FACT_ID}/hard`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).toBe(404);
  });
});

describe("Tier A parity: DELETE /facts/purge (ported to deps.storage by PR9b — see file header)", () => {
  it("returns 403 without memory:hard_delete scope", async () => {
    const { app } = await buildApp();
    const res = await app.request("/facts/purge", { method: "DELETE", headers: authed() });
    expect(res.status).toBe(403);
  });

  it("returns 200 {deleted:N} with memory:hard_delete scope", async () => {
    const { app } = await buildApp({}, ["memory:hard_delete"]);
    const res = await app.request("/facts/purge", { method: "DELETE", headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(3);
  });

  // PR9b coverage widening (written pre-port, D6.3): the purge's
  // consolidation-pending skip guard is a real-DB behavior — no `expect()`
  // at this mocked HTTP layer can exercise it. Proven separately by
  // `fact-page-and-purge.integration.test.ts` (Node 22, real Postgres).
  //
  // DISCLOSED call-shape difference (same class PR6/PR12 already
  // documented for `getWorkspaceVitals`): legacy `purgeClosedFacts` took an
  // options bag (`{workspaceId}`); `deps.storage.purgeForgottenFacts` takes
  // a positional string. The HTTP-observable contract (status/body) is
  // unchanged — see the 200/403 tests above.
  it("calls the purge with the caller's workspace id AND a namespaced actor", async () => {
    const { app, purgeClosedFacts } = await buildApp({}, ["memory:hard_delete"]);
    await app.request("/facts/purge", { method: "DELETE", headers: authed() });

    // P114: the second argument is new and load-bearing. This purge appends one
    // mnemo_deletion_log row per deleted fact — the only physical-delete path
    // that used to append nothing — and an audit entry needs an actor. The
    // assertion is on the SHAPE too: `key:<id>`, a namespaced ActorRef from
    // resolveProvenance (S11), never a bare id and never the apiKeyPrefix
    // constant, which names nobody.
    expect(purgeClosedFacts).toHaveBeenCalledWith(WS_ID, expect.stringMatching(/^key:.+/));
  });
});

describe("Tier A parity: GET /facts (list, ported to deps.storage by PR9b — see file header)", () => {
  it("returns 200 with items+nextCursor+total conforming to fact.schema.json", async () => {
    const factSchema = loadSchema("fact");
    const { app } = await buildApp();
    const res = await app.request("/facts", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: null; total: number };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.total).toBe(1);
    for (const item of body.items) {
      const err = validate(item, factSchema);
      expect(err).toBeNull();
    }
  });

  it("returns 400 on an invalid (future) asOf", async () => {
    const { app } = await buildApp();
    const res = await app.request("/facts?asOf=2099-01-01T00%3A00%3A00Z", { headers: authed() });
    expect(res.status).toBe(400);
  });

  // PR9b coverage widening (written pre-port, D6.3): solid coverage of
  // query-param forwarding for cursor pagination, each sortBy option, and
  // the FTS `q` param — the exact shapes D6.3's `FactPageFilter` needs to
  // preserve. Real cursor/FTS/consolidation-pending BEHAVIOR (not just
  // param forwarding) is proven separately by the Node 22 integration test
  // against real Postgres (`fact-page-and-purge.integration.test.ts`).

  it("defaults sortBy to updated_at and order to desc when omitted", async () => {
    const { app, listFacts } = await buildApp();
    await app.request("/facts", { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: "updated_at", order: "desc" })
    );
  });

  it.each(["created_at", "updated_at", "relevance", "hit_count"] as const)(
    "forwards sortBy=%s to the list call",
    async (sortBy) => {
      const { app, listFacts } = await buildApp();
      await app.request(`/facts?sortBy=${sortBy}`, { headers: authed() });
      expect(listFacts).toHaveBeenCalledWith(expect.objectContaining({ sortBy }));
    }
  );

  it("forwards order=asc", async () => {
    const { app, listFacts } = await buildApp();
    await app.request("/facts?order=asc", { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(expect.objectContaining({ order: "asc" }));
  });

  it("forwards a supplied cursor verbatim", async () => {
    const { app, listFacts } = await buildApp();
    const cursor = Buffer.from(JSON.stringify({ v: "x", id: "fact_9" }), "utf8").toString(
      "base64url"
    );
    await app.request(`/facts?cursor=${cursor}`, { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(expect.objectContaining({ cursor }));
  });

  it("forwards the q (FTS) param", async () => {
    const { app, listFacts } = await buildApp();
    await app.request("/facts?q=dark+mode", { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(expect.objectContaining({ q: "dark mode" }));
  });

  it("omits q from the call args when not supplied", async () => {
    const { app, listFacts } = await buildApp();
    await app.request("/facts", { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(expect.not.objectContaining({ q: expect.anything() }));
  });

  it("forwards kind/scope/scopeRef/status/pinned/sensitivity/limit", async () => {
    const { app, listFacts } = await buildApp();
    await app.request(
      "/facts?kind=preference&scope=global&scopeRef=proj-x&status=all&pinned=true&sensitivity=confidential&limit=10",
      { headers: authed() }
    );
    expect(listFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "preference",
        scope: "global",
        scopeRef: "proj-x",
        status: "all",
        pinned: true,
        sensitivity: "confidential",
        limit: 10,
      })
    );
  });

  it("preserves nextCursor and total from the list result", async () => {
    const { app } = await buildApp({
      listFacts: vi
        .fn()
        .mockResolvedValue({ items: [v3FactRecord(FACT_ID)], nextCursor: "cursor_abc", total: 42 }),
    });
    const res = await app.request("/facts", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextCursor: string; total: number };
    expect(body.nextCursor).toBe("cursor_abc");
    expect(body.total).toBe(42);
  });
});

describe("Tier A parity: PATCH /facts/:id (ported to deps.storage.updateFact by PR15 — see file header)", () => {
  it("returns 200 with the patched fact", async () => {
    const { app } = await buildApp({
      updateFact: vi.fn().mockResolvedValue(v3FactRecord(FACT_ID, { subject: "patched" })),
    });
    const res = await app.request(`/facts/${FACT_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ subject: "patched" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subject: string };
    expect(body.subject).toBe("patched");
  });

  it("returns 500 on an empty patch (pre-existing bug, preserved verbatim by this port)", async () => {
    // Discovered pre-port (PR8), NOT introduced or fixed by this port:
    // the handler throws a plain `Error` with a bolted-on `.status = 400`,
    // but `toErrorBody` (errors.ts) only reads `.status` off `HttpError`
    // instances — a plain Error always falls through to the generic 500
    // branch. The doc comment ("Hono renders this as a 400...") is wrong for
    // the CURRENT code. Out of scope for this PR (preserving exact pre-port
    // behavior, not fixing unrelated bugs) — flagged in apply-progress.md
    // PR8 as a real, disclosed finding for a future fix.
    const { app } = await buildApp();
    const res = await app.request(`/facts/${FACT_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
  });

  it("returns 404 when the fact does not exist", async () => {
    const { app } = await buildApp({ updateFact: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/facts/${FACT_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ subject: "x" }),
    });
    expect(res.status).toBe(404);
  });

  // New coverage added by this port (DISCLOSED, same pattern PR9a used when
  // introducing the active-only guard on GET /facts/:id and POST
  // /facts/:id/pin — see file header's PR15 note for why this is stricter
  // than legacy's own statement-only-guarded WHERE clause).
  it("returns 404 for an archived/forgotten fact (validTo set) — new active-only guard added by this port", async () => {
    const { app } = await buildApp({
      updateFact: vi.fn().mockResolvedValue(v3FactRecord(FACT_ID, { validTo: new Date(NOW) })),
    });
    const res = await app.request(`/facts/${FACT_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ subject: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a forgotten fact (status !== 'active', validTo still null) — new active-only guard added by this port", async () => {
    const { app } = await buildApp({
      updateFact: vi.fn().mockResolvedValue(v3FactRecord(FACT_ID, { status: "forgotten" })),
    });
    const res = await app.request(`/facts/${FACT_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ subject: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("forwards subject/kind to updateFact (both additive-widened this PR)", async () => {
    const { app, updateFact } = await buildApp();
    await app.request(`/facts/${FACT_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ subject: "new subject", kind: "trait" }),
    });
    expect(updateFact).toHaveBeenCalledWith(FACT_ID, WS_ID, {
      subject: "new subject",
      kind: "trait",
    });
  });
});

describe("Tier A parity: GET /facts/:id/citations", () => {
  it("returns 200 with factId+sourceMessageIds", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/facts/${FACT_ID}/citations`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { factId: string; sourceMessageIds: string[] };
    expect(body.factId).toBe(FACT_ID);
    expect(body.sourceMessageIds).toEqual(["msg_1", "msg_2"]);
  });

  it("returns 404 when the fact does not exist", async () => {
    const { app } = await buildApp({ storageGetFact: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/facts/${FACT_ID}/citations`, { headers: authed() });
    expect(res.status).toBe(404);
  });
});

describe("Tier A parity: POST /facts/:id/restore", () => {
  it("returns 200 {id, status:'active'}", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/facts/${FACT_ID}/restore`, {
      method: "POST",
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body).toEqual({ id: FACT_ID, status: "active" });
  });

  it("returns 404 when the fact does not exist", async () => {
    // WP-5: restore now reads the fact first (PRIM-14 ceiling check), so
    // "does not exist" is the read returning nothing.
    const { app } = await buildApp({
      storageGetFact: vi.fn().mockResolvedValue(null),
      updateFact: vi.fn().mockResolvedValue(null),
    });
    const res = await app.request(`/facts/${FACT_ID}/restore`, {
      method: "POST",
      headers: authed(),
    });
    expect(res.status).toBe(404);
  });

  it("reopens a forgotten fact through updateFact (which re-embeds it — PRIM-4)", async () => {
    const { app, updateFact } = await buildApp({
      storageGetFact: vi
        .fn()
        .mockResolvedValue(v3FactRecord(FACT_ID, { status: "forgotten", validTo: new Date(NOW) })),
    });
    const res = await app.request(`/facts/${FACT_ID}/restore`, {
      method: "POST",
      headers: authed(),
    });
    expect(res.status).toBe(200);
    expect(updateFact).toHaveBeenCalledWith(FACT_ID, WS_ID, { status: "active", validTo: null });
  });

  it("is a no-op for a fact that is already live (no new revision)", async () => {
    const { app, updateFact } = await buildApp();
    const res = await app.request(`/facts/${FACT_ID}/restore`, {
      method: "POST",
      headers: authed(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: FACT_ID, status: "active" });
    expect(updateFact).not.toHaveBeenCalled();
  });

  it("returns 404 (S6) for a fact above the caller's ceiling", async () => {
    const { app, updateFact } = await buildApp({
      storageGetFact: vi.fn().mockResolvedValue(
        v3FactRecord(FACT_ID, {
          status: "forgotten",
          validTo: new Date(NOW),
          sensitivity: "restricted",
        })
      ),
    });
    const res = await app.request(`/facts/${FACT_ID}/restore`, {
      method: "POST",
      headers: authed(),
    });
    expect(res.status).toBe(404);
    expect(updateFact).not.toHaveBeenCalled();
  });
});

describe("WP-5: the fact read surfaces carry what an agent needs (CLIENTS-20)", () => {
  const rich = () =>
    vi.fn().mockResolvedValue(
      v3FactRecord(FACT_ID, {
        kind: "preference",
        subject: "payments-api",
        scopeRef: "ledgerly",
        confidence: 0.8,
        topicKey: "payments/runtime",
        episodeId: "mepi_1",
        revisionCount: 3,
      })
    );

  it("GET /facts/:id adds kind, subject, scopeRef, confidence, topicKey, episodeId, status, revisionCount", async () => {
    const { app } = await buildApp({ storageGetFact: rich() });
    const res = await app.request(`/facts/${FACT_ID}`, { headers: authed() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      content: "prefers dark mode",
      kind: "preference",
      subject: "payments-api",
      scopeRef: "ledgerly",
      confidence: 0.8,
      topicKey: "payments/runtime",
      episodeId: "mepi_1",
      status: "active",
      revisionCount: 3,
    });
  });

  it("GET /facts items add topicKey, episodeId and revisionCount", async () => {
    const { app } = await buildApp({
      listFacts: vi.fn().mockResolvedValue({
        items: [
          v3FactRecord(FACT_ID, {
            topicKey: "payments/runtime",
            episodeId: "mepi_1",
            revisionCount: 3,
          }),
        ],
        nextCursor: null,
        total: 1,
      }),
    });
    const res = await app.request("/facts", { headers: authed() });
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      topicKey: "payments/runtime",
      episodeId: "mepi_1",
      revisionCount: 3,
    });
  });
});

describe("WP-5: GET /facts list contract (PRIM-8, PRIM-16)", () => {
  it("defaults to current rows: status active with an open interval", async () => {
    const { app, listFacts } = await buildApp();
    await app.request("/facts", { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", currentOnly: true })
    );
  });

  it("includeClosed=true widens the default to the full history", async () => {
    const { app, listFacts } = await buildApp();
    await app.request("/facts?includeClosed=true", { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(expect.objectContaining({ status: "all" }));
    expect(listFacts).toHaveBeenCalledWith(
      expect.not.objectContaining({ currentOnly: expect.anything() })
    );
  });

  it("keeps an explicit status filter working", async () => {
    const { app, listFacts } = await buildApp();
    await app.request("/facts?status=forgotten", { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(expect.objectContaining({ status: "forgotten" }));
    expect(listFacts).toHaveBeenCalledWith(
      expect.not.objectContaining({ currentOnly: expect.anything() })
    );
  });

  it("does not add currentOnly to an asOf snapshot (the interval is the filter)", async () => {
    const { app, listFacts } = await buildApp();
    await app.request("/facts?asOf=2026-01-01T00%3A00%3A00Z", { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(
      expect.not.objectContaining({ currentOnly: expect.anything() })
    );
  });

  it("pushes the caller's ceiling into the list query so total matches the rows", async () => {
    const { app, listFacts } = await buildApp();
    await app.request("/facts", { headers: authed() });
    expect(listFacts).toHaveBeenCalledWith(expect.objectContaining({ maxSensitivity: "internal" }));
  });
});

describe("WP-5: fact mutations respect the ceiling and revision preconditions", () => {
  const restricted = () =>
    vi.fn().mockResolvedValue(v3FactRecord(FACT_ID, { sensitivity: "restricted" }));

  it("PATCH returns 404 without writing for a fact above the ceiling (PRIM-14)", async () => {
    const { app, updateFact } = await buildApp({ storageGetFact: restricted() });
    const res = await app.request(`/facts/${FACT_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ statement: "overwrite" }),
    });
    expect(res.status).toBe(404);
    expect(updateFact).not.toHaveBeenCalled();
  });

  it("pin returns 404 without writing for a fact above the ceiling (PRIM-14)", async () => {
    const { app, updateFact } = await buildApp({ storageGetFact: restricted() });
    const res = await app.request(`/facts/${FACT_ID}/pin`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(404);
    expect(updateFact).not.toHaveBeenCalled();
  });

  it("PATCH forwards expectedRevision (CHAOS-8)", async () => {
    const { app, updateFact } = await buildApp();
    await app.request(`/facts/${FACT_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ statement: "v2", expectedRevision: 1 }),
    });
    expect(updateFact).toHaveBeenCalledWith(FACT_ID, WS_ID, {
      statement: "v2",
      expectedRevision: 1,
    });
  });

  it("PATCH maps a stale expectedRevision to 409 revision_conflict (CHAOS-8)", async () => {
    const { FactRevisionConflictError } = await import("@mnemo-ai/types");
    const { app } = await buildApp({
      updateFact: vi.fn().mockRejectedValue(new FactRevisionConflictError(FACT_ID, 1, 3)),
    });
    const res = await app.request(`/facts/${FACT_ID}`, {
      method: "PATCH",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ statement: "v2", expectedRevision: 1 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe("revision_conflict");
    expect(body.error.details).toMatchObject({ expectedRevision: 1, currentRevision: 3 });
  });
});
