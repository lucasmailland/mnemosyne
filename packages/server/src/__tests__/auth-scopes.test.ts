/**
 * Unit tests for API key scope enforcement and expiry rejection.
 *
 * Uses Hono's `app.request()` pattern with a stub ApiKeyLookup — no real
 * DB or socket needed. Tests verify:
 *   - Empty scopes → all routes pass (legacy key backward compat)
 *   - Scoped key with memory:read → GET passes, POST /facts gets 403
 *   - Expired key (filtered by listActive) → 401
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcrypt";

import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PLAINTEXT_KEY = "mns_live_scopetestkey000000000001";
const WS_ID = "00000000-0000-0000-0000-000000000013";

/**
 * Build an ApiKeyLookup stub backed by a bcrypt-hashed plaintext key.
 * `scopes`: the scopes to return for the key row.
 * `expired`: if true, the key is filtered out (simulates expires_at in the past).
 */
async function makeKeyLookup(scopes: string[], expired = false): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);

  const activeRows = expired ? [] : [{ id: "key001", keyHash, workspaceId: WS_ID, scopes }];

  return {
    listActive: async () => activeRows,
    findByLookupHash: undefined, // force O(n) path so we avoid needing an HMAC match
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function buildApp(lookup: ApiKeyLookup, rateLimitBackend?: ServerDeps["rateLimitBackend"]) {
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys: lookup,
    rateLimitBackend,
    llm: undefined,
    embedModel: "text-embedding-3-small",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  return createApp({ deps, version: "0.0.0-test" });
}

function authed(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

// This describe block tests the legacy-bypass path: when MNEMO_ALLOW_LEGACY_FULL_SCOPE=true,
// an empty-scope key must pass through (backward-compat migration mode). The default posture
// (deny) is tested implicitly by the other describe blocks which use non-empty scopes and by
// scope-guard-deny.test.ts.
describe("scope enforcement — legacy key (empty scopes)", () => {
  beforeAll(() => {
    vi.stubEnv("MNEMO_ALLOW_LEGACY_FULL_SCOPE", "true");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("GET /facts passes through without scope restriction", async () => {
    const lookup = await makeKeyLookup([]); // empty = legacy full-access
    const app = buildApp(lookup);
    const res = await app.request("/facts", {
      method: "GET",
      headers: authed(),
    });
    // Should reach the route (not 403). Empty body → 200 with items:[].
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("POST /facts passes through without scope restriction", async () => {
    const lookup = await makeKeyLookup([]);
    const app = buildApp(lookup);
    const res = await app.request("/facts", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: "legacy key write", tags: [] }),
    });
    // Should reach the route (not 403/401).
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("DELETE /facts/:id passes through without scope restriction", async () => {
    const lookup = await makeKeyLookup([]);
    const app = buildApp(lookup);
    const res = await app.request("/facts/some-id", {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});

describe("scope enforcement — memory:read scoped key", () => {
  it("GET /facts is allowed (memory:read present)", async () => {
    const lookup = await makeKeyLookup(["memory:read"]);
    const app = buildApp(lookup);
    const res = await app.request("/facts", {
      method: "GET",
      headers: authed(),
    });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("POST /facts gets 403 (memory:write missing)", async () => {
    const lookup = await makeKeyLookup(["memory:read"]);
    const app = buildApp(lookup);
    const res = await app.request("/facts", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: "blocked write", tags: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /facts/:id gets 403 (memory:delete missing)", async () => {
    const lookup = await makeKeyLookup(["memory:read"]);
    const app = buildApp(lookup);
    const res = await app.request("/facts/some-id", {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).toBe(403);
  });

  it("POST /recall is allowed (memory:read covers recall)", async () => {
    const lookup = await makeKeyLookup(["memory:read"]);
    const app = buildApp(lookup);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "test" }),
    });
    // recall needs an embed/LLM — it may 500/501, but NOT 403/401.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});

describe("validation error envelope", () => {
  it("preserves the limiter's Retry-After delay", async () => {
    const lookup = await makeKeyLookup(["memory:read"]);
    const backend = {
      healthy: true,
      consumeToken: async () => ({ allowed: false, remaining: 0, resetSeconds: 7 }),
      acquireSlot: async () => ({ acquired: true, inFlight: 1 }),
      releaseSlot: async () => {},
    };
    const res = await buildApp(lookup, backend).request("/facts", { headers: authed() });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(await res.json()).toMatchObject({
      error: { code: "rate_limited", retryable: true, retryAfterSeconds: 7 },
    });
  });
  it("returns a canonical 400 for malformed JSON", async () => {
    const lookup = await makeKeyLookup(["memory:write"]);
    const res = await buildApp(lookup).request("/remember", {
      method: "POST",
      headers: authed(),
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request", retryable: false } });
  });

  it("returns a canonical 400 for an empty JSON body", async () => {
    const lookup = await makeKeyLookup(["memory:write"]);
    const res = await buildApp(lookup).request("/remember", {
      method: "POST",
      headers: authed(),
      body: "",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { retryable: false } });
  });

  it("returns a canonical 413 for an oversized body", async () => {
    const lookup = await makeKeyLookup(["memory:write"]);
    const res = await buildApp(lookup).request("/remember", {
      method: "POST",
      headers: authed(),
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { code: "payload_too_large", retryable: false },
    });
  });
  it("returns field issues for an invalid remember request before persistence", async () => {
    const lookup = await makeKeyLookup(["memory:write"]);
    const app = buildApp(lookup);
    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean; details: { issues: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "statement" })])
    );
  });
});

describe("scope enforcement — memory:write scoped key", () => {
  it("POST /facts is allowed (memory:write present)", async () => {
    const lookup = await makeKeyLookup(["memory:write"]);
    const app = buildApp(lookup);
    const res = await app.request("/facts", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: "scoped write", tags: [] }),
    });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("GET /facts gets 403 (memory:read missing)", async () => {
    const lookup = await makeKeyLookup(["memory:write"]);
    const app = buildApp(lookup);
    const res = await app.request("/facts", {
      method: "GET",
      headers: authed(),
    });
    expect(res.status).toBe(403);
  });
});

describe("scope enforcement — full scopes", () => {
  it("all methods allowed when scopes include read + write + delete", async () => {
    const lookup = await makeKeyLookup(["memory:read", "memory:write", "memory:delete"]);
    const app = buildApp(lookup);

    const getRes = await app.request("/facts", {
      method: "GET",
      headers: authed(),
    });
    expect(getRes.status).not.toBe(403);

    const postRes = await app.request("/facts", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: "full access write", tags: [] }),
    });
    expect(postRes.status).not.toBe(403);

    const delRes = await app.request("/facts/some-id", {
      method: "DELETE",
      headers: authed(),
    });
    expect(delRes.status).not.toBe(403);
  });
});

describe("expired key rejection", () => {
  it("returns 401 when the key is expired (filtered from listActive)", async () => {
    // When expires_at is in the past, the SQL query filters the row out.
    // We simulate this by returning an empty array from listActive().
    const lookup = await makeKeyLookup([], /* expired = */ true);
    const app = buildApp(lookup);
    const res = await app.request("/facts", {
      method: "GET",
      headers: authed(),
    });
    // No matching key → 401
    expect(res.status).toBe(401);
  });

  it("returns 401 for a scoped expired key on write paths too", async () => {
    const lookup = await makeKeyLookup(["memory:write"], /* expired = */ true);
    const app = buildApp(lookup);
    const res = await app.request("/facts", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: "should fail", tags: [] }),
    });
    expect(res.status).toBe(401);
  });
});
