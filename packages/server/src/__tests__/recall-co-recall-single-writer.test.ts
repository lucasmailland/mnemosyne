/**
 * p60-corecall-stdp-convergence (design.md D4) — cross-layer regression test
 * for the co-recall STDP single-writer invariant.
 *
 * Before this change, `POST /recall` applied Hebbian co-recall STDP to
 * `mnemo_relation` rows TWICE per request, from two layers that did not know
 * about each other: core's `recordCoRecall` (capped at 6, canonical sorted-id
 * ordering, create-or-strengthen) and the server's `recordCoRecallStdpForHits`
 * (uncapped, hit-rank ordering, strengthen-only, no primitive filter). That
 * produced double-counted STDP for some pairs and silently missed strengthens
 * for others (proposal.md).
 *
 * This file has no direct unit coverage of its own subject module — it exists
 * ONLY to prove the cross-layer invariant that neither suite (core's
 * `co-recall.test.ts` nor a hypothetical server-side unit test) can prove in
 * isolation: exactly one writer fires, exactly once per qualifying pair, per
 * `POST /recall` request.
 *
 * Part A: the server layer contributes zero co-recall writes (fails if a
 *   second writer is ever reintroduced at the route layer).
 * Part B: core's REAL `recordCoRecall` (imported from `@mnemo-ai/core`, not a
 *   reimplemented fixture) fires exactly once per qualifying pair.
 * D5 scope: multi-level recall never forms cross-workspace pairs — each
 *   level's co-recall pass is scoped to the workspace it actually queried.
 * D2 regression: the sibling `recordHyperedgeCoActivation` setImmediate,
 *   which shares the call site, still fires in the same request.
 * Non-fact hits: an episode hit produces zero relations and zero STDP calls.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallHit, RecallQuery, RecallResponse, AuthContext } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { makeMockCognitive } from "./helpers/mockCognitive.js";
import { recordCoRecall, CO_RECALL_TOP_K } from "@mnemo-ai/core";
import { multiLevelRecall } from "../recall/multi-level.js";

const WS_ID = "00000000-0000-0000-0000-ee0000000001";
const PERSONAL_WS_ID = "00000000-0000-0000-0000-ee0000000002";
const PLAINTEXT_KEY = "mns_live_corecallsinglewriter00001";

/** Number of unordered pairs among k items — C(k,2). */
function pairCount(k: number): number {
  return (k * (k - 1)) / 2;
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

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key-co-recall-single-writer",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:read", "memory:admin"],
        maxSensitivity: "restricted",
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

