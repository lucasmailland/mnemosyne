/**
 * P128 follow-up — the embed call has a deadline well under the request budget.
 *
 * The budgets were inverted, and that inversion is what made a working fallback
 * useless:
 *
 *   provider HTTP timeout   60_000ms   (the innermost call)
 *   llm.embed breaker       10_000ms
 *   storage.read breaker     5_000ms   (wraps recall — the outermost budget)
 *
 * Twelve times the outer budget on the inner call. With ollama stopped, the
 * embed took ~3.5s just for DNS to give up, the FTS fallback then needed a
 * database round trip, and the 5s breaker fired first: `POST /recall` answered
 * 500 even though the degradation path was correct and did run.
 *
 * A fallback that cannot finish inside the request budget is not a fallback.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { createEmbedAdapter } from "../../embed-adapter.js";

const DIM = 4;

function providerThatHangs() {
  return {
    embed: vi.fn(
      () =>
        new Promise<number[]>(() => {
          /* never settles — a provider that accepted the connection and went quiet */
        })
    ),
  };
}

function providerThatAnswers(afterMs: number) {
  return {
    embed: vi.fn(
      () => new Promise<number[]>((resolve) => setTimeout(() => resolve([1, 2, 3, 4]), afterMs))
    ),
  };
}

afterEach(() => {
  delete process.env.MNEMO_EMBED_TIMEOUT_MS;
});

describe("P128 follow-up — embed deadline", () => {
  it("gives up on a hung provider instead of waiting out the request budget", async () => {
    process.env.MNEMO_EMBED_TIMEOUT_MS = "120";
    const adapter = createEmbedAdapter(providerThatHangs() as never, "m", DIM);

    const started = Date.now(); // determinism-ok: measuring elapsed time IS the assertion
    await expect(adapter.embedSingle("hola")).rejects.toThrow(/timed out after 120ms/);
    // The number that matters is not the message, it is that control came back
    // at all — a hung provider used to hold the request until something further
    // out gave up on it.
    expect(Date.now() - started).toBeLessThan(1000); // determinism-ok: elapsed-time bound, not a fixed instant
  });

  it("names the knob in the error, because the fix is usually configuration", async () => {
    // A timeout that says only "timed out" sends someone reading source. This
    // one has to say what to change when a provider is legitimately slow.
    process.env.MNEMO_EMBED_TIMEOUT_MS = "60";
    const adapter = createEmbedAdapter(providerThatHangs() as never, "mxbai-embed-large", DIM);

    await expect(adapter.embedSingle("hola")).rejects.toThrow(/MNEMO_EMBED_TIMEOUT_MS/);
    // And which model was being embedded — with two providers configured, "an
    // embed timed out" is not enough to know which one.
    await expect(adapter.embedSingle("hola")).rejects.toThrow(/mxbai-embed-large/);
  });

  it("does NOT trip on a provider that is merely slow but inside the budget", async () => {
    // The regression that would matter most. A deadline tight enough to catch
    // a cold start would turn a warm-up into a silent downgrade to lexical
    // search — worse than the bug, because it happens on healthy systems.
    process.env.MNEMO_EMBED_TIMEOUT_MS = "500";
    const adapter = createEmbedAdapter(providerThatAnswers(80) as never, "m", DIM);

    const vec = await adapter.embedSingle("hola");
    expect(Array.from(vec)).toEqual([1, 2, 3, 4]);
  });

  it("defaults to a budget under the 5s breaker that wraps recall", async () => {
    // Pinned as a RELATIONSHIP, not a magic number: the point is that the inner
    // deadline leaves room for the fallback to run, not that it equals 3000.
    delete process.env.MNEMO_EMBED_TIMEOUT_MS;
    const STORAGE_READ_BREAKER_MS = 5_000;
    const defaultBudget = Number(process.env.MNEMO_EMBED_TIMEOUT_MS ?? 3000);

    expect(defaultBudget).toBeLessThan(STORAGE_READ_BREAKER_MS);
    // Enough headroom left for the FTS query the fallback still has to run…
    expect(STORAGE_READ_BREAKER_MS - defaultBudget).toBeGreaterThanOrEqual(2000);
    // …and enough room ABOVE a measured cold start (~2.3s locally for Ollama
    // reloading mxbai-embed-large) that a warm-up is not silently downgraded
    // to lexical search. Both bounds matter; this is the squeeze the number
    // lives in.
    expect(defaultBudget).toBeGreaterThanOrEqual(2800);
  });

  it("the batch path is bounded too — one slow text cannot hold the rest", async () => {
    process.env.MNEMO_EMBED_TIMEOUT_MS = "120";
    const adapter = createEmbedAdapter(providerThatHangs() as never, "m", DIM);

    await expect(adapter.embed(["a", "b"])).rejects.toThrow(/timed out/);
  });
});
