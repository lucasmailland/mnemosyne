/**
 * P28: Cross-transport self_edit counter integration test.
 *
 * Proves that POST /self/edit (HTTP) and the selfEdit RPC (gRPC) share the same
 * RDD-7 per-day strengthen budget when both transports are wired to the same
 * in-memory cache instance.
 *
 * No production code changes. No real Redis, DB, or auth.
 *
 * Spec: sdd/p28-cross-transport-selfedit/spec
 * Design: sdd/p28-cross-transport-selfedit/design
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRouterTransport, createClient, Code } from "@connectrpc/connect";
import bcrypt from "bcrypt";

import type { CacheAdapter, CacheCapabilities, HealthStatus } from "@mnemo-ai/types";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountSelf } from "../../routes/self.js";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createMnemosyneRoutes, createAuthInterceptor } from "../../grpc.js";
import { selfEditStrengthensKey } from "../../selfedit-counters.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Single source for both transports. */
const WS = "11111111-1111-1111-1111-111111111111";
/** The crux: HTTP body.agentId and gRPC API-key mock id must be identical. */
const AGENT = "shared-agent";
const TOKEN = "mns_live_abcdefghijklmnopqrstu";

// ─── Shared in-memory cache (superset of makeFakeCache from self-edit-budget.test.ts) ─

function makeSharedCache(): CacheAdapter & { store: Map<string, number | unknown> } {
  const store = new Map<string, number | unknown>();
  const cache: CacheAdapter & { store: typeof store } = {
    id: "shared-fake-cache",
    store,
    capabilities: {
      sortedSets: false,
      pubSub: false,
      patterns: false,
      atomic: true, // incrWithTtl is atomic
      hashes: false,
    } satisfies CacheCapabilities,
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown, _opts?: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async deletePattern(_pattern: string): Promise<number> {
      return 0;
    },
    async incrWithTtl(key: string, _ttlSeconds: number): Promise<number> {
      const prev = (store.get(key) as number) ?? 0;
      const next = prev + 1;
      store.set(key, next);
      return next;
    },
    async healthCheck(): Promise<HealthStatus> {
      return { status: "ok", latencyMs: 1 };
    },
    async close(): Promise<void> {},
  };
  return cache;
}

// ─── Storage stub — strengthen only calls updateWorth ─────────────────────────

function makeStorageStub() {
  return {
    // P123: the target must EXIST before any self-edit branch acts on it. This
    // stub omitted `getFact` and the test passed anyway — it was strengthening
    // a fact that was not there, which is the behaviour the fix removed.
    getFact: vi.fn().mockResolvedValue({
      id: "fact_1",
      workspaceId: WS,
      statement: "un hecho que existe",
      status: "active",
      validTo: undefined,
    }),
    getStrategy: vi.fn().mockResolvedValue(null),
    updateWorth: vi.fn().mockResolvedValue(undefined),
    appendOutbox: vi.fn().mockResolvedValue(undefined),
    // p50-audit-log-emitters (PR7): applySelfEdit now unconditionally emits a
    // self_edit audit entry via ctx.storage.appendAuditEntry when req.provenance
    // is present — both transports here always resolve and pass it.
    appendAuditEntry: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Cooldown helper — wipe §13 lastEdit keys between calls ──────────────────

function clearCooldown(store: Map<string, number | unknown>): void {
  for (const k of [...store.keys()]) {
    if (k.startsWith("mnemo:selfedit:lastedit:")) store.delete(k);
  }
}

// ─── HTTP app builder (mirrors self-edit-budget.test.ts) ──────────────────────

function makeApp(storage: ReturnType<typeof makeStorageStub>, cache: CacheAdapter) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c: any, next: any) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    // WP-5 (PRIM-6): budgets are keyed by the AUTHENTICATED actor, so the
    // HTTP request must authenticate as the same key the gRPC mock returns.
    c.set("actorId", AGENT);
    c.set("actorType", "user");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage,
    cache,
    core: {} as unknown,
    embedModel: "text-embedding-3-small",
  } as unknown as ServerDeps;

  mountSelf(app, fakeDeps);

  app.onError((err: any, c: any) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  const request = (url: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(url, init));
  return { request };
}

// ─── gRPC deps + client builder (mirrors grpc-selfedit-caps.test.ts) ──────────

