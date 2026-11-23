/**
 * Two production failures seen the first time the collapse reached Claude
 * Haiku 4.5 on Bedrock (2026-10-12):
 *
 *   1. Haiku answered with the JSON in a ```json fence followed by a paragraph
 *      of explanation, and `collapse.summary` rejected the whole reply.
 *   2. Every persisted fact produced an extra `vector_upsert` outbox job with
 *      only `{ id, kind }`. The worker rejected it ("payload has neither vector
 *      nor text") until the reaper dead-lettered it. The repository's own job,
 *      enqueued inside createFact / mergeFactByTopicKey, already carries the text.
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

const TURNS = Array.from({ length: 6 }, (_, i) => ({
  id: `t${i}`,
  workspaceId: "ws",
  sessionId: "s1",
  turnIndex: i,
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  content: `turn ${i} about deploying the chatbot through GitLab CI`,
  createdAt: new Date(), // determinism-ok: throwaway fixture, not asserted
  pinned: false,
}));

const SUMMARY = {
  goal: "deploy the chatbot",
  outcome: "resolved",
  facts: [{ content: "The chatbot deploys through GitLab CI", confidence: 0.9 }],
  decisions: [],
  strategies: [],
  llmTokensUsed: 10,
};

function harness(reply: string, finishReason: "stop" | "length" = "stop") {
  const append = vi.fn(async () => {});
  const generate = vi.fn(async (_input: { maxTokens?: number }) => ({
    content: reply,
    tokensUsed: { input: 10, output: 10 },
    finishReason,
  }));
  const error = vi.fn();
  const createFact = vi.fn(async (i: unknown) => ({ id: "f1", ...(i as object) }));
  const ctx = {
    config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error,
      child() {
        return this;
      },
    },
    embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
    vector: { search: async () => [] },
    llm: { generate },
    cache: null,
    outbox: { append },
    storage: {
      getSession: async () => ({
        id: "s1",
        workspaceId: "ws",
        agentId: "a",
        status: "active" as const,
        turnCount: TURNS.length,
        tokenCount: 120,
        openedAt: new Date(), // determinism-ok: throwaway fixture, not asserted
        metadata: {},
      }),
      listTurns: async () => TURNS,
      createFact,
      mergeFactByTopicKey: async () => null,
      createDecision: async () => ({ id: "d" }),
      createStrategy: async () => ({ id: "st" }),
      createRelation: async () => ({ id: "r" }),
      closeSession: async () => {},
      listSessionTopicKeysBySource: async () => [],
    },
  } as unknown as CoreContext;
  return { ctx, append, createFact, generate, error };
}

const run = (ctx: CoreContext) =>
  collapseSession(
    { sessionId: "s1", workspaceId: "ws", agentId: "a", reason: "max_turns" },
    ctx,
    auth
  );

describe("collapse against Claude Haiku 4.5 replies", () => {
  it("extracts from a fenced reply followed by an explanation", async () => {
    const reply =
      "```json\n" +
      JSON.stringify(SUMMARY, null, 2) +
      "\n```\n\nI extracted one fact about the deployment pipeline.";
    const { ctx, createFact } = harness(reply);
    const result = await run(ctx);
    expect(result.status).toBe("completed");
    expect(result.factsCreated).toBe(1);
    expect(createFact).toHaveBeenCalledOnce();
  });

  it("leaves the vector job to the repository instead of enqueueing an empty one", async () => {
    const { ctx, append } = harness(JSON.stringify(SUMMARY));
    await run(ctx);
    const vectorJobs = append.mock.calls.filter(
      ([event]) => (event as { eventType?: string }).eventType === "vector_upsert"
    );
    expect(vectorJobs).toEqual([]);
  });
});

describe("collapse summaries of long sessions", () => {
  it("gives the summary room for a session with hundreds of turns", async () => {
    // 2048 output tokens cut every long-session summary mid-JSON in production.
    const { ctx, generate } = harness(JSON.stringify(SUMMARY));
    await run(ctx);
    expect(generate.mock.calls[0]![0].maxTokens).toBeGreaterThanOrEqual(16384);
  });

  it("names a truncated reply as truncated instead of as invalid JSON", async () => {
    const { ctx, error } = harness('```json\n{\n  "goal": "deploy', "length");
    const result = await run(ctx);
    expect(result.status).toBe("failed");
    const message = (error.mock.calls[0]![1] as { error: { message: string } }).error.message;
    expect(message).toMatch(/truncated/);
  });
});
