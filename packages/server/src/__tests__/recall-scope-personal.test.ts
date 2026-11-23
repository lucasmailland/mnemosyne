/**
 * B1 — `scope: 'personal'` actually filters POST /recall results
 * (docs/archive/openspec/complete-mcp-tools spec.md Requirement 1, tasks.md Phase 1).
 *
 * Today `recall.ts` explicitly excludes `"personal"` from the `filter` object
 * ("personal" is a routing directive, handled via workspaceId") but never
 * performs that routing — the query silently runs unfiltered against the
 * base workspace. These tests are RED against that behavior and GREEN once
 * `multiLevelRecall(..., { only: "personal" })` + the route's 400 parity
 * with `POST /remember` (routes/remember.ts:282-305) are wired in.
 *
 * Design note (docs/archive/openspec/complete-mcp-tools/design.md, B1): the route itself
 * enforces the two 400s (key not user-bound / no personal workspace) BEFORE
 * calling multiLevelRecall — "error parity with remember, never a silent
 * empty result". The lower-level `multiLevelRecall({ only: "personal" })`
 * primitive is defensive and returns an empty result (never throws) when
 * given no resolvable personal workspace, matching spec.md Requirement 1
 * Scenario 3's "returns zero hits, not an error" wording for the primitive
 * itself. Both are exercised below at their respective layers.
 *
 * No `vi.mock` of `../recall/multi-level.js` is used here — the real
 * `getUserPersonalWorkspaceId`/`multiLevelRecall` implementations run
 * end-to-end against a hand-rolled fake `postgres.Sql` (`makeFakeSql`),
 * because `multiLevelRecall`'s internal call to `getUserPersonalWorkspaceId`
 * is a same-module function reference that a `vi.mock` of the module's
 * external export surface would not intercept.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallHit } from "@mnemo-ai/types";
import { multiLevelRecall } from "../recall/multi-level.js";

const PLAINTEXT_KEY = "mns_live_scopepersonaltest00000001";
const WS_ID = "00000000-0000-0000-0000-cc0000000001";
const PERSONAL_WS_ID = "00000000-0000-0000-0000-cc0000000002";
const USER_ID = "user-scope-personal-test-001";
const PERSONAL_TENANT_ID = "tenant-personal-scope-personal-001";

// ── Fake postgres.Sql — mirrors the two queries getUserPersonalWorkspaceId
//    issues inside its sql.begin(...) transaction. ──────────────────────────
function makeFakeSql(opts: { personalTenantId?: string | null; personalWsId?: string | null }) {
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("set_config")) return Promise.resolve([]);
    if (text.includes("mnemo_user")) {
      return Promise.resolve(
        opts.personalTenantId ? [{ personal_tenant_id: opts.personalTenantId }] : []
      );
    }
    if (text.includes("mnemo_workspace")) {
      return Promise.resolve(opts.personalWsId ? [{ id: opts.personalWsId }] : []);
    }
    return Promise.resolve([]);
  };
  return {
    begin: async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as ServerDeps["metricsPgClient"];
}

function makeHit(overrides: Partial<RecallHit> & { id: string }): RecallHit {
  return {
    primitive: "fact",
    content: `content for ${overrides.id}`,
    score: 0.9,
    sensitivity: "public",
    injectionScore: 0,
    provenance: "user_stated",
    origin: "local",
    contested: false,
    validFrom: new Date("2026-08-01T00:00:00Z"),
    validTo: null,
    tags: [],
    relations: [],
    ...overrides,
  } as unknown as RecallHit;
}

async function makeKeyLookup(opts: { userId?: string | null }): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key-scope-personal",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:read", "memory:admin"],
        maxSensitivity: "restricted",
        userId: opts.userId ?? null,
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" };
}

function makeCoreDeps() {
  return { recall: async () => [] } as unknown as ServerDeps["core"];
}

describe("POST /recall — scope: 'personal' (B1)", () => {
  it("returns only personal-workspace facts, never the base-workspace ones", async () => {
    const recall = vi.fn(async (query: { workspaceId: string }) => {
      if (query.workspaceId === PERSONAL_WS_ID) {
        return {
          hits: [makeHit({ id: "personal-fact-1", score: 0.75, scopeOwner: `user:${USER_ID}` })],
          total: 1,
          query: { text: "q", limit: 10, offset: 0 },
          latencyMs: 1,
          fromHotTier: false,
        };
      }
      // Base-workspace call — must never be reached/merged for scope:'personal'.
      return {
        hits: [makeHit({ id: "workspace-fact-1", score: 0.99 })],
        total: 1,
        query: { text: "q", limit: 10, offset: 0 },
        latencyMs: 1,
        fromHotTier: false,
      };
    });
    const cognitive = { recall } as unknown as ServerDeps["cognitive"];

    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup({ userId: USER_ID }),
      cognitive,
      metricsPgClient: makeFakeSql({
        personalTenantId: PERSONAL_TENANT_ID,
        personalWsId: PERSONAL_WS_ID,
      }),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "auth module", topK: 5, scope: "personal" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string; score: number }> };
    expect(body.hits.map((h) => h.id)).toEqual(["personal-fact-1"]);
    // B1.2: single personal level merges at weight 1.0, not 0.8 — score unchanged.
    expect(body.hits[0]!.score).toBe(0.75);

    // Never called against the base workspace when only:"personal" is active.
    const calledWorkspaceIds = recall.mock.calls.map(
      (c) => (c[0] as { workspaceId: string }).workspaceId
    );
    expect(calledWorkspaceIds).not.toContain(WS_ID);
    expect(calledWorkspaceIds).toEqual([PERSONAL_WS_ID]);
  });

  it("omitting scope leaves current unfiltered behavior byte-identical", async () => {
    const recall = vi.fn(async () => ({
      hits: [makeHit({ id: "workspace-fact-1", score: 0.5 })],
      total: 1,
      query: { text: "q", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    }));
    const cognitive = { recall } as unknown as ServerDeps["cognitive"];

    // No userId/tenantId on the key — exercises the direct cognitive.recall
    // path (multiLevelRecall is never invoked), untouched by this fix.
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup({ userId: null }),
      cognitive,
      metricsPgClient: undefined,
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "auth module", topK: 5 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string; score: number }> };
    expect(body.hits.map((h) => h.id)).toEqual(["workspace-fact-1"]);
    expect(body.hits[0]!.score).toBe(0.5);
    // Third arg: the route records the observation itself, so core is told to
    // skip only its own (recall observability).
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_ID }),
      expect.anything(),
      { deferObservation: true, onRecallMeta: expect.any(Function) }
    );
  });

  it("key not user-bound → 400 with the remember.ts-matching message, never empty 200", async () => {
    const recall = vi.fn();
    const cognitive = { recall } as unknown as ServerDeps["cognitive"];

    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup({ userId: null }),
      cognitive,
      metricsPgClient: makeFakeSql({}),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "auth module", topK: 5, scope: "personal" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe(
      "scope 'personal' requires a user-bound key (userId must be set on the API key)"
    );
    expect(recall).not.toHaveBeenCalled();
  });

  it("no personal workspace configured → 400 with the remember.ts-matching message, not empty results", async () => {
    const recall = vi.fn();
    const cognitive = { recall } as unknown as ServerDeps["cognitive"];

    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup({ userId: USER_ID }),
      cognitive,
      // No personal_tenant_id row → getUserPersonalWorkspaceId resolves null.
      metricsPgClient: makeFakeSql({ personalTenantId: null }),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "auth module", topK: 5, scope: "personal" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe(
      "No personal workspace found for this user. Register a user profile first."
    );
    expect(recall).not.toHaveBeenCalled();
  });
});

describe("multiLevelRecall({ only: 'personal' }) — direct unit coverage", () => {
  it("no resolvable personal workspace → empty result, not a throw/500", async () => {
    const cognitive = {
      recall: vi.fn(),
    } as unknown as import("../deps.js").MnemoCore;

    const result = await multiLevelRecall(
      { workspaceId: WS_ID, text: "q", limit: 10 },
      USER_ID,
      null,
      {
        sql: makeFakeSql({ personalTenantId: null }) as unknown as import("postgres").Sql,
        cognitive,
        auth: {
          workspaceId: WS_ID,
          actorId: "key:test",
          actorType: "agent",
          scopes: [],
        } as unknown as import("@mnemo-ai/types").AuthContext,
      },
      { only: "personal" }
    );

    expect(result.hits).toEqual([]);
    expect(result.total).toBe(0);
    expect(cognitive.recall).not.toHaveBeenCalled();
  });

  it("no userId → empty result, not a throw/500", async () => {
    const cognitive = {
      recall: vi.fn(),
    } as unknown as import("../deps.js").MnemoCore;

    const result = await multiLevelRecall(
      { workspaceId: WS_ID, text: "q", limit: 10 },
      null,
      null,
      {
        sql: makeFakeSql({}) as unknown as import("postgres").Sql,
        cognitive,
        auth: {
          workspaceId: WS_ID,
          actorId: "key:test",
          actorType: "agent",
          scopes: [],
        } as unknown as import("@mnemo-ai/types").AuthContext,
      },
      { only: "personal" }
    );

    expect(result.hits).toEqual([]);
    expect(cognitive.recall).not.toHaveBeenCalled();
  });
});

describe("RECALL-6 / AGENTSIM-9 — personal-only recall filters ownership before ranking", () => {
  const AUTH = {
    workspaceId: WS_ID,
    actorId: "key:test",
    actorType: "agent",
    scopes: [],
  } as unknown as import("@mnemo-ai/types").AuthContext;

  it("asks core for the user's own memories, so the page is filled with them", async () => {
    const recall = vi.fn(async () => ({
      hits: [makeHit({ id: "mine", scopeOwner: `user:${USER_ID}` })],
      total: 1,
      query: { text: "q", limit: 1, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    }));

    await multiLevelRecall(
      { workspaceId: WS_ID, text: "what laptop do I use", limit: 1, filter: { scopeRef: "me" } },
      USER_ID,
      null,
      {
        sql: makeFakeSql({
          personalTenantId: PERSONAL_TENANT_ID,
          personalWsId: WS_ID,
        }) as unknown as import("postgres").Sql,
        cognitive: { recall } as unknown as import("../deps.js").MnemoCore,
        auth: AUTH,
      },
      { only: "personal" }
    );

    // The personal workspace IS the active one here — a freshly provisioned
    // user's case. Without the filter in the query, workspace memories ranked
    // first and the limit cut the personal fact off before anyone filtered.
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        filter: { scopeRef: "me", scopeOwner: `user:${USER_ID}` },
      }),
      expect.anything(),
      // Children skip only the core observation; the route records it.
      { deferObservation: true, onRecallMeta: expect.any(Function) }
    );
  });

  it("drops hits with no ownership label — nobody's personal memory", async () => {
    const recall = vi.fn(async () => ({
      hits: [
        makeHit({ id: "legacy" }),
        makeHit({ id: "workspace", scopeOwner: `workspace:${WS_ID}` }),
        makeHit({ id: "mine", scopeOwner: `user:${USER_ID}` }),
      ],
      total: 3,
      query: { text: "q", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    }));

    const result = await multiLevelRecall(
      { workspaceId: WS_ID, text: "q", limit: 10 },
      USER_ID,
      null,
      {
        sql: makeFakeSql({
          personalTenantId: PERSONAL_TENANT_ID,
          personalWsId: PERSONAL_WS_ID,
        }) as unknown as import("postgres").Sql,
        cognitive: { recall } as unknown as import("../deps.js").MnemoCore,
        auth: AUTH,
      },
      { only: "personal" }
    );

    expect(result.hits.map((h) => h.id)).toEqual(["mine"]);
  });
});

describe("WP-3 review — nothingRelevant is judged after each level's ownership filter", () => {
  const AUTH = {
    workspaceId: WS_ID,
    actorId: "key:test",
    actorType: "agent",
    scopes: [],
  } as unknown as import("@mnemo-ai/types").AuthContext;
  const response = (hits: RecallHit[], nothingRelevant: boolean) => ({
    hits,
    total: hits.length,
    query: { text: "q", limit: 10, offset: 0 },
    latencyMs: 1,
    fromHotTier: false,
    nothingRelevant,
    debug: {
      modeRequested: "auto",
      modeUsed: "auto",
      tiersConsulted: ["auto", "cold"],
      cacheHit: false,
      fallback: false,
      relevanceFloor: 0.5,
    },
  });

  it("blended: a relevant hit dropped for its owner does not vouch for the weak ones kept", async () => {
    const recall = vi.fn(async (query: { workspaceId: string }) =>
      query.workspaceId === PERSONAL_WS_ID
        ? response(
            [
              makeHit({ id: "someone-elses", scopeOwner: "workspace:x", similarity: 0.9 }),
              makeHit({ id: "mine-weak", scopeOwner: `user:${USER_ID}`, similarity: 0.2 }),
            ],
            false
          )
        : response([makeHit({ id: "workspace-weak", similarity: 0.3 })], true)
    );

    const result = await multiLevelRecall(
      { workspaceId: WS_ID, text: "q", limit: 10 },
      USER_ID,
      null,
      {
        sql: makeFakeSql({
          personalTenantId: PERSONAL_TENANT_ID,
          personalWsId: PERSONAL_WS_ID,
        }) as unknown as import("postgres").Sql,
        cognitive: { recall } as unknown as import("../deps.js").MnemoCore,
        auth: AUTH,
      }
    );

    expect(result.hits.map((h) => h.id).sort()).toEqual(["mine-weak", "workspace-weak"]);
    expect(result.nothingRelevant).toBe(true);
  });

  it("personal-only: the same rule", async () => {
    const recall = vi.fn(async () =>
      response(
        [
          makeHit({ id: "unlabelled", similarity: 0.9 }),
          makeHit({ id: "mine-weak", scopeOwner: `user:${USER_ID}`, similarity: 0.2 }),
        ],
        false
      )
    );

    const result = await multiLevelRecall(
      { workspaceId: WS_ID, text: "q", limit: 10 },
      USER_ID,
      null,
      {
        sql: makeFakeSql({
          personalTenantId: PERSONAL_TENANT_ID,
          personalWsId: PERSONAL_WS_ID,
        }) as unknown as import("postgres").Sql,
        cognitive: { recall } as unknown as import("../deps.js").MnemoCore,
        auth: AUTH,
      },
      { only: "personal" }
    );

    expect(result.hits.map((h) => h.id)).toEqual(["mine-weak"]);
    expect(result.nothingRelevant).toBe(true);
  });
});