async function authedDeps(keyHash: string, overrides: Partial<ServerDeps>): Promise<ServerDeps> {
  const apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    touch: vi.fn(),
    findByLookupHash: vi.fn().mockResolvedValue({
      id: AGENT,
      keyHash,
      workspaceId: WS,
      scopes: ["memory:self_edit"],
      plan: "free",
    }),
  };
  return { apiKeys, ...overrides } as unknown as ServerDeps;
}

function makeClient(deps: ServerDeps) {
  const transport = createRouterTransport((r) => createMnemosyneRoutes(r, deps), {
    router: { interceptors: [createAuthInterceptor(deps)] },
  });
  const client = createClient(MnemosyneService, transport);
  return { client, headers: { authorization: `Bearer ${TOKEN}` } };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("P28 — cross-transport self_edit strengthen budget", () => {
  let keyHash: string;
  let cache: ReturnType<typeof makeSharedCache>;
  let storage: ReturnType<typeof makeStorageStub>;
  let request: (url: string, init?: RequestInit) => Promise<Response>;
  let client: ReturnType<typeof makeClient>["client"];
  let headers: Record<string, string>;

  beforeAll(async () => {
    // bcrypt at cost 12 (same as grpc-selfedit-caps.test.ts) — ~300ms, accepted.
    keyHash = await bcrypt.hash(TOKEN, 12);

    // One shared cache instance wired into BOTH transports.
    cache = makeSharedCache();
    storage = makeStorageStub();

    // gRPC transport — API-key mock returns actorId = AGENT.
    const deps = await authedDeps(keyHash, { cache: cache as never, storage: storage as never });
    ({ client, headers } = makeClient(deps));

    // HTTP transport — fake-auth middleware sets workspaceId = WS (no API-key lookup).
    ({ request } = makeApp(storage, cache));
  });

  beforeEach(() => {
    clearCooldown(cache.store);
  });

  it("shares strengthen budget across HTTP and gRPC (maxStrengthensPerDay=3)", async () => {
    // ── Step 1: HTTP strengthen fact-1 ─────────────────────────────────────
    clearCooldown(cache.store);
    const res1 = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "strengthen",
        target: "fact-1",
        reason: "cross-transport test 1",
        sessionId: "sess-test",
        agentId: AGENT,
      }),
    });
    expect(res1.status, "HTTP strengthen #1 should succeed").toBe(200);
    const body1 = await res1.json();
    expect(body1.applied, "HTTP strengthen #1 applied should be true").toBe(true);

    // ── Step 2: HTTP strengthen fact-2 ─────────────────────────────────────
    clearCooldown(cache.store);
    const res2 = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "strengthen",
        target: "fact-2",
        reason: "cross-transport test 2",
        sessionId: "sess-test",
        agentId: AGENT,
      }),
    });
    expect(res2.status, "HTTP strengthen #2 should succeed").toBe(200);
    const body2 = await res2.json();
    expect(body2.applied, "HTTP strengthen #2 applied should be true").toBe(true);

    // ── Step 3: gRPC strengthen fact-3 ─────────────────────────────────────
    clearCooldown(cache.store);
    const res3 = await client.selfEdit(
      { action: "strengthen", targetId: "fact-3", reason: "cross-transport test 3" },
      { headers }
    );
    expect(res3.applied, "gRPC strengthen #3 applied should be true").toBe(true);

    // ── Anti-vacuous assertion: all 3 ops hit ONE shared key ────────────────
    // Proves WS + AGENT alignment held — no separate per-transport buckets.
    expect(
      cache.store.get(selfEditStrengthensKey(WS, `key:${AGENT}`)),
      "shared strengthen counter must be exactly 3 after 2 HTTP + 1 gRPC"
    ).toBe(3);

    // ── Step 4: HTTP strengthen fact-4 → 429 (budget exhausted) ───────────
    clearCooldown(cache.store);
    const res4 = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "strengthen",
        target: "fact-4",
        reason: "cross-transport test 4 — should be blocked",
        sessionId: "sess-test",
        agentId: AGENT,
      }),
    });
    expect(res4.status, "HTTP strengthen #4 should be blocked (429)").toBe(429);

    // ── Step 5: gRPC strengthen fact-5 → PermissionDenied (budget exhausted) ─
    clearCooldown(cache.store);
    await expect(
      client.selfEdit(
        {
          action: "strengthen",
          targetId: "fact-5",
          reason: "cross-transport test 5 — should be blocked",
        },
        { headers }
      )
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
  });
});
