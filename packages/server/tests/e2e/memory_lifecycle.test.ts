// E2E test: remember → recall → forget — TASK-15003, TESTING_STRATEGY.md §5.
//
// Tests the full HTTP lifecycle using the real Hono app + in-memory stubs.
// No database, no LLM provider — just the route/middleware stack.
// Recall uses a keyword-match stub (no vector search).

import { describe, it, expect, beforeAll, vi } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../../src/app.js";
import type { Fact, MnemoCore } from "../../src/deps.js";
import type { ApiKeyLookup } from "../../src/auth.js";
import type { StorageAdapter } from "@mnemo-ai/types";

// ─── Test credentials ─────────────────────────────────────────────────────────

const WS_A = "00000000-0000-0000-0000-000000000025";
const WS_B = "00000000-0000-0000-0000-000000000026";
const KEY_A = "mns_test_e2eworkspacea0000000001";
const KEY_B = "mns_test_e2eworkspaceb0000000001";

let keyHashA = "";
let keyHashB = "";

beforeAll(async () => {
  // saltRounds=4 for speed in tests; never use <10 in production
  keyHashA = await bcrypt.hash(KEY_A, 4);
  keyHashB = await bcrypt.hash(KEY_B, 4);
});

// ─── In-memory stub implementing MnemoCore + StorageAdapter (partial) ────────

function makeCoreAndCognitive(): {
  cognitive: MnemoCore;
  storage: Partial<StorageAdapter>;
} {
  const facts = new Map<string, Fact>();
  let seq = 0;

  // flatten-legacy-dual-core Phase 7: this file's `core: CoreLike` fake
  // (the pre-PR8 write path, `POST /facts` → `deps.core.createFact`) is
  // deleted — `CoreLike` itself is deleted this Phase, and the fake had
  // already been fully unreachable since PR8 deleted `POST /facts` (its
  // ONLY caller). `cognitive`/`storage` below are the sole live write/read
  // paths this E2E has exercised since PR8.
  const cognitive: MnemoCore = {
    // flatten-legacy-dual-core PR8: POST /facts (which wrote via
    // core.createFact) was DELETED — POST /remember (deps.cognitive.remember)
    // is now the sole write path this E2E exercises. This stub writes into
    // the SAME shared `facts` Map `cognitive.recall`/the storage fake below
    // read from — matching this file's existing "one shared fake store"
    // design, not a new mechanism.
    remember: vi.fn(
      async (
        args: { workspaceId: string; content: string; attribution?: unknown; tags?: string[] },
        _auth: unknown
      ) => {
        seq++;
        const id = `fact_e2e_${seq.toString().padStart(4, "0")}`;
        const now = new Date().toISOString(); // determinism-ok: throwaway fixture date, not asserted
        const fact: Fact = {
          id,
          workspaceId: args.workspaceId,
          content: args.content,
          attribution: (args.attribution ?? {}) as Record<string, unknown>,
          tags: args.tags ?? [],
          pinned: false,
          validFrom: now,
          validTo: null,
          createdAt: now,
        };
        facts.set(id, fact);
        return { id, kind: "fact" as const, staged: false };
      }
    ),
    recall: vi.fn(async (query: { workspaceId: string; text: string; limit?: number }) => {
      const q = (query.text ?? "").toLowerCase();
      const hits = [];
      for (const f of facts.values()) {
        if (f.workspaceId !== query.workspaceId) continue;
        if (f.validTo !== null) continue;
        if (!q || f.content.toLowerCase().includes(q)) {
          hits.push({
            id: f.id,
            content: f.content,
            score: 1.0,
            primitive: "fact" as const,
            sensitivity: "internal" as const,
            injectionScore: 0,
            provenance: "user_stated" as const,
            origin: "local" as const,
            contested: false,
            validFrom: new Date(f.validFrom),
            validTo: f.validTo ? new Date(f.validTo) : null,
            tags: [],
            relations: [],
          });
        }
      }
      return {
        hits: hits.slice(0, query.limit ?? 10),
        total: hits.length,
        query: { text: query.text, limit: query.limit ?? 10, offset: 0 },
        latencyMs: 0,
        fromHotTier: false,
      };
    }),
    recallHot: vi.fn().mockResolvedValue([]),
    forget: vi.fn().mockResolvedValue(undefined),
    updateWorth: vi.fn().mockResolvedValue(undefined),
    updateRelationStrength: vi.fn().mockResolvedValue(undefined),
  } as unknown as MnemoCore;

  // flatten-legacy-dual-core PR8: DELETE /facts/:id was ported from
  // deps.core.closeFact() to deps.storage.getFact()+archiveFact(). This
  // fake shares the SAME `facts` Map closure as `core`/`cognitive` above —
  // not an independent fake — so a forget via this path is still visible
  // to the subsequent POST /recall (cognitive.recall reads the same map).
  const storage: Partial<StorageAdapter> = {
    async getFact(id, workspaceId) {
      const f = facts.get(id);
      if (!f || f.workspaceId !== workspaceId) return null;
      return f as unknown as import("@mnemo-ai/types").MnemoFact;
    },
    async archiveFact(id, workspaceId) {
      const f = facts.get(id);
      if (!f || f.workspaceId !== workspaceId) return;
      facts.set(id, { ...f, validTo: new Date().toISOString() }); // determinism-ok: throwaway fixture date, not asserted
    },
    async appendAuditEntry() {
      /* no-op */
    },
    async appendOutbox() {
      /* no-op */
    },
  };

  return { cognitive, storage };
}

