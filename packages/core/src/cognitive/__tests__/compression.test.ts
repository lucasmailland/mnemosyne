import { describe, it, expect, vi } from "vitest";
import { detectCompressionCandidate, compressSubtree } from "../compression.js";
import type { MnemoEpisode } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

const POLICY = { maxDepth: 4, maxMembers: 8, targetRatio: 0.5 };

function ep(id: string, depth: number, over: Partial<MnemoEpisode> = {}): MnemoEpisode {
  return {
    id, workspaceId: "ws1", title: "T", narrative: "", occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    participants: [], topics: [], linkedFactIds: [], isRoot: depth === 0, depth,
    isSynthetic: false, createdAt: new Date(), updatedAt: new Date(), metadata: {}, // determinism-ok: throwaway fixture date, not asserted
    ...over,
  } as MnemoEpisode;
}

describe("detectCompressionCandidate (spec §2 Experience Compression)", () => {
  it("returns null for a small shallow subtree (below both triggers)", () => {
    const subtree = [ep("r", 0), ep("c1", 1), ep("c2", 1)];
    expect(detectCompressionCandidate(subtree, POLICY)).toBeNull();
  });

  it("fires on the depth trigger (depth > 4)", () => {
    const subtree = [ep("r", 0), ep("a", 1), ep("b", 2), ep("c", 3), ep("d", 4), ep("e", 5)];
    const c = detectCompressionCandidate(subtree, POLICY);
    expect(c?.trigger).toBe("depth");
  });

  it("fires on the member-count trigger (> 8 members)", () => {
    const subtree = Array.from({ length: 10 }, (_, i) => ep(`n${i}`, i === 0 ? 0 : 1));
    const c = detectCompressionCandidate(subtree, POLICY);
    expect(c?.trigger).toBe("member_count");
  });
});

describe("compressSubtree (DD-2 contract)", () => {
  const candidate = {
    rootEpisodeId: "r",
    trigger: "member_count" as const,
    subtree: [
      ep("r", 0, { narrative: "ROOT narrative with lots of original detail about the incident." }),
      // Header-less deltaContent is legacy "full narrative" form (see applyDelta):
      // reconstructSource folds to the leaf's full text, so these must be the
      // realistic full per-step narratives, comfortably larger than the summary.
      ep("a", 1, { deltaContent: "We checked DNS and found a stale record pointing at a host that had been decommissioned weeks earlier during the platform migration." }),
      ep("b", 1, { deltaContent: "We flushed the resolver cache and the alert cleared within two minutes, confirming the stale DNS record was the root cause of the outage." }),
    ],
  };

  it("compresses via the LLM and reports a sub-1.0 ratio", async () => {
    const generate = vi.fn(async () => ({ content: "DNS incident: stale record, cache flush resolved it.", tokensUsed: { input: 50, output: 12 } }));
    const ctx = { llm: { generate }, logger: { debug() {}, info() {}, child() { return this; } } } as any;
    const r = await compressSubtree(ctx, candidate, POLICY);
    expect(r.status).toBe("compressed");
    expect(r.achievedRatio!).toBeLessThan(1.0);
    expect(r.compressedNarrative).toContain("DNS");
    // Leaf deltas retained for reconstruction.
    expect(r.retainedDeltas!.map((d) => d.episodeId).sort()).toEqual(["a", "b"]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("skips when ctx.llm is absent", async () => {
    const ctx = { logger: { debug() {}, child() { return this; } } } as any;
    const r = await compressSubtree(ctx, candidate, POLICY);
    expect(r.status).toBe("skipped");
    expect(r.skipReason).toBe("llm_unavailable");
  });

  it("skips when the LLM output is not actually smaller", async () => {
    const huge = "x".repeat(10_000);
    const generate = vi.fn(async () => ({ content: huge, tokensUsed: { input: 1, output: 1 } }));
    const ctx = { llm: { generate }, logger: { debug() {}, child() { return this; } } } as any;
    const r = await compressSubtree(ctx, candidate, POLICY);
    expect(r.status).toBe("skipped");
    expect(r.skipReason).toBe("ratio_not_met");
  });
});

describe("end-to-end: load subtree → detect → compress → persist (InMemory)", () => {
  it("persists the compressed narrative and marks root metadata", async () => {
    const storage = new InMemoryStorageAdapter();

    // Create root + 9 children (member-count trigger)
    const root = await storage.createEpisode({
      workspaceId: "ws1", title: "Root", narrative: "Root incident narrative that is quite long.",
      occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      participants: [], topics: [], linkedFactIds: [],
      isRoot: true, depth: 0, isSynthetic: false,
    });
    const children: Awaited<ReturnType<typeof storage.createEpisode>>[] = [];
    for (let i = 0; i < 9; i++) {
      const child = await storage.createEpisode({
        workspaceId: "ws1", title: `Delta ${i}`, narrative: "",
        occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        participants: [], topics: [], linkedFactIds: [],
        isRoot: false, depth: 1, isSynthetic: false,
        parentEpisodeId: root.id, deltaContent: `Delta detail ${i}: the investigation continued at this step with substantial additional context, findings, and remediation actions recorded for the incident timeline.`,
      });
      children.push(child);
    }

    // Load subtree via queryEpisodes with parentEpisodeId filter
    const page = await storage.queryEpisodes({ workspaceId: "ws1", parentEpisodeId: root.id });
    expect(page.items.length).toBe(9);

    const subtree = [root, ...page.items];
    const candidate = detectCompressionCandidate(subtree, POLICY);
    expect(candidate?.trigger).toBe("member_count");

    // Compress with fake LLM
    const generate = vi.fn(async () => ({ content: "Incident summary: 9 deltas recorded.", tokensUsed: { input: 10, output: 5 } }));
    const ctx = { llm: { generate }, logger: { debug() {}, info() {}, child() { return this; } } } as any;
    const result = await compressSubtree(ctx, candidate!, POLICY);
    expect(result.status).toBe("compressed");

    // Persist
    await storage.persistCompression({
      workspaceId: "ws1",
      rootEpisodeId: root.id,
      compressedNarrative: result.compressedNarrative!,
      retainedDeltas: result.retainedDeltas!,
    });

    // Verify root was updated
    const updated = await storage.queryEpisodes({ workspaceId: "ws1" });
    const updatedRoot = updated.items.find((e) => e.id === root.id);
    expect(updatedRoot?.narrative).toBe(result.compressedNarrative);
    expect(updatedRoot?.metadata?.compressed).toBe(true);
  });
});
