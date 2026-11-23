// in-memory/agent.ts — InMemoryStorageAdapter's Agent profile port methods.
// decompose-inmemory-storage-adapter Batch B7a (design.md Module Map row 17).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { MnemoAgentProfile } from "../../primitives.js";
import type { InMemoryStorageState } from "./state.js";

// ── Agent profile (Wave M2 — spec §13 self-editing memory) ───────────────────

export async function getAgentProfile(
  state: InMemoryStorageState,
  workspaceId: string,
  agentId: string
): Promise<MnemoAgentProfile | null> {
  return state.agentProfiles.get(`${workspaceId}:${agentId}`) ?? null;
}

export async function upsertAgentProfile(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    agentId: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<MnemoAgentProfile> {
  const key = `${input.workspaceId}:${input.agentId}`;
  const existing = state.agentProfiles.get(key);
  const now = new Date();
  const updated: MnemoAgentProfile = {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    summary: input.summary ?? existing?.summary ?? "",
    metadata: input.metadata ?? existing?.metadata ?? {},
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  state.agentProfiles.set(key, updated);
  return updated;
}

export async function incrementSessionsSinceReflection(
  state: InMemoryStorageState,
  workspaceId: string,
  agentId: string
): Promise<number> {
  const key = `${workspaceId}:${agentId}`;
  const existing = state.agentProfiles.get(key);
  const prev = (existing?.metadata?.sessionsSinceReflection as number | undefined) ?? 0;
  const next = prev + 1;
  const now = new Date();
  const updated: MnemoAgentProfile = {
    workspaceId,
    agentId,
    summary: existing?.summary ?? "",
    metadata: { ...(existing?.metadata ?? {}), sessionsSinceReflection: next },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  state.agentProfiles.set(key, updated);
  return next;
}

export async function listScoredTrajectories(
  state: InMemoryStorageState,
  workspaceId: string,
  agentId: string,
  limit: number
): Promise<
  Array<{ sessionId: string; score: number; promptVersionId: string | null; createdAt: Date }>
> {
  const ratingToScore = (r: string | undefined): number | null => {
    if (r === "success") return 1.0;
    if (r === "failure") return 0.0;
    if (r === "neutral") return 0.5;
    return null;
  };
  const results: Array<{
    sessionId: string;
    score: number;
    promptVersionId: string | null;
    createdAt: Date;
  }> = [];
  for (const s of state.sessions.values()) {
    if (s.workspaceId !== workspaceId) continue;
    if (agentId !== "*" && s.agentId !== agentId) continue;
    const rating = (s.metadata as Record<string, unknown>)?.outcomeRating as string | undefined;
    const score = ratingToScore(rating);
    if (score === null) continue;
    results.push({
      sessionId: s.id,
      score,
      promptVersionId: s.activePromptVersionId ?? null,
      createdAt: s.openedAt,
    });
  }
  return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
}

export async function computeCandidateAbScore(
  state: InMemoryStorageState,
  workspaceId: string,
  agentId: string,
  promptVersionId: string
): Promise<number | null> {
  const ratingToScore = (r: string | undefined): number | null => {
    if (r === "success") return 1.0;
    if (r === "failure") return 0.0;
    if (r === "neutral") return 0.5;
    return null;
  };
  const scores: number[] = [];
  for (const s of state.sessions.values()) {
    if (s.workspaceId !== workspaceId) continue;
    if (agentId !== "*" && s.agentId !== agentId) continue;
    if ((s.activePromptVersionId ?? null) !== promptVersionId) continue;
    const rating = (s.metadata as Record<string, unknown>)?.outcomeRating as string | undefined;
    const score = ratingToScore(rating);
    if (score === null) continue;
    scores.push(score);
  }
  if (scores.length === 0) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
