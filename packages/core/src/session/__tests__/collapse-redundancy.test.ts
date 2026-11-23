/**
 * LIFECYCLE-13 / LIFECYCLE-10 — the pipeline half of "the same knowledge two or
 * three times" and "chit-chat becomes memory".
 *
 * Measured with a 4B model: 69 rows for 27 keep-worthy items (fact + decision +
 * strategy for one rule), invented strategies, and a chit-chat session that
 * passed the RecMem gate (0.638 vs 0.637 for a real session) and produced five
 * junk rows. Invention, language drift and the gate's lack of separation with
 * bge-m3 are model/embedder behaviour; what the pipeline owns is the prompt
 * asking for three overlapping lists with no permission to return nothing, and
 * no exact-duplicate check across lists or across sessions.
 */
import { describe, it, expect } from "vitest";
import type { SessionTurn } from "@mnemo-ai/types";
import { buildCollapsePrompt, collapseSession } from "../collapse.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

const input = { sessionId: "s1", workspaceId: "ws", reason: "explicit" as const };

describe("LIFECYCLE-13 — the prompt", () => {
  const prompt = buildCollapsePrompt([
    { id: "t", turnIndex: 0, role: "user", content: "x" } as unknown as SessionTurn,
  ]);

  it("asks for one representation per piece of knowledge", () => {
    expect(prompt).toMatch(/exactly ONE of facts, decisions or strategies/);
  });

  it("forbids invented strategies and content", () => {
    expect(prompt).toMatch(/never invent/i);
  });

  it("names topic keys by subject and attribute, never by value", () => {
    expect(prompt).toMatch(/subject and the attribute/);
  });
});

describe("LIFECYCLE-10 — nothing durable is a valid answer", () => {
  it("tells the model to return empty lists for small talk", () => {
    const prompt = buildCollapsePrompt([
      { id: "t", turnIndex: 0, role: "user", content: "x" } as unknown as SessionTurn,
    ]);
    expect(prompt).toMatch(/nothing worth remembering[\s\S]*empty/i);
  });

  it("an empty extraction completes with an episode and no rows", async () => {
    const h = makeHarness({ replies: [reply({ goal: "small talk", outcome: "abandoned" })] });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(result.factsCreated + result.decisionsCreated + result.strategiesCreated).toBe(0);
    expect(h.episodes).toHaveLength(1);
  });
});

describe("LIFECYCLE-13 — exact duplicates", () => {
  it("drops a fact that only restates a decision", async () => {
    const h = makeHarness({
      replies: [
        reply({
          facts: [
            { content: "Deploy ledger-api with Argo CD" },
            { content: "ledger-api runs on Kubernetes" },
          ],
          decisions: [
            {
              title: "Deploy ledger-api with Argo CD",
              body: "GitOps audit trail",
              kind: "decision",
            },
          ],
        }),
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.factsCreated).toBe(1);
    expect(h.activeFacts().map((f) => f.statement)).toEqual(["ledger-api runs on Kubernetes"]);
    expect(result.decisionsCreated).toBe(1);
  });

  it("does not create a strategy that already exists word for word", async () => {
    const h = makeHarness({
      seedStrategies: [{ trigger: "A deploy fails", action: "Roll back before debugging" }],
      replies: [
        reply({
          strategies: [
            { trigger: "a deploy fails", action: "roll back before debugging" },
            { trigger: "a token is revoked", action: "delete it from Redis" },
          ],
        }),
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.strategiesCreated).toBe(1);
    expect(h.strategies.map((st) => st.trigger)).toEqual(["A deploy fails", "a token is revoked"]);
  });
});
