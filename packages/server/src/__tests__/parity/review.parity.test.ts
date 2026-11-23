/**
 * Tier A parity — `routes/review.ts` (design.md D3).
 *
 * HTTP characterization contract for GET /review, GET /review/count,
 * POST /review/:id/resolve, POST /review/enqueue. Written and merged green
 * against the legacy `deps.core.{listReview,reviewCount,resolveReview,
 * enqueueReview}` (`CoreLike`) implementation FIRST (flatten-legacy-dual-core
 * PR10); the port commit in this same PR then swaps the route to
 * `deps.storage`'s new v3 methods (`listActiveLearningReview`,
 * `countUnresolvedActiveLearningReview`, `resolveActiveLearningReview`,
 * `enqueueActiveLearningReview`). Per D3, only `buildApp`'s deps-fake wiring
 * changes — ONE disclosed exception: `countUnresolvedActiveLearningReview`
 * takes a bare `workspaceId: string` (matching the established
 * `getWorkspaceVitals`/`getRecalledFactIds` StorageAdapter convention for
 * single-arg workspace-scoped reads) instead of legacy's `{workspaceId}`
 * object, so that ONE `toHaveBeenCalledWith` assertion changed shape — the
 * observable HTTP contract (200 + `{count}`) is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountReview } from "../../routes/review.js";

const PLAINTEXT_KEY = "mns_live_reviewparitytest00000001";
const WS_ID = "00000000-0000-0000-0000-000000000701";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "review-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

function reviewRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    factId: "fact_1",
    decisionId: null,
    reason: "low_confidence",
    createdAt: NOW,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    ...overrides,
  };
}

async function buildApp(
  overrides: {
    listReview?: ReturnType<typeof vi.fn>;
    reviewCount?: ReturnType<typeof vi.fn>;
    resolveReview?: ReturnType<typeof vi.fn>;
    enqueueReview?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const listReview = overrides.listReview ?? vi.fn().mockResolvedValue([reviewRow("mrev_1")]);
  const reviewCount = overrides.reviewCount ?? vi.fn().mockResolvedValue(1);
  const resolveReview =
    overrides.resolveReview ??
    vi
      .fn()
      .mockResolvedValue({ resolved: true, factId: "fact_1", decisionId: null, cascaded: true });
  const enqueueReview =
    overrides.enqueueReview ?? vi.fn().mockResolvedValue({ id: "mrev_new", inserted: true });

  const deps = {
    storage: {
      listActiveLearningReview: listReview,
      countUnresolvedActiveLearningReview: reviewCount,
      resolveActiveLearningReview: resolveReview,
      enqueueActiveLearningReview: enqueueReview,
      findHiddenIds: vi.fn().mockResolvedValue([]),
      // enqueue reads its target first (a missing or hidden one is a 404).
      getFact: vi.fn(async (id: string) => ({ id, sensitivity: "internal" })),
      getDecision: vi.fn(async (id: string) => ({ id, sensitivity: "internal" })),
    },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountReview]);
  return { app, deps, listReview, reviewCount, resolveReview, enqueueReview };
}

describe("Tier A parity: GET /review", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/review");
    expect(res.status).toBe(401);
  });

  it("returns 200 with items conforming to review.schema.json", async () => {
    const schema = loadSchema("review");
    const { app } = await buildApp();
    const res = await app.request("/review", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      const err = validate(item, schema);
      expect(err).toBeNull();
    }
  });

  it("forwards workspaceId + default limit (50), unresolved-only by default", async () => {
    const { app, listReview } = await buildApp();
    await app.request("/review", { headers: authed() });
    expect(listReview).toHaveBeenCalledWith({ workspaceId: WS_ID, limit: 50 });
  });

  it("forwards reason filter + all=true → includeResolved", async () => {
    const { app, listReview } = await buildApp();
    await app.request("/review?reason=contradiction&all=true&limit=10", { headers: authed() });
    expect(listReview).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      reason: "contradiction",
      includeResolved: true,
      limit: 10,
    });
  });

  it("returns 400 on an invalid reason enum value", async () => {
    const { app } = await buildApp();
    const res = await app.request("/review?reason=nonsense", { headers: authed() });
    expect(res.status).toBe(400);
  });
});

describe("Tier A parity: GET /review/count", () => {
  it("returns 200 with {count}", async () => {
    const { app, reviewCount } = await buildApp({ reviewCount: vi.fn().mockResolvedValue(7) });
    const res = await app.request("/review/count", { headers: authed() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 7 });
    // Disclosed exception (see file header): bare workspaceId, not {workspaceId}.
    expect(reviewCount).toHaveBeenCalledWith(WS_ID);
  });

  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/review/count");
    expect(res.status).toBe(401);
  });
});

describe("Tier A parity: POST /review/:id/resolve", () => {
  const VALID_ID = "mrev_a23bcdef0123456789ghijkl";

  it("returns 200 with resolution + cascaded on success", async () => {
    const { app, resolveReview } = await buildApp();
    const res = await app.request(`/review/${VALID_ID}/resolve`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ resolution: "forgotten" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: VALID_ID,
      resolution: "forgotten",
      factId: "fact_1",
      cascaded: true,
    });
    expect(resolveReview).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        reviewId: VALID_ID,
        resolution: "forgotten",
      })
    );
  });

  it("returns 404 when the row never existed (factId+decisionId both null)", async () => {
    const { app } = await buildApp({
      resolveReview: vi
        .fn()
        .mockResolvedValue({ resolved: false, factId: null, decisionId: null, cascaded: false }),
    });
    const res = await app.request(`/review/${VALID_ID}/resolve`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ resolution: "kept" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the row is already resolved", async () => {
    const { app } = await buildApp({
      resolveReview: vi.fn().mockResolvedValue({
        resolved: false,
        factId: "fact_1",
        decisionId: null,
        cascaded: false,
      }),
    });
    const res = await app.request(`/review/${VALID_ID}/resolve`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ resolution: "kept" }),
    });
    expect(res.status).toBe(409);
  });

  // Every adapter mints review ids as `mrev_<crypto.randomUUID()>` (hyphens
  // included) since the PR10 port; the route must accept what it enqueues.
  it("accepts the mrev_<uuid> id the storage adapters mint", async () => {
    const uuidId = "mrev_0b8c5e3a-6f1d-4c2e-9a7b-3d4e5f6a7b8c";
    const { app } = await buildApp();
    const res = await app.request(`/review/${uuidId}/resolve`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ resolution: "kept" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 on a malformed id", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/review/not-a-valid-id/resolve`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ resolution: "kept" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Tier A parity: POST /review/enqueue", () => {
  it("returns 200 with {id, inserted:true} on a fresh insert", async () => {
    const { app, enqueueReview } = await buildApp();
    const res = await app.request("/review/enqueue", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ factId: "fact_1", reason: "manual" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "mrev_new", inserted: true });
    expect(enqueueReview).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      factId: "fact_1",
      reason: "manual",
    });
  });

  it("returns {inserted:false} on a dedup hit", async () => {
    const { app } = await buildApp({
      enqueueReview: vi.fn().mockResolvedValue({ id: "mrev_existing", inserted: false }),
    });
    const res = await app.request("/review/enqueue", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ decisionId: "dec_1", reason: "contradiction" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "mrev_existing", inserted: false });
  });

  it("returns 400 when both factId and decisionId are supplied", async () => {
    const { app } = await buildApp();
    const res = await app.request("/review/enqueue", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ factId: "fact_1", decisionId: "dec_1", reason: "manual" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither factId nor decisionId is supplied", async () => {
    const { app } = await buildApp();
    const res = await app.request("/review/enqueue", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ reason: "manual" }),
    });
    expect(res.status).toBe(400);
  });
});
