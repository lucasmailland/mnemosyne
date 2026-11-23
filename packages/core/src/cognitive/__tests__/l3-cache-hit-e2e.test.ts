/**
 * P59 (docs/archive/openspec/p59-query-cache-l3-fix) — the proposal's "has never once
 * happened" criterion: two identical recalls against InMemoryStorageAdapter,
 * the second must be served entirely from the L3 query-result cache
 * (tier_hit = "l3_cache", cache_hit = true) and must perform zero
 * `vector.search` calls.
 */
import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { createCore } from "../index.js";

const WORKSPACE_ID = "ws-l3-e2e";
const EMBEDDING = new Float32Array([0.1, 0.2, 0.3, 0.4]);

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this;
  },
} as never;

function auth(): AuthContext {
  return {
    workspaceId: WORKSPACE_ID,
    actorId: "admin-1",
    actorType: "agent",
    scopes: ["memory:read", "memory:admin"],
  } as AuthContext;
}

async function createFact(storage: InMemoryStorageAdapter, statement: string) {
  const fact = await storage.createFact({
    workspaceId: WORKSPACE_ID,
    scope: "global",
    statement,
    subject: "l3-e2e",
    kind: "other",
    attribution: "user_stated",
    sensitivity: "public",
  });
  await storage.updateWorth(fact.id, WORKSPACE_ID, "fact", {
    success: 100,
    failure: 0,
    creditWeight: 1,
  });
  return fact;
}

describe("L3 query cache — end-to-end hit (design.md, the never-once-happened case)", () => {
  it("serves the second identical recall from L3, with zero vector.search calls and tier_hit=l3_cache/cache_hit=true", async () => {
    const storage = new InMemoryStorageAdapter();
    const fact = await createFact(storage, "the L3 cache actually works now");
    const vectorSearch = vi
      .fn()
      .mockResolvedValue([{ id: fact.id, score: 1, primitiveKind: "fact" }]);

    const spans: Array<{ name: string; attrs: Record<string, unknown> }> = [];
    const telemetry = {
      startSpan: (name: string) => {
        const attrs: Record<string, unknown> = {};
        if (name === "mnemo.recall") spans.push({ name, attrs });
        return {
          setAttribute: (k: string, v: unknown) => {
            attrs[k] = v;
          },
          setStatus() {},
          end() {},
        };
      },
      counter() {},
      histogram() {},
      gauge() {},
      async shutdown() {},
    } as never;

    const core = createCore({
      storage,
      vector: { search: vectorSearch } as never,
      embed: { model: "test", embedSingle: vi.fn().mockResolvedValue(EMBEDDING) } as never,
      outbox: { append: vi.fn().mockResolvedValue(undefined) } as never,
      logger,
      telemetry,
    });

    const query = { workspaceId: WORKSPACE_ID, text: "does l3 ever hit", embedding: EMBEDDING };

    const first = await core.recall(query, auth());
    expect(first.hits.map((h) => h.id)).toEqual([fact.id]);
    expect(vectorSearch).toHaveBeenCalledTimes(1);
    expect(spans[0]?.attrs["mnemo.tier_hit"]).toBe("cold");
    expect(spans[0]?.attrs["mnemo.cache_hit"]).toBe(false);

    const second = await core.recall(query, auth());
    expect(second.hits.map((h) => h.id)).toEqual([fact.id]);
    // The defining assertion: no second vector.search call — served from L3.
    expect(vectorSearch).toHaveBeenCalledTimes(1);
    expect(spans[1]?.attrs["mnemo.tier_hit"]).toBe("l3_cache");
    expect(spans[1]?.attrs["mnemo.cache_hit"]).toBe(true);
  });
});
