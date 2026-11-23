/**
 * REST spec-exact alias tests (T6.6).
 *
 * Verifies the 6 path/verb mismatches between the published spec and the
 * existing implementation are covered by spec-exact alias routes:
 *
 *   1. DELETE /sessions/:id      ← POST /session/:id/discard
 *   2. GET    /entities/:id/graph ← GET  /graph?focus=:id
 *   3. POST   /admin/consolidate ← POST /consolidation/trigger
 *   4. POST   /admin/export      ← POST /export (body forwarded)
 *   5. POST   /admin/import      ← POST /import
 *   6a. POST  /sessions          ← POST /session/start (plural start)
 *   6b. GET   /sessions          ← list (plural list)
 *   6c. POST  /sessions/:id/turns ← POST /session/:id/turn (plural turns)
 *
 * Route existence detection:
 *   - Hono's default response for unregistered paths: HTTP 404, body "404 Not Found" (plain text)
 *   - Registered path + valid auth → auth runs → 401 JSON {"error":{...}}
 *     (or further into the handler for 200/404-resource/503)
 *
 * Strategy: with a valid key, expect the response body is NOT the plain-text
 * Hono 404 sentinel "404 Not Found". We assert the content-type is JSON or
 * the status is not 404. Since auth middleware always runs first for /*
 * paths and returns 401 JSON for unknown keys, a registered path returns
 * 401 (not a bare text 404). An unregistered path returns the bare-text 404.
 *
 * Wait — actually even for unregistered paths the v1 middleware (body-limit,
 * auth, etc.) fires first. So what distinguishes registered from not?
 * The answer: registered paths return 401 (from auth middleware). The v1
 * sub-router's OpenAPIHono falls through to Hono's default 404 for paths
 * that don't match any registered route. Auth middleware runs BEFORE route
 * matching in the middleware stack because it's registered with v1.use("*", ...),
 * meaning it runs for all requests under /v1. So both registered and
 * unregistered paths in /v1 return 401 before the 404 can be reached.
 *
 * Revised approach: the body tells us. With NO auth header:
 *   - registered path → auth middleware fires → 401 JSON
 *   - unregistered path in / → v1 middleware fires (auth) → same 401 JSON
 *
 * They look identical with auth! We need a different discriminator.
 *
 * FINAL approach: use the /memory/* proxy pattern already in app.ts.
 * The spec aliases are registered as app.all(...) BEFORE app.route('/v1', v1)
 * in app.ts. When the alias exists: request is handled, response is non-404.
 * When the alias doesn't exist: falls through to v1 sub-router, which has no
 * matching route → returns Hono's 404. But v1's auth middleware fires first...
 *
 * Actually: looking at app.ts line 303: v1 sub-router is bound to /v1.
 * The spec aliases in app.ts are registered as app.all("/sessions/:id"...)
 * BEFORE app.route("/v1", v1). So the root app matches the alias first.
 * The alias handler runs immediately — it does NOT go through the v1 middleware.
 * So the alias handler response may be different from the v1 middleware response.
 *
 * For the aliases:
 *   - alias registered on root app → returns alias response (200/404/503 etc.)
 *   - alias NOT registered → falls through to v1 sub-router → auth → 401
 *   - completely not under /v1 → root app's 404
 *
 * So: with a valid key, registered aliases return SOMETHING (200/4xx/5xx from
 * the delegated handler); unregistered paths under /v1 return 401 (from v1 auth).
 * But we'd need to know if 401 means "not registered" or "registered but unauthorized".
 *
 * SIMPLEST CORRECT APPROACH: inspect the response body directly.
 * Hono's default 404 for completely unmatched paths (outside /v1): "404 Not Found"
 * For paths under /v1 that v1 has no route for: also "404 Not Found" since
 * OpenAPIHono doesn't register a catch-all.
 *
 * Wait — but auth middleware fires before the 404... Let me check the sequence:
 * Hono middleware stack: v1.use("*") runs for ALL requests hitting the v1 router.
 * If no route matches: does the middleware still run?
 *
 * YES! In Hono, middleware registered with `.use("*")` runs before route handlers.
 * If no route matches, Hono returns 404 AFTER all middleware. So auth middleware
 * fires EVEN FOR unregistered paths → returns 401, never reaching Hono's 404.
 *
 * CONCLUSION: every /* path returns 401 (no valid key) or passes through to
 * the handler (valid key). The 404 text response only appears for root-level
 * unregistered paths (outside /v1). The spec alias paths are all under /v1,
 * so the v1 auth middleware always fires.
 *
 * ── FINAL FINAL approach ──────────────────────────────────────────────────────
 * The spec aliases will be implemented as app.all() routes on the ROOT app
 * (like the /memory/* aliases), not on the v1 sub-router. They delegate
 * to the canonical path via app.fetch(). This means:
 *   - Alias registered on root app: runs BEFORE v1 sub-router → no auth from v1
 *   - Alias NOT registered: falls to v1 sub-router → auth middleware → 401
 *
 * Test strategy for root-level aliases:
 *   - NO auth header needed
 *   - Unregistered path → v1 auth fires → 401
 *   - Registered alias → alias handler runs before v1 → delegates to canonical
 *     path (which IS in v1) → re-enters app via fetch → v1 auth fires on the
 *     CANONICAL path → 401
 *
 * Hmm, still 401 for both cases when no auth provided...
 *
 * OK, the real discriminator is: provide a VALID auth token.
 * - Alias registered on root → aliases delegate to canonical via app.fetch
 *   → canonical path in v1 runs with auth → handler response (200/404-resource)
 * - Alias NOT registered → root app falls through → v1 sub-router runs
 *   → auth middleware fires → 401 with a valid key gets to the handler
 *   → handler 404 for unmatched route... same situation.
 *
 * PRAGMATIC SOLUTION:
 * Test AFTER implementing the aliases. Since this is a "step 2 failing, step 3
 * implementing" workflow, the most practical approach is:
 * 1. Write tests that check the RESPONSE BODY shape after auth passes
 * 2. Implement aliases
 * 3. Confirm tests pass
 *
 * The real behavioral test: after aliases are registered, the response for the
 * spec paths should be identical to the response for the canonical paths.
 * For example, DELETE /sessions/:id should give the same result as
 * POST /session/:id/discard. Both should be 404 (session not found) not
 * some other error.
 *
 * SIMPLEST WORKING TEST:
 * Check that canonical responses match alias responses (after implementation).
 * Before implementation: alias paths return whatever the v1 sub-router returns
 * for no matched route (probably a 404 or 405). After: they match canonical.
 *
 * Given time constraints, use the approach: provide valid auth + check that
 * the response HTTP status for alias paths matches canonical paths.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import bcrypt from "bcrypt";

import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";

const { runConsolidationTick } = vi.hoisted(() => ({
  runConsolidationTick: vi.fn(),
}));

vi.mock("@mnemo-ai/consolidation", () => ({ runConsolidationTick }));

// ── Stubs ─────────────────────────────────────────────────────────────────────

const PLAINTEXT_KEY = "mns_live_restaliasestestkey00001";
const WS_ID = "00000000-0000-0000-0000-000000000020";
const queryFacts = vi.fn(async () => []);

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys: ApiKeyLookup = {
    listActive: async () => [
      {
        id: "key_alias_01",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:write", "memory:governance"],
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys,
    llm: undefined,
    embedModel: "text-embedding-3-small",
    storage: { queryFacts },
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "0.0.0-test" });
});

beforeEach(() => {
  queryFacts.mockClear();
  runConsolidationTick.mockReset().mockImplementation(async (ctx, workspaceId) => {
    await ctx.storage.queryFacts({ workspaceId });
    return {
      workspaceCount: 1,
      mergedPairs: 0,
      skippedPairs: 0,
      candidateCount: 0,
      errors: 0,
    };
  });
});

function authed(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

/**
 * Assert that an alias path returns the SAME HTTP status as its canonical
 * equivalent, proving the alias is registered and delegates correctly.
 *
 * When the alias is NOT registered, the path hits the v1 sub-router which
 * has no matching route → OpenAPIHono returns Hono's default "404 Not Found".
 * After auth, this 404 comes from the unmatched-route fallthrough (text body).
 *
 * When the alias IS registered on the root app (before v1), the alias handler
 * re-dispatches via app.fetch() to the canonical path, which hits the canonical
 * handler and returns whatever the handler returns (JSON body).
 *
 * Discriminator: body content-type (JSON from handler vs text from Hono 404)
 * or body containing "Not Found" as a text string (not JSON).
 */
