/**
 * Unit tests for sensitivity ceiling on GET /facts routes (P0.2).
 *
 * These tests verify the anti-probing pattern:
 *   - Facts with sensitivity above the caller's ceiling return 404 (not 403).
 *   - Facts at or below the ceiling return 200.
 *   - Facts with no sensitivity field default to "internal" (always visible).
 *
 * We mount only the facts sub-router on a minimal Hono app with a
 * pre-seeded auth middleware (no real bcrypt/DB) so the suite is fast
 * and hermetic.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MnemoFact } from "@mnemo-ai/types";

import type { AuthVariables } from "../../auth.js";
import { toErrorBody } from "../../errors.js";
import { mountFacts } from "../../routes/facts.js";

// ── Fake auth middleware ───────────────────────────────────────────────────────
// Bypasses bcrypt/DB — just stamps the context variables the routes read.

function withFakeAuth(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  workspaceId = "ws_test"
): void {
  app.use("*", async (c, next) => {
    c.set("workspaceId", workspaceId);
    c.set("apiKeyPrefix", "mns_live_");
    await next();
  });
}

// ── Fact fixture helpers ───────────────────────────────────────────────────────

// flatten-legacy-dual-core PR9a: GET /facts/:id now reads from
// `deps.storage.getFact` (a v3 MnemoFact) instead of `deps.core.getFact`
// (the legacy simplified `Fact` shape) — fixture switched to match.
// `toApiFact()` (routes/facts.ts) derives the wire response from this.
function makeV3Fact(overrides: Partial<MnemoFact> = {}): MnemoFact {
  return {
    id: "fact_test_1",
    workspaceId: "ws_test",
    scope: "global",
    statement: "The deploy runs at 2am.",
    subject: "deploy",
    kind: "other",
    confidence: 0.9,
    relevance: 0.8,
    hitCount: 0,
    worthSuccess: 0,
    worthFailure: 0,
    worthAlpha: 2,
    worthBeta: 2,
    worth: 0.5,
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    attribution: "inferred",
    sourceMessageIds: [],
    linkedMemoryIds: [],
    revisionCount: 0,
    protocolVersion: "3.0",
    status: "active",
    pinned: false,
    canonical: false,
    sensitivity: "internal",
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    embeddingStale: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

// flatten-legacy-dual-core PR9b: GET /facts (list) ported off
// `deps.core.listFacts` onto `deps.storage.queryFactsPage` (D6.3) —
// `queryFactsPage` returns domain-shaped `MnemoFact[]` (Date fields), not
// the wire-shaped `MemoryFact` (ISO strings) legacy `listFacts` returned.
// The route now wire-maps via `toMemoryFact()` itself.
type FactPage = { items: MnemoFact[]; nextCursor: string | null; total: number };

// ── Minimal CoreLike/StorageAdapter fake ────────────────────────────────────────

// flatten-legacy-dual-core PR9a: GET /facts/:id ported to
// `deps.storage.getFact(id, workspaceId)`.
type GetFactFn = (id: string, workspaceId: string) => Promise<MnemoFact | null>;
type QueryFactsPageFn = (args: Record<string, unknown>) => Promise<FactPage>;

function buildApp(getFact: GetFactFn, queryFactsPage: QueryFactsPageFn) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  // Error handler so NotFoundError is rendered correctly.
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  withFakeAuth(app);

  // Minimal CoreLike — only the methods the facts route calls.
  const core = {
    // stubs for other CoreLike methods used by other routes
    createFact: vi.fn(),
    closeFact: vi.fn(),
    patchFact: vi.fn(),
    getFactCitations: vi.fn(),
    restoreFact: vi.fn(),
  } as unknown as Parameters<typeof mountFacts>[1]["core"];

  const storage = {
    getFact,
    queryFactsPage,
  } as unknown as Parameters<typeof mountFacts>[1]["storage"];

  const deps = {
    core,
    storage,
    apiKeys: { listActive: vi.fn(), touch: vi.fn() },
    embedModel: "text-embedding-3-small",
  } as unknown as Parameters<typeof mountFacts>[1];

  mountFacts(app, deps);
  return app;
}

// ── GET /facts/:id ─────────────────────────────────────────────────────────

describe("GET /facts/:id — sensitivity ceiling", () => {
  // Default MNEMO_SENSITIVITY_CEILING is unset → resolves to "internal".

  beforeEach(() => {
    delete process.env.MNEMO_SENSITIVITY_CEILING;
  });

  it("returns 200 for a fact with sensitivity: 'internal' (at ceiling)", async () => {
    const fact = makeV3Fact({ sensitivity: "internal" });
    const app = buildApp(async () => fact, vi.fn());

    const res = await app.request("/facts/fact_test_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("fact_test_1");
  });

  it("returns 200 for a fact with sensitivity: 'public' (below ceiling)", async () => {
    const fact = makeV3Fact({ sensitivity: "public" });
    const app = buildApp(async () => fact, vi.fn());

    const res = await app.request("/facts/fact_test_1");
    expect(res.status).toBe(200);
  });

  it("returns 200 for a fact with no sensitivity field (defaults to internal)", async () => {
    const fact = makeV3Fact(); // no sensitivity field
    const app = buildApp(async () => fact, vi.fn());

    const res = await app.request("/facts/fact_test_1");
    expect(res.status).toBe(200);
  });

  it("returns 404 for a fact with sensitivity: 'confidential' (above internal ceiling)", async () => {
    const fact = makeV3Fact({ sensitivity: "confidential" });
    const app = buildApp(async () => fact, vi.fn());

    const res = await app.request("/facts/fact_test_1");
    // Anti-probing: must be 404, not 403 — never confirm the resource exists.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("returns 404 for a fact with sensitivity: 'restricted' (above internal ceiling)", async () => {
    const fact = makeV3Fact({ sensitivity: "restricted" });
    const app = buildApp(async () => fact, vi.fn());

    const res = await app.request("/facts/fact_test_1");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the fact does not exist (storage returns null)", async () => {
    const app = buildApp(async () => null, vi.fn());

    const res = await app.request("/facts/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 200 for a restricted fact when ceiling is raised to 'restricted' via env", async () => {
    process.env.MNEMO_SENSITIVITY_CEILING = "restricted";
    const fact = makeV3Fact({ sensitivity: "restricted" });
    const app = buildApp(async () => fact, vi.fn());

    const res = await app.request("/facts/fact_test_1");
    expect(res.status).toBe(200);
    delete process.env.MNEMO_SENSITIVITY_CEILING;
  });
});

// ── GET /facts — list sensitivity filter ───────────────────────────────────

describe("GET /facts — sensitivity ceiling", () => {
  beforeEach(() => {
    delete process.env.MNEMO_SENSITIVITY_CEILING;
  });

  // flatten-legacy-dual-core PR9b: `queryFactsPage` returns domain-shaped
  // `MnemoFact[]` (Date fields) — `sensitivity` is non-optional on
  // `MnemoFact` (unlike the legacy wire `MemoryFact.sensitivity?`), so
  // "f_none" now models the fixture's own default (`makeV3Fact`'s
  // `sensitivity: "internal"`) rather than a genuinely-absent field — same
  // observable behavior (visible at the default ceiling), different reason.
  const baseListResult = (): FactPage => ({
    items: [
      makeV3Fact({ id: "f_pub", sensitivity: "public" }),
      makeV3Fact({ id: "f_int", sensitivity: "internal" }),
      makeV3Fact({ id: "f_conf", sensitivity: "confidential" }),
      makeV3Fact({ id: "f_rest", sensitivity: "restricted" }),
      makeV3Fact({ id: "f_none" }), // uses the fixture default (internal)
    ],
    nextCursor: null,
    total: 5,
  });

  it("filters out confidential and restricted items for default (internal) ceiling", async () => {
    const app = buildApp(vi.fn(), async () => baseListResult());

    const res = await app.request("/facts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain("f_pub");
    expect(ids).toContain("f_int");
    expect(ids).toContain("f_none"); // defaults to internal → visible
    expect(ids).not.toContain("f_conf");
    expect(ids).not.toContain("f_rest");
  });

  it("shows all items when ceiling is 'restricted'", async () => {
    process.env.MNEMO_SENSITIVITY_CEILING = "restricted";
    const app = buildApp(vi.fn(), async () => baseListResult());

    const res = await app.request("/facts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain("f_pub");
    expect(ids).toContain("f_int");
    expect(ids).toContain("f_conf");
    expect(ids).toContain("f_rest");
    expect(ids).toContain("f_none");
    delete process.env.MNEMO_SENSITIVITY_CEILING;
  });

  it("returns only public items when ceiling is 'public'", async () => {
    process.env.MNEMO_SENSITIVITY_CEILING = "public";
    const app = buildApp(vi.fn(), async () => baseListResult());

    const res = await app.request("/facts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    const ids = body.items.map((i) => i.id);
    expect(ids).toEqual(["f_pub"]);
    delete process.env.MNEMO_SENSITIVITY_CEILING;
  });

  it("preserves nextCursor and total from the storage result", async () => {
    const app = buildApp(vi.fn(), async () => ({
      items: [makeV3Fact({ id: "f_pub", sensitivity: "public" })],
      nextCursor: "cursor_abc",
      total: 42,
    }));

    const res = await app.request("/facts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextCursor: string; total: number };
    // nextCursor and total flow through unchanged
    expect(body.nextCursor).toBe("cursor_abc");
    expect(body.total).toBe(42);
  });
});
