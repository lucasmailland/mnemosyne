import { describe, it, expect, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import type { AuthContext } from "@mnemo-ai/types";

/**
 * P109 task 2 — origin context reaches the row.
 *
 * `mnemo_fact` has carried `session_id` (indexed) and `episode_id` (FK, and the
 * only fact→context edge with referential integrity) since the baseline, and
 * `preferSourceEpisode` reads the latter on every cold recall. The write side
 * could not populate either from a caller: `RememberRequest` had no `episodeId`
 * at all, and neither field was exposed on the MCP tool. The only path that ever
 * filled them was the episodic collapse.
 *
 * The interesting case here is NOT the happy one. `episode_id` has a real FK, so
 * an id naming no episode aborts the INSERT and the caller LOSES THE WRITE — the
 * exact P74 failure class, re-imported through a field added to fix context
 * loss. These tests pin the asymmetry: a bad link is dropped, the fact survives.
 */

const WS = "ws-p109";

const auth: AuthContext = {
  workspaceId: WS,
  actorId: "agent-p109",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

function makeCtx(storage: InMemoryStorageAdapter, warn = vi.fn()) {
  return {
    ctx: {
      storage,
      vector: { search: async () => [], upsert: async () => {} },
      embed: {
        model: "test-embed-model",
        embedSingle: async () => new Float32Array([0.1, 0.2, 0.3]),
      },
      telemetry: {
        startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {} }),
      },
      logger: { info: () => {}, debug: () => {}, warn, error: () => {} },
      config: {
        // 0 disables the surprise gate — this file is about origin context, not
        // about the gate. Its own behaviour is pinned in the P74 guards.
        surpriseThreshold: 0,
        maxHotTierSize: 1000,
        worthDecayLambda: 0.1,
        hotTierTtlSeconds: 3600,
        injectionScoreThreshold: 0.85,
        anomalyScoreThreshold: 0.8,
      },
    } as never,
    warn,
  };
}

const req = (extra: Record<string, unknown>) =>
  ({
    workspaceId: WS,
    kind: "fact",
    content: "El cluster de staging migro de Redis a Valkey.",
    subject: "infra",
    ...extra,
  }) as never;

async function makeEpisode(storage: InMemoryStorageAdapter): Promise<string> {
  const ep = await storage.createEpisode!({
    workspaceId: WS,
    title: "sesion de infra",
    narrative: "migracion de cache",
    occurredAt: new Date(0),
  } as never);
  return ep.id;
}

describe("P109 — sessionId and episodeId reach the stored row", () => {
  it("persists sessionId on the fact", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage);

    const res = await remember(ctx, req({ sessionId: "sess-1" }), auth);
    const stored = await storage.getFact(res.id, WS);

    expect(stored?.sessionId).toBe("sess-1");
  });

  it("persists a VERIFIED episodeId — the canonical origin link", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage);
    const episodeId = await makeEpisode(storage);

    const res = await remember(ctx, req({ episodeId }), auth);
    const stored = await storage.getFact(res.id, WS);

    expect(stored?.episodeId).toBe(episodeId);
  });

  it("leaves episodeId unset when the caller supplies none", async () => {
    // Null is the correct "not linked yet" state — it is what
    // linkSessionFactsToEpisode looks for at collapse time, and only fills when
    // it is still NULL.
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage);

    const res = await remember(ctx, req({ sessionId: "sess-1" }), auth);
    const stored = await storage.getFact(res.id, WS);

    expect(stored?.episodeId ?? null).toBeNull();
  });
});

describe("P109 — a bad episodeId must not cost the write", () => {
  it("drops the link and STILL writes the fact when the episode does not exist", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage);

    const res = await remember(ctx, req({ episodeId: "ep-does-not-exist" }), auth);
    const stored = await storage.getFact(res.id, WS);

    // The fact is what the caller cares about. episode_id has an FK, so passing
    // the bogus id through to Postgres would abort the INSERT and lose it.
    expect(stored).not.toBeNull();
    expect(stored?.statement).toContain("Valkey");
    expect(stored?.episodeId ?? null).toBeNull();
  });

  it("keeps sessionId when the episodeId is dropped", async () => {
    // This is what makes the degradation RECOVERABLE rather than merely
    // survivable: with sessionId intact, the collapse's
    // linkSessionFactsToEpisode fills episode_id afterwards. Drop both and the
    // fact is context-orphaned for good.
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage);

    const res = await remember(ctx, req({ sessionId: "sess-1", episodeId: "nope" }), auth);
    const stored = await storage.getFact(res.id, WS);

    expect(stored?.sessionId).toBe("sess-1");
    expect(stored?.episodeId ?? null).toBeNull();
  });

  it("refuses an episode from ANOTHER workspace", async () => {
    // getEpisode is workspace-scoped, so a cross-workspace id resolves to null
    // and takes the drop path. Silently accepting it would let a caller stitch a
    // fact to context it must never see.
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage);
    const foreign = await storage.createEpisode!({
      workspaceId: "ws-other",
      title: "ajeno",
      narrative: "x",
      occurredAt: new Date(0),
    } as never);

    const res = await remember(ctx, req({ episodeId: foreign.id }), auth);
    const stored = await storage.getFact(res.id, WS);

    expect(stored).not.toBeNull();
    expect(stored?.episodeId ?? null).toBeNull();
  });

  it("warns loudly — silent degradation is the defect, not the fix", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx, warn } = makeCtx(storage);

    await remember(ctx, req({ episodeId: "nope" }), auth);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("episodeId names no episode"),
      expect.objectContaining({ episodeId: "nope" })
    );
  });

  it("survives a getEpisode that throws, instead of failing the write", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage);
    (storage as unknown as { getEpisode: unknown }).getEpisode = async () => {
      throw new Error("db down");
    };

    // A validation lookup that fails is not a reason to reject content.
    const res = await remember(ctx, req({ episodeId: "ep-1" }), auth);
    expect(res.id).toBeTruthy();
  });
});