// ─── In-memory ApiKeyLookup ──────────────────────────────────────────────────

function makeKeyLookup(): ApiKeyLookup {
  return {
    async listActive() {
      return [
        {
          id: "key_a",
          keyHash: keyHashA,
          workspaceId: WS_A,
          scopes: ["memory:write", "memory:read", "memory:delete"],
        },
        {
          id: "key_b",
          keyHash: keyHashB,
          workspaceId: WS_B,
          scopes: ["memory:write", "memory:read", "memory:delete"],
        },
      ];
    },
    touch() {
      /* no-op */
    },
  };
}

// ─── Helper: build app + typed request ───────────────────────────────────────

function makeApp() {
  const { cognitive, storage } = makeCoreAndCognitive();
  const app = createApp({
    deps: {
      cognitive,
      storage: storage as StorageAdapter,
      apiKeys: makeKeyLookup(),
      embedModel: "text-embedding-3-small",
    },
    version: "0.0.0-test",
  });

  async function req(
    method: string,
    path: string,
    apiKey: string,
    body?: unknown
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    return app.request(`${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  return { req };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Memory lifecycle E2E", () => {
  it("creates, recalls, and forgets a fact (single workspace)", async () => {
    const { req } = makeApp();

    // 1. Create a fact
    const createRes = await req("POST", "/remember", KEY_A, {
      statement: "mnemosyne_e2e_unique_marker",
      attribution: { source: "e2e-test" },
      tags: ["e2e"],
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };
    expect(id).toBeTruthy();

    // 2. Recall — should find the fact (supply vector to skip LLM embed)
    const recallRes1 = await req("POST", "/recall", KEY_A, {
      query: "mnemosyne_e2e_unique_marker",
      vector: Array.from({ length: 1536 }, () => 0),
      topK: 5,
    });
    expect(recallRes1.status).toBe(200);
    const { hits } = (await recallRes1.json()) as { hits: { id: string }[] };
    expect(hits.find((h) => h.id === id)).toBeDefined();

    // 3. Soft-delete (forget) the fact
    const deleteRes = await req("DELETE", `/facts/${id}`, KEY_A);
    expect(deleteRes.status).toBe(204);

    // 4. Recall again — should NOT find the (now closed) fact
    const recallRes2 = await req("POST", "/recall", KEY_A, {
      query: "mnemosyne_e2e_unique_marker",
      vector: Array.from({ length: 1536 }, () => 0),
      topK: 5,
    });
    expect(recallRes2.status).toBe(200);
    const { hits: hits2 } = (await recallRes2.json()) as { hits: { id: string }[] };
    expect(hits2.find((h) => h.id === id)).toBeUndefined();
  });

  it("workspace B cannot recall facts from workspace A", async () => {
    const { req } = makeApp();

    // Workspace A creates a fact
    const createRes = await req("POST", "/remember", KEY_A, {
      statement: "workspace_a_secret_e2e_marker",
      attribution: {},
      tags: [],
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    // Workspace B recalls — should NOT see workspace A's fact
    const recallRes = await req("POST", "/recall", KEY_B, {
      query: "workspace_a_secret_e2e_marker",
      vector: Array.from({ length: 1536 }, () => 0),
      topK: 5,
    });
    expect(recallRes.status).toBe(200);
    const { hits } = (await recallRes.json()) as { hits: { id: string }[] };
    expect(hits.find((h) => h.id === id)).toBeUndefined();
  });

  it("returns 401 when no auth token is supplied", async () => {
    const { req } = makeApp();
    const res = await req("POST", "/remember", "", {
      statement: "should not be stored",
      attribution: {},
      tags: [],
    });
    expect(res.status).toBe(401);
  });
});
