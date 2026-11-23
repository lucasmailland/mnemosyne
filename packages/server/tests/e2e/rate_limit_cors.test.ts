// Tests for CORS, body-limit, and rate-limit middleware (TASK-1002).

import { describe, it, expect, beforeAll } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../../src/app.js";
import type { MnemoCore } from "../../src/deps.js";
import type { ApiKeyLookup } from "../../src/auth.js";
import type { RateLimitBackend } from "../../src/ratelimit.js";

const WS = "00000000-0000-0000-0000-000000000027";
const KEY = "mns_test_ratelimittest000000001";
let keyHash = "";

beforeAll(async () => {
  keyHash = await bcrypt.hash(KEY, 4);
});

// flatten-legacy-dual-core PR8: POST /facts (which wrote via
// core.createFact) was DELETED — POST /remember (deps.cognitive.remember) is
// now this file's write path for exercising CORS/body-limit/rate-limit
// middleware (this file doesn't assert on fact content/identity, only HTTP
// status codes and headers, so a trivial stub is sufficient).
function makeMinimalCognitive(): MnemoCore {
  return {
    remember: async () => ({ id: "mock-id", kind: "fact" as const, staged: false }),
    recall: async () => ({
      hits: [],
      total: 0,
      query: { text: "", limit: 10, offset: 0 },
      latencyMs: 0,
      fromHotTier: false,
    }),
    recallHot: async () => [],
    forget: async () => undefined,
    updateWorth: async () => undefined,
    updateRelationStrength: async () => undefined,
  } as unknown as MnemoCore;
}

function makeKeyLookup(hash: string, ws: string): ApiKeyLookup {
  return {
    async listActive() {
      return [
        {
          id: "key_rl",
          keyHash: hash,
          workspaceId: ws,
          scopes: ["memory:write", "memory:read", "memory:delete"],
        },
      ];
    },
    touch() {
      /* no-op */
    },
  };
}

function makeApp(rlOpts?: { rateLimitBackend?: RateLimitBackend }) {
  const app = createApp({
    deps: {
      cognitive: makeMinimalCognitive(),
      apiKeys: makeKeyLookup(keyHash, WS),
      embedModel: "text-embedding-3-small",
      // Rate limiting is backend-driven (spec §35): the middleware is only
      // mounted when a RateLimitBackend is supplied. Tests inject a fake.
      ...(rlOpts?.rateLimitBackend ? { rateLimitBackend: rlOpts.rateLimitBackend } : {}),
    },
    version: "0.0.0-test",
  });

  async function req(
    method: string,
    path: string,
    extra?: { body?: unknown; headers?: Record<string, string> }
  ) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(extra?.headers ?? {}),
    };
    return app.request(`${path}`, {
      method,
      headers,
      body: extra?.body !== undefined ? JSON.stringify(extra.body) : undefined,
    });
  }

  return { app, req };
}

// ─── CORS ────────────────────────────────────────────────────────────────────

describe("CORS middleware", () => {
  it("OPTIONS preflight returns CORS headers", async () => {
    const { app } = makeApp();
    const res = await app.request("/remember", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("regular request includes CORS response header", async () => {
    const { req } = makeApp();
    const res = await req("POST", "/remember", {
      body: { statement: "cors test", attribution: {}, tags: [] },
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});

// ─── Body limit ──────────────────────────────────────────────────────────────

describe("Body limit middleware", () => {
  it("accepts bodies under 1 MB", async () => {
    const { req } = makeApp();
    const res = await req("POST", "/remember", {
      body: { statement: "small body", attribution: {}, tags: [] },
    });
    expect(res.status).toBe(201);
  });

  it("rejects bodies over 1 MB with 413", async () => {
    const { app } = makeApp();
    const bigPayload = JSON.stringify({
      statement: "x".repeat(1_048_576 + 1),
      attribution: {},
      tags: [],
    });
    const res = await app.request("/remember", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: bigPayload,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("payload_too_large");
  });
});

// ─── Rate limit ──────────────────────────────────────────────────────────────

// In-memory RateLimitBackend double mirroring the RedisRateLimitBackend contract.
// Layer 1 (token bucket): allows the first `tokenLimit` consumeToken calls, then denies.
// Layer 2 (concurrency): denies the slot when `denySlot` is set.
function makeRateLimitBackend(
  opts: { tokenLimit?: number; denySlot?: boolean } = {}
): RateLimitBackend {
  let tokensConsumed = 0;
  let inFlight = 0;
  return {
    healthy: true,
    async consumeToken() {
      tokensConsumed += 1;
      const allowed = opts.tokenLimit === undefined || tokensConsumed <= opts.tokenLimit;
      const remaining =
        opts.tokenLimit === undefined ? 1_000 : Math.max(0, opts.tokenLimit - tokensConsumed);
      return { allowed, remaining, resetSeconds: 60 };
    },
    async acquireSlot() {
      inFlight += 1;
      return { acquired: !opts.denySlot, inFlight };
    },
    async releaseSlot() {
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

describe("Rate limit middleware", () => {
  it("returns 429 + Retry-After + rate_limited when the token bucket is exhausted", async () => {
    // Backend allows the first 2 token consumptions, denies the 3rd (Layer 1).
    const { req } = makeApp({ rateLimitBackend: makeRateLimitBackend({ tokenLimit: 2 }) });

    const r1 = await req("POST", "/remember", {
      body: { statement: "a", attribution: {}, tags: [] },
    });
    const r2 = await req("POST", "/remember", {
      body: { statement: "b", attribution: {}, tags: [] },
    });
    // Third request should be rate-limited.
    const r3 = await req("POST", "/remember", {
      body: { statement: "c", attribution: {}, tags: [] },
    });

    expect([r1.status, r2.status]).toEqual(expect.arrayContaining([201]));
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toBe("60");

    const json = (await r3.json()) as { error: { code: string } };
    expect(json.error.code).toBe("rate_limited");
  });

  it("returns 429 + rate_limited when the concurrency slot is unavailable", async () => {
    // Tokens always available; the concurrency layer (Layer 2) denies the slot.
    const { req } = makeApp({ rateLimitBackend: makeRateLimitBackend({ denySlot: true }) });

    const res = await req("POST", "/remember", {
      body: { statement: "a", attribution: {}, tags: [] },
    });

    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("rate_limited");
  });
});