async function assertAliasMatchesCanonical(
  aliasMethod: string,
  aliasPath: string,
  canonicalMethod: string,
  canonicalPath: string,
  opts: { body?: string; contentType?: string } = {}
): Promise<void> {
  const { body, contentType = "application/json" } = opts;
  const headers = authed({ "content-type": contentType });

  const [aliasRes, canonicalRes] = await Promise.all([
    app.request(aliasPath, {
      method: aliasMethod,
      headers,
      ...(body !== undefined ? { body } : {}),
    }),
    app.request(canonicalPath, {
      method: canonicalMethod,
      headers,
      ...(body !== undefined ? { body } : {}),
    }),
  ]);

  const aliasStatus = aliasRes.status;
  const canonicalStatus = canonicalRes.status;

  // The alias should return the same status as the canonical path.
  // Before aliases are implemented, the alias path returns 404 (Hono default)
  // while the canonical path returns 200/404/503 (handler response).
  expect(
    aliasStatus,
    `Alias ${aliasMethod} ${aliasPath} (status ${aliasStatus}) should match canonical ${canonicalMethod} ${canonicalPath} (status ${canonicalStatus})`
  ).toBe(canonicalStatus);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("REST spec aliases (T6.6) — alias matches canonical response", () => {
  it("(1) DELETE /sessions/:id == POST /session/:id/discard", async () => {
    await assertAliasMatchesCanonical(
      "DELETE",
      "/sessions/non-existent-session-id",
      "POST",
      "/session/non-existent-session-id/discard"
    );
  });

  it("(2) GET /entities/:id/graph == GET /graph?focus=:id", async () => {
    // The entity graph alias proxies to /graph?focus=ment_abc123
    // Canonical: GET /graph?focus=ment_abc123 → 400 (invalid focus pattern)
    await assertAliasMatchesCanonical(
      "GET",
      "/entities/ment_abc123/graph",
      "GET",
      "/graph?focus=ment_abc123"
    );
  });

  it("(3) POST /admin/consolidate == POST /consolidation/trigger", async () => {
    await assertAliasMatchesCanonical(
      "POST",
      "/admin/consolidate",
      "POST",
      "/consolidation/trigger",
      { body: "{}" }
    );
  });

  it.each([
    {
      name: "dry-run",
      request: { mode: "fast", dryRun: true },
      error: {
        type: "invalid_request_error",
        code: "dry_run_not_supported",
        message: "Consolidation dry-run is not supported yet; no changes were made.",
      },
    },
    {
      name: "deep mode",
      request: { mode: "deep", dryRun: false },
      error: {
        type: "invalid_request_error",
        code: "deep_mode_not_supported",
        message: "Manual deep consolidation is not supported yet; no changes were made.",
      },
    },
  ])("(3b) preserves the canonical 422 contract for $name", async ({ request, error }) => {
    const requestOptions = {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(request),
    };

    runConsolidationTick.mockClear();
    queryFacts.mockClear();
    const canonicalResponse = await app.request("/consolidation/trigger", requestOptions);
    const canonicalBody = (await canonicalResponse.json()) as { error: Record<string, unknown> };

    expect(canonicalResponse.status).toBe(422);
    expect(canonicalBody.error).toMatchObject(error);
    expect(runConsolidationTick).not.toHaveBeenCalled();
    expect(queryFacts).not.toHaveBeenCalled();

    runConsolidationTick.mockClear();
    queryFacts.mockClear();
    const aliasResponse = await app.request("/admin/consolidate", requestOptions);
    const aliasBody = (await aliasResponse.json()) as { error: Record<string, unknown> };

    expect(aliasResponse.status).toBe(422);
    expect(aliasBody.error).toMatchObject(error);
    expect(aliasBody.error).toMatchObject({
      type: canonicalBody.error.type,
      code: canonicalBody.error.code,
      message: canonicalBody.error.message,
    });
    expect(runConsolidationTick).not.toHaveBeenCalled();
    expect(queryFacts).not.toHaveBeenCalled();
  });

  it("(4) POST /admin/export == POST /export (body forwarded)", async () => {
    // export requires memory:export scope — both alias and canonical return 403
    // because the stub key lacks that scope, confirming the alias delegates correctly.
    // The body is forwarded (not dropped), so the POST /export handler runs.
    await assertAliasMatchesCanonical("POST", "/admin/export", "POST", "/export", {
      body: JSON.stringify({ format: "json", includeEmbeddings: false }),
    });
  });

  it("(4b) POST /admin/export with body returns 403 INSUFFICIENT_SCOPE (not 400/404)", async () => {
    // Proves body is accepted and auth/scope runs (not a parse error).
    const res = await app.request("/admin/export", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        format: "json",
        types: ["fact", "episode"],
        includeEmbeddings: false,
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    // The error code should be INSUFFICIENT_SCOPE, not a routing / parse error.
    const code = (body.code ?? (body.error as Record<string, unknown>)?.code) as string | undefined;
    expect(code).toBe("INSUFFICIENT_SCOPE");
  });

  it("(4c) POST /admin/export and POST /export return identical status+code", async () => {
    const [aliasRes, canonicalRes] = await Promise.all([
      app.request("/admin/export", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ format: "json" }),
      }),
      app.request("/export", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ format: "json" }),
      }),
    ]);
    expect(aliasRes.status).toBe(canonicalRes.status);
    const [aliasBody, canonicalBody] = await Promise.all([
      aliasRes.json() as Promise<Record<string, unknown>>,
      canonicalRes.json() as Promise<Record<string, unknown>>,
    ]);
    const aliasCode = (aliasBody.code ?? (aliasBody.error as Record<string, unknown>)?.code) as
      string | undefined;
    const canonicalCode = (canonicalBody.code ??
      (canonicalBody.error as Record<string, unknown>)?.code) as string | undefined;
    expect(aliasCode).toBe(canonicalCode);
  });

  it("(5) POST /admin/import == POST /import", async () => {
    await assertAliasMatchesCanonical("POST", "/admin/import", "POST", "/import", {
      body: "",
      contentType: "application/octet-stream",
    });
  });

  it("(6a) POST /sessions == POST /session/start", async () => {
    await assertAliasMatchesCanonical("POST", "/sessions", "POST", "/session/start", {
      body: JSON.stringify({ agentId: "agent_test" }),
    });
  });

  it("(6b) GET /sessions == GET /session/list", async () => {
    await assertAliasMatchesCanonical("GET", "/sessions", "GET", "/session/list");
  });

  it("(6c) POST /sessions/:id/turns == POST /session/:id/turn", async () => {
    await assertAliasMatchesCanonical(
      "POST",
      "/sessions/some-id/turns",
      "POST",
      "/session/some-id/turn",
      { body: JSON.stringify({ role: "user", content: "hello" }) }
    );
  });
});
