import { describe, it, expect, vi } from "vitest";
import { buildKnowledgeScheduler, extractionPriority } from "../knowledge-scheduler.js";

describe("buildKnowledgeScheduler (spec §10, MEMORY_IMPROVEMENT.md:944-972)", () => {
  it("reproduces the spec example: 500 facts / 2 strategies / 0 workflows biases procedural", () => {
    const s = buildKnowledgeScheduler({ fact: 500, strategy: 2, workflow: 0 });
    // fact is hugely over-target → bias 0; workflow & strategy under-target → positive bias.
    expect(s.extractionBias.fact).toBe(0);
    expect(s.extractionBias.workflow).toBeGreaterThan(0);
    expect(s.extractionBias.strategy).toBeGreaterThan(0);
    // The single most underrepresented type ranks first.
    const order = extractionPriority(s);
    expect(order[0]!.bias).toBeGreaterThanOrEqual(order[1]!.bias);
    expect(order.every((o) => o.bias >= 0)).toBe(true);
  });

  it("zero total counts → all observed proportions 0 → bias equals target proportions", () => {
    const s = buildKnowledgeScheduler({});
    // With no observations every type's deficit == its target proportion (all > 0).
    expect(s.extractionBias.fact).toBeGreaterThan(0);
    expect(s.extractionBias.reasoning).toBeGreaterThan(0);
  });

  it("a type already at/above target gets zero bias", () => {
    // Make 'fact' the only type and over-represented; everything else is under.
    const s = buildKnowledgeScheduler({ fact: 1000 }, { fact: 1, decision: 0, strategy: 0, workflow: 0, skill: 0, episode: 0, entity: 0, task: 0, event: 0, reasoning: 0 });
    expect(s.extractionBias.fact).toBe(0);
  });

  it("extractionPriority returns most→least underrepresented", () => {
    const s = buildKnowledgeScheduler({ fact: 100, strategy: 1 });
    const order = extractionPriority(s);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.bias).toBeGreaterThanOrEqual(order[i]!.bias);
  });
});

import { collapseSession } from "../../session/collapse.js";

describe("collapse step-2 consults the UCE scheduler (spec §7:583)", () => {
  it("appends an under-representation bias hint to the extraction prompt", async () => {
    let capturedPrompt = "";
    const generate = vi.fn(async (req: any) => {
      capturedPrompt = req.messages[0].content;
      return { content: JSON.stringify({ goal: "", outcome: "resolved", facts: [], decisions: [], strategies: [] }), tokensUsed: { input: 1, output: 1 } };
    });
    const turns = [
      { role: "user", content: "set up CI pipeline step", turnIndex: 0 },
      { role: "user", content: "configure CI pipeline cache", turnIndex: 1 },
      { role: "user", content: "finalize CI pipeline deploy", turnIndex: 2 },
    ];
    const ctx = {
      storage: {
        getSession: async () => ({ id: "s1", workspaceId: "ws1", agentId: "a1" }),
        listTurns: async () => turns,
        getKnowledgeDistribution: async () => ({ fact: 500, strategy: 0, workflow: 0 }),
        createFact: async (f: any) => ({ id: "f1", ...f }),
        createDecision: async () => ({ id: "d1" }),
        createStrategy: async () => ({ id: "st1" }),
        createRelation: async () => ({}),
        closeSession: async () => {},
      },
      embed: { embed: async (xs: string[]) => xs.map(() => [1, 0.02, 0]) }, // near-parallel → high signal
      vector: { search: async () => [] },
      llm: { generate },
      outbox: { append: async () => {} },
      config: { surpriseThreshold: 0.3 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    } as any;

    await collapseSession({ sessionId: "s1", workspaceId: "ws1", reason: "explicit" }, ctx, { actorId: "system", actorType: "system", workspaceId: "ws1", scopes: [] } as any);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(capturedPrompt.toLowerCase()).toMatch(/strategy|workflow/);
    expect(capturedPrompt.toLowerCase()).toContain("under-represented");
  });
});
