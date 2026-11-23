/**
 * AB7.3 — BatchingEmbedAdapter tests (spec §35 lines 4437–4438).
 * maxItems:100, maxWaitMs:50
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { BatchingEmbedAdapter } from "../BatchingEmbedAdapter.js";
import type { EmbedAdapter } from "@mnemo-ai/types";

function makeBase(fn: (texts: string[]) => Promise<Float32Array[]>): EmbedAdapter {
  return {
    id: "test",
    model: "test-model",
    dimensions: 3,
    embed: fn,
    embedSingle: async (t) => (await fn([t]))[0]!,
    healthCheck: async () => ({ status: "ok", latencyMs: 0 }),
  };
}

describe("BatchingEmbedAdapter — spec §35 lines 4437–4438", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("100 concurrent embedSingle calls → exactly one embed() call (maxItems flush)", async () => {
    let callCount = 0;
    const base = makeBase(async (texts) => {
      callCount++;
      return texts.map(() => new Float32Array([1, 0, 0]));
    });
    const adapter = new BatchingEmbedAdapter(base, { maxItems: 100, maxWaitMs: 200 });

    const promises = Array.from({ length: 100 }, (_, i) => adapter.embedSingle(`text${i}`));
    const results = await Promise.all(promises);

    expect(callCount).toBe(1);
    expect(results).toHaveLength(100);
    expect(results[0]).toBeInstanceOf(Float32Array);
    adapter.destroy();
  });

  it("3 calls then 60ms wait → one embed() call (maxWait flush)", async () => {
    let callCount = 0;
    const base = makeBase(async (texts) => {
      callCount++;
      return texts.map(() => new Float32Array([0, 1, 0]));
    });
    const adapter = new BatchingEmbedAdapter(base, { maxItems: 100, maxWaitMs: 30 });

    const p1 = adapter.embedSingle("a");
    const p2 = adapter.embedSingle("b");
    const p3 = adapter.embedSingle("c");
    await Promise.all([p1, p2, p3]);

    expect(callCount).toBe(1);
    adapter.destroy();
  });

  it("results map back to correct callers in order", async () => {
    const base = makeBase(async (texts) => {
      return texts.map((t, i) => new Float32Array([i, 0, 0]));
    });
    const adapter = new BatchingEmbedAdapter(base, { maxItems: 100, maxWaitMs: 30 });

    const texts = ["a", "b", "c", "d"];
    const results = await Promise.all(texts.map((t) => adapter.embedSingle(t)));

    for (let i = 0; i < 4; i++) {
      expect(results[i]![0]).toBe(i);
    }
    adapter.destroy();
  });

  it("embed(texts[]) also works correctly", async () => {
    const base = makeBase(async (texts) => texts.map(() => new Float32Array([1, 1, 1])));
    const adapter = new BatchingEmbedAdapter(base, { maxItems: 100, maxWaitMs: 30 });

    const results = await adapter.embed(["x", "y", "z"]);
    expect(results).toHaveLength(3);
    adapter.destroy();
  });

  it("healthCheck delegates to base adapter", async () => {
    const base = makeBase(async (t) => t.map(() => new Float32Array(3)));
    const adapter = new BatchingEmbedAdapter(base, { maxItems: 100, maxWaitMs: 30 });
    const h = await adapter.healthCheck();
    expect(h.status).toBe("ok");
    adapter.destroy();
  });
});
