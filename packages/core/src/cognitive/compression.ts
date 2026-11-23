/**
 * Experience-Compression — cross-level adaptive compression of episode delta-trees
 * (arXiv:2604.15877; spec MEMORY_IMPROVEMENT.md:90, :102). The spec names the
 * mechanism but gives no algorithm; this module defines it (see DD-2 in the
 * Wave Z plan):
 *
 *   - A subtree is a candidate when depth > maxDepth (4) OR members > maxMembers (8).
 *   - compressSubtree LLM-summarizes the whole subtree into ONE parent narrative
 *     (the "cross-level" collapse) while RETAINING leaf deltas for reconstruction,
 *     targeting compressedChars <= targetRatio (0.5) * sourceChars.
 *
 * Pure except for ctx.llm — it returns a plan and never persists (the adapter
 * does that), mirroring collapseSession's port-only discipline.
 */

import type { MnemoEpisode } from "@mnemo-ai/types";
import { applyDelta } from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";
import { reportLlmUsage } from "./llm-usage.js";

export interface CompressionPolicy {
  maxDepth: number; // default 4
  maxMembers: number; // default 8
  targetRatio: number; // default 0.5
}

export const DEFAULT_COMPRESSION_POLICY: CompressionPolicy = {
  maxDepth: 4,
  maxMembers: 8,
  targetRatio: 0.5,
};

export interface CompressionCandidate {
  rootEpisodeId: string;
  subtree: MnemoEpisode[]; // root-first
  trigger: "depth" | "member_count";
}

export interface CompressionResult {
  status: "compressed" | "skipped";
  skipReason?: "below_triggers" | "llm_unavailable" | "ratio_not_met";
  rootEpisodeId: string;
  compressedNarrative?: string;
  retainedDeltas?: Array<{ episodeId: string; deltaContent: string }>;
  sourceChars: number;
  compressedChars: number;
  achievedRatio?: number;
  llmTokensUsed: number;
}

/** Max depth span in the subtree (relative to root depth). */
function subtreeSpan(subtree: MnemoEpisode[]): number {
  if (subtree.length === 0) return 0;
  const minDepth = Math.min(...subtree.map((e) => e.depth));
  const maxDepth = Math.max(...subtree.map((e) => e.depth));
  return maxDepth - minDepth;
}

export function detectCompressionCandidate(
  subtree: MnemoEpisode[],
  policy: CompressionPolicy
): CompressionCandidate | null {
  if (subtree.length === 0) return null;
  const ordered = [...subtree].sort((a, b) => a.depth - b.depth);
  const root = ordered[0]!;
  if (subtreeSpan(subtree) > policy.maxDepth) {
    return { rootEpisodeId: root.id, subtree: ordered, trigger: "depth" };
  }
  if (subtree.length > policy.maxMembers) {
    return { rootEpisodeId: root.id, subtree: ordered, trigger: "member_count" };
  }
  return null;
}

function reconstructSource(subtree: MnemoEpisode[]): string {
  // subtree is root-first (sorted by depth in detectCompressionCandidate). Fold
  // root→leaf applying each descendant's residual delta, matching reconstructEpisode
  // (DELTAMEM §16). A header-less legacy deltaContent applies as a literal.
  const root = subtree[0]!;
  let reconstructed = root.narrative;
  for (const e of subtree.slice(1)) {
    reconstructed = applyDelta(reconstructed, e.deltaContent ?? "");
  }
  return reconstructed;
}

export async function compressSubtree(
  ctx: CoreContext,
  candidate: CompressionCandidate,
  policy: CompressionPolicy = DEFAULT_COMPRESSION_POLICY
): Promise<CompressionResult> {
  const source = reconstructSource(candidate.subtree);
  const sourceChars = source.length;

  if (!ctx.llm) {
    return {
      status: "skipped",
      skipReason: "llm_unavailable",
      rootEpisodeId: candidate.rootEpisodeId,
      sourceChars,
      compressedChars: 0,
      llmTokensUsed: 0,
    };
  }

  const targetChars = Math.floor(policy.targetRatio * sourceChars);
  const prompt = [
    "Summarize the following episode subtree into ONE faithful narrative.",
    "Preserve every distinct fact, decision, and outcome; drop only redundancy.",
    `Aim for at most ${targetChars} characters. Return ONLY the summary text.`,
    "",
    source,
  ].join("\n");

  let compressedNarrative: string;
  let llmTokensUsed = 0;
  try {
    const out = await ctx.llm.generate({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
      temperature: 0.1,
      task: "summary",
    });
    compressedNarrative = out.content.trim();
    llmTokensUsed = out.tokensUsed.input + out.tokensUsed.output;
    // Report token + cost usage to the host's metrics layer (completion path).
    // Fire-and-forget: a metrics failure must never break compression.
    reportLlmUsage(
      ctx,
      ctx.llm.id,
      out.model,
      out.tokensUsed.input,
      out.tokensUsed.output,
      out.costUSD
    );
  } catch (err) {
    ctx.logger.debug("compression: LLM failed — skipping", {
      operation: "compression.llm",
      error: { type: "LLMError", message: err instanceof Error ? err.message : String(err) },
    });
    return {
      status: "skipped",
      skipReason: "llm_unavailable",
      rootEpisodeId: candidate.rootEpisodeId,
      sourceChars,
      compressedChars: 0,
      llmTokensUsed,
    };
  }

  const compressedChars = compressedNarrative.length;
  const achievedRatio = sourceChars > 0 ? compressedChars / sourceChars : 1;

  if (compressedChars >= sourceChars) {
    return {
      status: "skipped",
      skipReason: "ratio_not_met",
      rootEpisodeId: candidate.rootEpisodeId,
      sourceChars,
      compressedChars,
      achievedRatio,
      llmTokensUsed,
    };
  }

  // Retain leaf deltas (everything below the root) for lossless reconstruction.
  const retainedDeltas = candidate.subtree
    .slice(1)
    .filter((e) => e.deltaContent && e.deltaContent.length > 0)
    .map((e) => ({ episodeId: e.id, deltaContent: e.deltaContent! }));

  return {
    status: "compressed",
    rootEpisodeId: candidate.rootEpisodeId,
    compressedNarrative,
    retainedDeltas,
    sourceChars,
    compressedChars,
    achievedRatio,
    llmTokensUsed,
  };
}