/** The (now-deleted) server writer was fired via `setImmediate` — flush the macrotask queue. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe("POST /recall — co-recall STDP single-writer invariant (p60)", () => {
  describe("Part A — the server layer contributes zero co-recall writes", () => {
    it("never calls recordCoRecallStdp even when hits are already related in the graph", async () => {
      const storage = new InMemoryStorageAdapter();
      const factIds = Array.from({ length: 8 }, (_, i) => `fact-${i}`);
      // Pre-relate every adjacent pair, forward direction, matching hit-rank
      // order — exactly the shape the old (now-deleted) server writer's
      // ordered i<j, forward-only `getRelations` lookup would have found.
      for (let i = 0; i < factIds.length - 1; i++) {
        await storage.createRelation({
          workspaceId: WS_ID,
          sourceId: factIds[i]!,
          sourceType: "fact",
          targetId: factIds[i + 1]!,
          targetType: "fact",
          verb: "related",
        });
      }
      const recordSpy = vi.spyOn(storage, "recordCoRecallStdp");

      const recall = vi.fn().mockResolvedValue({
        hits: factIds.map((id) => makeHit({ id })),
        total: factIds.length,
        query: { text: "q", limit: 10, offset: 0 },
        latencyMs: 1,
        fromHotTier: false,
      } satisfies RecallResponse);

      const deps = {
        apiKeys: await makeKeyLookup(),
        storage,
        cognitive: makeMockCognitive({ recall }),
      } as unknown as ServerDeps;
      const app = createApp({ deps, version: "0.0.0-test" });

      const res = await app.request("/recall", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ query: "single-writer part A", topK: 10 }),
      });
      expect(res.status).toBe(200);
      await flush();

      expect(recordSpy).not.toHaveBeenCalled();
    });
  });

  describe("Part B — core's real recordCoRecall fires exactly once per qualifying pair", () => {
    async function runWithRealCoRecall(n: number): Promise<{
      storage: InMemoryStorageAdapter;
      recordSpy: ReturnType<typeof vi.spyOn>;
    }> {
      const storage = new InMemoryStorageAdapter();
      const factIds = Array.from({ length: n }, (_, i) => `fact-b${i}`);
      const recordSpy = vi.spyOn(storage, "recordCoRecallStdp");

      // The mock cognitive.recall wires core's REAL recordCoRecall (imported
      // from the barrel, not reimplemented) against the same storage the
      // route holds — design.md D4's rejected alternative was re-implementing
      // core's pairing in the test fixture, which drifts from real behavior.
      const recall = vi.fn(
        async (query: RecallQuery, _auth: AuthContext): Promise<RecallResponse> => {
          await recordCoRecall(storage, query.workspaceId, factIds);
          return {
            hits: factIds.map((id) => makeHit({ id })),
            total: factIds.length,
            query: { text: query.text, limit: 10, offset: 0 },
            latencyMs: 1,
            fromHotTier: false,
          };
        }
      );

      const deps = {
        apiKeys: await makeKeyLookup(),
        storage,
        cognitive: makeMockCognitive({ recall }),
      } as unknown as ServerDeps;
      const app = createApp({ deps, version: "0.0.0-test" });

      const res = await app.request("/recall", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ query: `single-writer part B n=${n}`, topK: 10 }),
      });
      expect(res.status).toBe(200);
      await flush();

      return { storage, recordSpy };
    }

    it("n=3 (below the CO_RECALL_TOP_K cap) — exactly 3 calls, each relation id appears once", async () => {
      const { recordSpy } = await runWithRealCoRecall(3);
      expect(recordSpy).toHaveBeenCalledTimes(pairCount(3));

      const relationIds = recordSpy.mock.calls.map((call) => call[1] as string);
      const counts = new Map<string, number>();
      for (const id of relationIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      expect(relationIds).toHaveLength(3);
      expect([...counts.values()].every((c) => c === 1)).toBe(true);
    });

    it("n=8 (above the CO_RECALL_TOP_K cap) — exactly 15 calls (capped at 6), not 28", async () => {
      expect(CO_RECALL_TOP_K).toBe(6);
      const { recordSpy } = await runWithRealCoRecall(8);
      expect(recordSpy).toHaveBeenCalledTimes(pairCount(6));
      expect(recordSpy).not.toHaveBeenCalledTimes(pairCount(8));

      const relationIds = recordSpy.mock.calls.map((call) => call[1] as string);
      const counts = new Map<string, number>();
      for (const id of relationIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      expect(relationIds).toHaveLength(15);
      expect([...counts.values()].every((c) => c === 1)).toBe(true);
    });
  });

  describe("D5 — multi-level recall never forms cross-workspace co-recall pairs", () => {
    it("each level's recordCoRecall pass is scoped to the workspace it actually queried", async () => {
      const storage = new InMemoryStorageAdapter();
      const baseFactIds = ["ws-fact-1", "ws-fact-2", "ws-fact-3"];
      const personalFactIds = ["personal-fact-1", "personal-fact-2"];
      const userId = "user-p60-d5";

      const seenWorkspaceIds: string[] = [];
      const recall = vi.fn(
        async (query: RecallQuery, _auth: AuthContext): Promise<RecallResponse> => {
          seenWorkspaceIds.push(query.workspaceId);
          const factIds = query.workspaceId === WS_ID ? baseFactIds : personalFactIds;
          await recordCoRecall(storage, query.workspaceId, factIds);
          return {
            hits: factIds.map((id) => makeHit({ id })),
            total: factIds.length,
            query: { text: query.text, limit: 10, offset: 0 },
            latencyMs: 1,
            fromHotTier: false,
          };
        }
      );

      // Fake `postgres.Sql`: getUserPersonalWorkspaceId issues 3 tagged-template
      // calls inside one sql.begin(tx) — set_config (ignored), the
      // personal_tenant_id lookup, then the workspace-id-by-tenant lookup.
      // Distinguished by query text since both are simple SELECTs.
      const fakeSql = {
        begin: async (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = async (strings: TemplateStringsArray) => {
            const text = strings.join(" ");
            if (text.includes("personal_tenant_id")) {
              return [{ personal_tenant_id: "stub-tenant-id" }];
            }
            if (text.includes("mnemo_workspace")) {
              return [{ id: PERSONAL_WS_ID }];
            }
            return [];
          };
          return fn(tx);
        },
      };

      const auth: AuthContext = {
        workspaceId: WS_ID,
        actorId: "key:test",
        actorType: "agent",
        userId,
        scopes: ["memory:read"],
      };
      const baseQuery: RecallQuery = { workspaceId: WS_ID, text: "d5 scope test", limit: 10 };

      const createRelationSpy = vi.spyOn(storage, "createRelation");

      await multiLevelRecall(baseQuery, userId, null, {
        sql: fakeSql,
        cognitive: { recall } as unknown as ServerDeps["cognitive"],
        auth,
      } as unknown as Parameters<typeof multiLevelRecall>[3]);

      // Both levels ran, each against its own workspaceId.
      expect(seenWorkspaceIds.sort()).toEqual([PERSONAL_WS_ID, WS_ID].sort());

      // Every relation core created belongs entirely to one level's fact set,
      // tagged with that level's own workspaceId — never a base/personal mix.
      expect(createRelationSpy.mock.calls.length).toBeGreaterThan(0);
      for (const [input] of createRelationSpy.mock.calls) {
        const { workspaceId, sourceId, targetId } = input;
        if (baseFactIds.includes(sourceId) || baseFactIds.includes(targetId)) {
          expect(workspaceId).toBe(WS_ID);
          expect(baseFactIds).toContain(sourceId);
          expect(baseFactIds).toContain(targetId);
        } else {
          expect(workspaceId).toBe(PERSONAL_WS_ID);
          expect(personalFactIds).toContain(sourceId);
          expect(personalFactIds).toContain(targetId);
        }
      }
    });
  });

  describe("D2 regression — recordHyperedgeCoActivation still fires in the same request", () => {
    it("hyperedge worth still updates when >=2 members are served alongside the co-recall pass", async () => {
      const storage = new InMemoryStorageAdapter();
      const hyperedge = await storage.createHyperedge({
        workspaceId: WS_ID,
        memberIds: ["hedge-a", "hedge-b", "hedge-c"],
      });
      expect(hyperedge.worth).toBe(0.5);
      const updateWorthSpy = vi.spyOn(storage, "updateWorth");

      const recall = vi.fn().mockResolvedValue({
        hits: [makeHit({ id: "hedge-a" }), makeHit({ id: "hedge-b" })],
        total: 2,
        query: { text: "q", limit: 10, offset: 0 },
        latencyMs: 1,
        fromHotTier: false,
      } satisfies RecallResponse);

      const deps = {
        apiKeys: await makeKeyLookup(),
        storage,
        cognitive: makeMockCognitive({ recall }),
      } as unknown as ServerDeps;
      const app = createApp({ deps, version: "0.0.0-test" });

      const res = await app.request("/recall", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ query: "single-writer D2 regression", topK: 10 }),
      });
      expect(res.status).toBe(200);
      await flush();

      expect(updateWorthSpy).toHaveBeenCalledWith(
        hyperedge.id,
        WS_ID,
        "hyperedge",
        expect.anything()
      );
      const updated = await storage.getHyperedge(hyperedge.id, WS_ID);
      expect(updated?.worth).toBeCloseTo(0.6, 5);
    });
  });

  describe("Synthetic traffic — no hyperedge co-activation", () => {
    it("an evaluation credential is served but leaves hyperedge worth untouched", async () => {
      const storage = new InMemoryStorageAdapter();
      const hyperedge = await storage.createHyperedge({
        workspaceId: WS_ID,
        memberIds: ["hedge-a", "hedge-b", "hedge-c"],
      });
      const updateWorthSpy = vi.spyOn(storage, "updateWorth");
      const recall = vi.fn().mockResolvedValue({
        hits: [makeHit({ id: "hedge-a" }), makeHit({ id: "hedge-b" })],
        total: 2,
        query: { text: "q", limit: 10, offset: 0 },
        latencyMs: 1,
        fromHotTier: false,
      } satisfies RecallResponse);
      const deps = {
        apiKeys: await makeKeyLookup(),
        storage,
        cognitive: makeMockCognitive({ recall }),
        trafficOrigins: { "key:key-co-recall-single-writer": "evaluation" },
      } as unknown as ServerDeps;
      const app = createApp({ deps, version: "0.0.0-test" });

      const res = await app.request("/recall", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ query: "synthetic recall", topK: 10 }),
      });
      expect(res.status).toBe(200);
      await flush();

      expect((recall.mock.calls[0]![0] as RecallQuery).effects).toEqual({
        trafficOrigin: "evaluation",
        applyOrganicEffects: false,
      });
      expect(updateWorthSpy).not.toHaveBeenCalled();
      expect((await storage.getHyperedge(hyperedge.id, WS_ID))?.worth).toBe(0.5);
    });
  });

  describe("Non-fact hits — no relation, no STDP call", () => {
    it("an episode hit produces zero relations and zero recordCoRecallStdp calls", async () => {
      const storage = new InMemoryStorageAdapter();
      // Pre-relate an episode + a fact — if any writer blindly paired hits
      // without a primitive filter (the old server bug), this relation would
      // be found and strengthened.
      await storage.createRelation({
        workspaceId: WS_ID,
        sourceId: "episode-1",
        sourceType: "episode",
        targetId: "fact-e1",
        targetType: "fact",
        verb: "related",
      });
      const recordSpy = vi.spyOn(storage, "recordCoRecallStdp");
      const createRelationSpy = vi.spyOn(storage, "createRelation");

      const recall = vi.fn().mockResolvedValue({
        hits: [
          makeHit({ id: "episode-1", primitive: "episode" }),
          makeHit({ id: "fact-e1", primitive: "fact" }),
        ],
        total: 2,
        query: { text: "q", limit: 10, offset: 0 },
        latencyMs: 1,
        fromHotTier: false,
      } satisfies RecallResponse);

      const deps = {
        apiKeys: await makeKeyLookup(),
        storage,
        cognitive: makeMockCognitive({ recall }),
      } as unknown as ServerDeps;
      const app = createApp({ deps, version: "0.0.0-test" });

      const res = await app.request("/recall", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ query: "single-writer non-fact hit", topK: 10 }),
      });
      expect(res.status).toBe(200);
      await flush();

      expect(recordSpy).not.toHaveBeenCalled();
      expect(createRelationSpy).not.toHaveBeenCalled();
    });
  });
});
