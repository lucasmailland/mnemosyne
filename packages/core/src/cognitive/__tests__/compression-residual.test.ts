// packages/core/src/v3/__tests__/compression-residual.test.ts
import { describe, it, expect } from "vitest";
import { encodeDelta } from "@mnemo-ai/types";
import type { MnemoEpisode } from "@mnemo-ai/types";
import { compressSubtree, type CompressionCandidate } from "../compression.js";
import type { CoreContext } from "../context.js";

const ROOT = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n");
const CHILD = ["alpha", "beta", "GAMMA-2", "delta", "epsilon"].join("\n");

function ep(id: string, depth: number, narrative: string, deltaContent: string | undefined, parentEpisodeId: string | undefined): MnemoEpisode {
  return {
    id, workspaceId: "ws", title: "T", narrative,
    occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    participants: [], topics: [], linkedFactIds: [],
    parentEpisodeId, deltaContent, isRoot: depth === 0, depth,
    isSynthetic: false, createdAt: new Date(), updatedAt: new Date(), metadata: {}, // determinism-ok: throwaway fixture date, not asserted
  } as MnemoEpisode;
}

describe("compression reconstructs residual source before summarizing (F4)", () => {
  it("feeds the LLM the applied-delta source, not concatenated diffs", async () => {
    let seenPrompt = "";
    const ctx = {
      llm: {
        id: "mock",
        generate: async ({ messages }: { messages: Array<{ content: string }> }) => {
          seenPrompt = messages[0]!.content;
          return { content: "summary", model: "m", tokensUsed: { input: 1, output: 1 }, costUSD: 0 };
        },
      },
      logger: { info() {}, debug() {}, warn() {}, error() {} },
      telemetry: { startSpan: () => ({ end() {} }) },
    } as unknown as CoreContext;

    const candidate: CompressionCandidate = {
      rootEpisodeId: "root",
      trigger: "member_count",
      subtree: [
        ep("root", 0, ROOT, undefined, undefined),
        ep("child", 1, "", encodeDelta(ROOT, CHILD), "root"),
      ],
    };

    await compressSubtree(ctx, candidate);

    // The reconstructed child (CHILD) must appear in the LLM prompt; the residual
    // header must NOT (proving applyDelta ran, not a raw concat of deltaContent).
    expect(seenPrompt).toContain("GAMMA-2");
    expect(seenPrompt).not.toContain("MNEMO_DELTA_V1");
  });
});
