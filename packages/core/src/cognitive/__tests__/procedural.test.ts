/**
 * RSN-2 — unit tests for runProceduralOptimization (spec §14).
 *
 * These tests cover the main cases for the metaprompt optimization loop
 * exercising all skip paths and the happy-path candidate creation.
 */
import { describe, it, expect, vi } from "vitest";
import { runProceduralOptimization, MIN_SAMPLE_SESSIONS } from "../procedural.js";
import type { StorageAdapter, LLMAdapter, LLMInput } from "@mnemo-ai/types";

// ─── Fake factory helpers ─────────────────────────────────────────────────────

function fakeStorage(over: Record<string, unknown> = {}): StorageAdapter {
  return {
    getWorkspaceMonthlySpendUsd: vi.fn(async () => 1.0),
    listScoredTrajectories: vi.fn(async () => [
      { sessionId: "s1", score: 0.9, promptVersionId: null, createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
      { sessionId: "s2", score: 0.85, promptVersionId: null, createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
      { sessionId: "s3", score: 0.2, promptVersionId: null, createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
    ]),
    createPromptVersion: vi.fn(async () => ({ id: "pv_test_1" })),
    ...over,
  } as unknown as StorageAdapter;
}

function fakeLlm(delta = "Be more concise."): LLMAdapter {
  return {
    generateStructured: vi.fn(
      async (_input: unknown, opts: { parse: (d: unknown) => unknown }) =>
        opts.parse({ delta, rationale: "high sessions were terse", confidence: 0.8 }),
    ),
  } as unknown as LLMAdapter;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runProceduralOptimization (spec §14)", () => {
  it("skips when monthly spend is below the budget gate", async () => {
    const storage = fakeStorage({
      getWorkspaceMonthlySpendUsd: vi.fn(async () => 0.001),
    });
    const result = await runProceduralOptimization(storage, fakeLlm(), "ws1", "agent1");
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/below_gate/);
  });

  it("skips when there are no scored trajectories", async () => {
    const storage = fakeStorage({
      listScoredTrajectories: vi.fn(async () => []),
    });
    const result = await runProceduralOptimization(storage, fakeLlm(), "ws1", "agent1");
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("no_trajectories");
  });

  it("skips when there are insufficient high/low trajectory pairs (all high)", async () => {
    const storage = fakeStorage({
      listScoredTrajectories: vi.fn(async () => [
        { sessionId: "s1", score: 0.9, promptVersionId: null, createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
        { sessionId: "s2", score: 0.95, promptVersionId: null, createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
        { sessionId: "s3", score: 0.88, promptVersionId: null, createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
      ]),
    });
    const result = await runProceduralOptimization(storage, fakeLlm(), "ws1", "agent1");
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/insufficient_pairs/);
  });

  it("skips when createPromptVersion is not present on the storage adapter", async () => {
    const storage = fakeStorage({ createPromptVersion: undefined });
    const result = await runProceduralOptimization(storage, fakeLlm(), "ws1", "agent1");
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("createPromptVersion_not_implemented");
  });

  it("creates a candidate on a valid high/low split", async () => {
    const createPromptVersion = vi.fn(async () => ({ id: "pv_test_1" }));
    const storage = fakeStorage({ createPromptVersion });

    const result = await runProceduralOptimization(storage, fakeLlm(), "ws1", "agent1");

    expect(result.outcome).toBe("created");
    expect(result.promptVersionId).toBe("pv_test_1");
    expect(createPromptVersion).toHaveBeenCalledOnce();

    // avgScoreBefore should be the mean of the high trajectories (0.9 + 0.85) / 2 = 0.875
    const callArgs = (createPromptVersion.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    expect(callArgs.avgScoreAfter).toBeNull();
    expect(callArgs.status).toBe("candidate");
    expect(callArgs.avgScoreBefore as number).toBeCloseTo(0.875, 3);
  });

  it("skips when the LLM throws an error", async () => {
    const llm: LLMAdapter = {
      generateStructured: vi.fn(async () => {
        throw new Error("LLM service unavailable");
      }),
    } as unknown as LLMAdapter;

    const result = await runProceduralOptimization(fakeStorage(), llm, "ws1", "agent1");
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/llm_error/);
  });

  it("skips when listScoredTrajectories returns null", async () => {
    const storage = fakeStorage({
      listScoredTrajectories: vi.fn(async () => null),
    });
    const result = await runProceduralOptimization(storage, fakeLlm(), "ws1", "agent1");
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("no_trajectories");
  });

  it("skips when listScoredTrajectories is not implemented", async () => {
    const storage = fakeStorage({ listScoredTrajectories: undefined });
    const result = await runProceduralOptimization(storage, fakeLlm(), "ws1", "agent1");
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("no_trajectories");
  });

  it("respects a custom skipIfBudgetBelow threshold", async () => {
    const storage = fakeStorage({
      getWorkspaceMonthlySpendUsd: vi.fn(async () => 0.05),
    });
    // With a higher gate, a spend of 0.05 should skip
    const result = await runProceduralOptimization(storage, fakeLlm(), "ws1", "agent1", {
      skipIfBudgetBelow: 0.1,
    });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/below_gate/);
  });

  it("calls createPromptVersion with the correct workspaceId and agentId", async () => {
    const createPromptVersion = vi.fn(async () => ({ id: "pv_xyz" }));
    const storage = fakeStorage({ createPromptVersion });

    await runProceduralOptimization(storage, fakeLlm(), "workspace-42", "my-agent");

    expect((createPromptVersion.mock.calls as unknown[][])[0][0]).toMatchObject({
      workspaceId: "workspace-42",
      agentId: "my-agent",
      status: "candidate",
      algorithm: "metaprompt-v1",
    });
  });

  it("forces the Haiku model tier on the LLM call", async () => {
    const capturedInputs: LLMInput[] = [];
    const llm: LLMAdapter = {
      generateStructured: vi.fn(async (input: LLMInput, opts: { parse: (d: unknown) => unknown }) => {
        capturedInputs.push(input);
        return opts.parse({ delta: "x", rationale: "y", confidence: 0.9 });
      }),
    } as unknown as LLMAdapter;
    await runProceduralOptimization(fakeStorage(), llm, "ws1", "agent1");
    expect(capturedInputs[0]!.model).toBe("haiku");
  });

  it("caps maxTokens to 200 by default", async () => {
    const capturedInputs: LLMInput[] = [];
    const llm: LLMAdapter = {
      generateStructured: vi.fn(async (input: LLMInput, opts: { parse: (d: unknown) => unknown }) => {
        capturedInputs.push(input);
        return opts.parse({ delta: "x", rationale: "y", confidence: 0.9 });
      }),
    } as unknown as LLMAdapter;
    await runProceduralOptimization(fakeStorage(), llm, "ws1", "agent1");
    expect(capturedInputs[0]!.maxTokens).toBeLessThanOrEqual(200);
  });

  it("A/B sample size MIN_SAMPLE_SESSIONS is 10", () => {
    expect(MIN_SAMPLE_SESSIONS).toBe(10);
  });

  it("result carries costPerEvaluation on success", async () => {
    const result = await runProceduralOptimization(fakeStorage(), fakeLlm(), "ws1", "agent1");
    expect(result.outcome).toBe("created");
    expect(typeof result.costPerEvaluation).toBe("number");
    expect(result.costPerEvaluation!).toBeCloseTo(200 * 0.000_001_25, 10);
  });
});
