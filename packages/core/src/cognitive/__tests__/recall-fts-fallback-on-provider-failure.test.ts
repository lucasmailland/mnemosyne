/**
 * P128 — recall falls back to full-text when the embedder FAILS, not only when
 * it is configured as absent.
 *
 * `memory_search` and `memory_recall` both document an automatic fall back to
 * FTS when no embedder is available. With ollama stopped, `POST /recall`
 * returned 500. The condition was:
 *
 *   const isFtsFallback = !query.embedding && ctx.embed.model === "none";
 *
 * — true only when the embedder is CONFIGURED ABSENT. A configured provider
 * that does not answer sailed past it into `embedSingle` and threw.
 *
 * That is the wrong half to have covered. "No embedder configured" is a
 * deploy-time state someone chose and already knows about. "The provider is
 * down" arrives on its own, at night, and is the one users experience as the
 * product being broken.
 *
 * Strict `semantic` still throws. That contract (B5.9) is why the mode means
 * anything: silently handing lexical results to a caller who asked for vectors
 * would make "semantic" a decoration.
 */
import { describe, it, expect, vi } from "vitest";

import { recallCold } from "../recall-cold.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { CoreContext } from "../../types.js";

const WS = "ws_1";

/** A context whose embedder is CONFIGURED but throws, i.e. the provider is down. */
function ctxWithFailingEmbedder(): CoreContext {
  const storage = new InMemoryStorageAdapter();
  return {
    storage,
    embed: {
      id: "ollama",
      model: "mxbai-embed-large",
      dimensions: 1024,
      semantic: true,
      embedSingle: vi.fn(async () => {
        throw new Error("Network error calling ollama: fetch failed");
      }),
      embedBatch: vi.fn(async () => {
        throw new Error("Network error calling ollama: fetch failed");
      }),
    },
    vector: {
      search: async () => [],
      upsert: async () => undefined,
      remove: async () => undefined,
    },
    cache: undefined,
    llm: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    telemetry: {
      startSpan: () => ({ end: vi.fn(), setAttribute: vi.fn(), recordException: vi.fn() }),
      histogram: vi.fn(),
      counter: vi.fn(),
      gauge: vi.fn(),
    },
    config: { surpriseThreshold: 0.15 },
  } as unknown as CoreContext;
}

const AUTH = {
  workspaceId: WS,
  actorId: "key:k1",
  actorType: "agent",
  userId: null,
  scopes: ["memory:read", "memory:write"],
} as never;

describe("P128 — an unreachable embedder degrades instead of 500ing", () => {
  it("returns results instead of throwing when the provider fails", async () => {
    const ctx = ctxWithFailingEmbedder();

    const res = await recallCold(ctx, { workspaceId: WS, text: "cache" } as never, AUTH);

    // The whole point: a provider outage used to propagate out as a 500. The
    // caller now gets an answer.
    expect(res).toBeTruthy();
    expect(Array.isArray(res.memories ?? res.hits ?? [])).toBe(true);
  });

  it("says it fell back, rather than passing lexical results off as semantic", async () => {
    // Degrading in silence has its own cost — the caller cannot tell that what
    // it got is not what it asked for. `debug.searchMode` is where that is paid.
    const ctx = ctxWithFailingEmbedder();

    const res = (await recallCold(ctx, { workspaceId: WS, text: "cache" } as never, AUTH)) as {
      debug?: { modeUsed?: string; fallback?: boolean };
    };

    expect(res.debug?.modeUsed).toBe("fts");
    expect(res.debug?.fallback).toBe(true);
  });

  it("logs the real provider error rather than swallowing it", async () => {
    // A silent degradation is how an outage lasts a week. The response degrades;
    // the log has to name the cause.
    const ctx = ctxWithFailingEmbedder();
    await recallCold(ctx, { workspaceId: WS, text: "cache" } as never, AUTH);

    const warn = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.stringify(c))
      .join(" ");
    expect(warn).toContain("recall.embed_failed_falling_back_to_fts");
    expect(warn).toContain("ollama");
  });

  it("strict semantic still THROWS — the mode has to mean something", async () => {
    // B5.9's contract. If `semantic` quietly returned lexical hits, no caller
    // could ever rely on having got vector search, and `memory_search`'s
    // description would be unfalsifiable.
    const ctx = ctxWithFailingEmbedder();

    await expect(
      recallCold(ctx, { workspaceId: WS, text: "cache", mode: "semantic" } as never, AUTH)
    ).rejects.toThrow();
  });

  it("a caller-supplied embedding never touches the provider", async () => {
    // The precomputed-vector path must not be dragged into the failure: there
    // is nothing to embed, so a dead provider is irrelevant to it.
    const ctx = ctxWithFailingEmbedder();

    const res = await recallCold(
      ctx,
      { workspaceId: WS, text: "cache", embedding: new Float32Array(1024).fill(0.01) } as never,
      AUTH
    );

    expect(res).toBeTruthy();
    expect(ctx.embed.embedSingle).not.toHaveBeenCalled();
  });
});
