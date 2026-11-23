/**
 * A collapse must not die on its own extraction.
 *
 * `mnemo_decision` carries a partial unique index:
 *
 *   uniq_mnemo_decision_topic ON (workspace_id, lower(btrim(topic_key)))
 *     WHERE topic_key IS NOT NULL AND status = 'active' AND valid_to IS NULL
 *
 * Two of the three write paths respect it. `remember()` catches 23505 and
 * re-merges; the fact loop inside this very function calls
 * `mergeFactByTopicKey` before falling back to `createFact`. The decision loop,
 * fifteen lines below the fact loop, called bare `createDecision`.
 *
 * So an LLM that emitted two decisions normalising to the same topic key —
 * ordinary behaviour, not a malfunction — produced this, observed on a live
 * stack:
 *
 *   client:  500 Internal server error
 *   session: status = collapsed        (so it cannot be retried)
 *   db:      2 of 3 decisions written  (and the caller is not told which)
 *
 * An error response, a partial write, and no way back. The turn's memories are
 * half-committed and the session is closed over them.
 */
import { describe, it, expect, vi } from "vitest";
import { collapseSession } from "../collapse.js";
import type { CoreContext } from "../../cognitive/context.js";
import type { AuthContext } from "@mnemo-ai/types";

const auth = {
  actorId: "system",
  actorType: "system",
  workspaceId: "ws",
  scopes: [],
} as unknown as AuthContext;

function makeTurns(n = 4) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    workspaceId: "ws",
    sessionId: "s1",
    turnIndex: i,
    role: i % 2 === 0 ? "user" : "assistant",
    content: i === n - 1 ? "thanks, that worked perfectly" : `message ${i}`,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    pinned: i === 0,
  }));
}

const DUPLICATE_KEY_ERROR =
  'duplicate key value violates unique constraint "uniq_mnemo_decision_topic"';

/**
 * A `createDecision` double that enforces the real partial unique index:
 * one active row per normalised topic key, per workspace.
 */
function makeCtx(
  decisions: Array<{ kind?: string; title: string; body: string; topicKey?: string }>
) {
  const activeTopicKeys = new Set<string>();
  const normalise = (k: string) => k.trim().toLowerCase();

  const createDecision = vi.fn(async (inp: Record<string, unknown>) => {
    const topicKey = inp.topicKey as string | undefined;
    if (topicKey !== undefined) {
      if (activeTopicKeys.has(normalise(topicKey))) throw new Error(DUPLICATE_KEY_ERROR);
      activeTopicKeys.add(normalise(topicKey));
    }
    return { id: `d-${String(topicKey ?? "anon")}`, revisionCount: 1, ...inp };
  });

  const mergeDecisionByTopicKey = vi.fn(async (inp: Record<string, unknown>) => {
    const topicKey = inp.topicKey as string | undefined;
    if (topicKey === undefined || !activeTopicKeys.has(normalise(topicKey))) return null;
    return { id: `d-${topicKey}`, revisionCount: 2, ...inp };
  });

  const summary = {
    goal: "configure infra",
    outcome: "resolved",
    facts: [],
    decisions,
    strategies: [],
    llmTokensUsed: 10,
  };

  const ctx = {
    config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
    embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
    vector: { search: async () => [] },
    llm: {
      generate: async () => ({
        content: JSON.stringify(summary),
        tokensUsed: { input: 10, output: 10 },
      }),
    },
    cache: null,
    outbox: { append: async () => {} },
    storage: {
      getSession: async () => ({
        id: "s1",
        workspaceId: "ws",
        agentId: "a",
        status: "active",
        turnCount: 4,
        tokenCount: 50,
        openedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        metadata: {},
      }),
      listTurns: async () => makeTurns(),
      createFact: async (inp: Record<string, unknown>) => ({ id: "f", ...inp }),
      mergeFactByTopicKey: async () => null,
      createDecision,
      mergeDecisionByTopicKey,
      createStrategy: async () => ({ id: "st" }),
      createRelation: async () => ({ id: "r" }),
      closeSession: async () => {},
      listSessionTopicKeysBySource: async () => [],
    },
  } as unknown as CoreContext;

  return { ctx, createDecision, mergeDecisionByTopicKey };
}

const run = (ctx: CoreContext) =>
  collapseSession(
    {
      sessionId: "s1",
      workspaceId: "ws",
      agentId: "a",
      reason: "max_turns",
      policy: { mode: "auto" },
    },
    ctx,
    auth
  );

describe("collapse: two extracted decisions sharing a topic key", () => {
  it("completes instead of throwing", async () => {
    const { ctx } = makeCtx([
      { kind: "decision", title: "Run ollama natively", body: "first", topicKey: "ollama" },
      { kind: "decision", title: "Ollama on the host", body: "second", topicKey: "ollama" },
    ]);

    const result = await run(ctx);

    expect(result.status).toBe("completed");
  });

  it("keeps both instead of letting the second overwrite the first", async () => {
    // LIFECYCLE-3: this used to merge the second INTO the first, which for a
    // decision merge is an in-place overwrite — the first decision was gone.
    // Two different decisions under one key mean the key is wrong, not that
    // one of them is.
    const { ctx, createDecision, mergeDecisionByTopicKey } = makeCtx([
      { kind: "decision", title: "Run ollama natively", body: "first", topicKey: "ollama" },
      { kind: "decision", title: "Ollama on the host", body: "second", topicKey: "ollama" },
    ]);

    const result = await run(ctx);

    expect(result.decisionsCreated).toBe(2);
    expect(mergeDecisionByTopicKey).not.toHaveBeenCalled();
    expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ body: "first" }));
    expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ body: "second" }));
  });

  it("does not lose the decisions that follow the collision", async () => {
    // The live failure aborted the whole loop on the collision, so anything the
    // LLM extracted after it was silently dropped.
    const { ctx, createDecision } = makeCtx([
      { kind: "decision", title: "Run ollama natively", body: "first", topicKey: "ollama" },
      { kind: "decision", title: "Ollama on the host", body: "second", topicKey: "ollama" },
      { kind: "architecture", title: "Docker exposes no GPU", body: "third", topicKey: "docker" },
    ]);

    const result = await run(ctx);

    expect(result.status).toBe("completed");
    expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ topicKey: "docker" }));
  });

  it("still creates decisions that carry no topic key", async () => {
    const { ctx, createDecision } = makeCtx([
      { kind: "decision", title: "Untitled A", body: "a" },
      { kind: "decision", title: "Untitled B", body: "b" },
    ]);

    const result = await run(ctx);

    expect(result.status).toBe("completed");
    expect(createDecision).toHaveBeenCalledTimes(2);
  });

  it("recovers when the collision surfaces as a 23505 race instead of a prior read", async () => {
    // mergeDecisionByTopicKey finds nothing (a concurrent writer inserted
    // between our read and our write), so the insert is the thing that fails.
    const { ctx } = makeCtx([
      { kind: "decision", title: "Run ollama natively", body: "first", topicKey: "ollama" },
    ]);
    const storage = (ctx as unknown as { storage: Record<string, unknown> }).storage;
    storage.mergeDecisionByTopicKey = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "d-ollama", revisionCount: 2 });
    storage.createDecision = vi.fn(async () => {
      throw new Error(DUPLICATE_KEY_ERROR);
    });

    const result = await run(ctx);

    expect(result.status).toBe("completed");
  });
});
