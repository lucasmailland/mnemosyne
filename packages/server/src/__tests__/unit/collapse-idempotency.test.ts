import { describe, it, expect, vi } from "vitest";
import type { RecoveryPoint } from "../../idempotency.js";

/**
 * We test the phase-recording logic in isolation by replicating the exact
 * control flow the route uses (the route delegates to a helper we extract in
 * Step 3: collapseWithPhases). The helper records session_locked BEFORE the
 * core call, llm_called + facts_persisted AFTER a successful core call, and
 * short-circuits when the starting recovery point is already facts_persisted.
 */
import { buildCollapseAuditDetail, collapseWithPhases } from "../../routes/_collapsePhases.js";

function fakeRecorder() {
  const phases: RecoveryPoint[] = [];
  return {
    phases,
    record: async (p: RecoveryPoint) => {
      phases.push(p);
    },
  };
}

describe("collapse idempotency phases (spec §RDD9 lines 3954-3968)", () => {
  it("records session_locked → llm_called → facts_persisted on a fresh run", async () => {
    const rec = fakeRecorder();
    const core = {
      collapseSession: vi.fn(async () => ({ status: "completed", turnsProcessed: 5 })),
    };
    const out = await collapseWithPhases({
      startRecoveryPoint: "started",
      recordPhase: rec.record,
      runCollapse: () => core.collapseSession({ sessionId: "s1", workspaceId: "ws1" }),
    });
    expect(core.collapseSession).toHaveBeenCalledTimes(1);
    expect(rec.phases).toEqual(["session_locked", "llm_called", "facts_persisted"]);
    expect(out.resumed).toBe(false);
    expect(out.result?.turnsProcessed).toBe(5);
  });

  it("short-circuits (does NOT re-run collapse) when retry resumes at facts_persisted", async () => {
    const rec = fakeRecorder();
    const core = {
      collapseSession: vi.fn(async () => ({ status: "completed", turnsProcessed: 5 })),
    };
    const out = await collapseWithPhases({
      startRecoveryPoint: "facts_persisted",
      recordPhase: rec.record,
      runCollapse: () => core.collapseSession({ sessionId: "s1", workspaceId: "ws1" }),
    });
    expect(core.collapseSession).not.toHaveBeenCalled();
    expect(rec.phases).toEqual([]); // nothing new to record
    expect(out.resumed).toBe(true);
  });

  it("does NOT record llm_called/facts_persisted if collapse throws after session_locked", async () => {
    const rec = fakeRecorder();
    const boom = new Error("LLM down");
    await expect(
      collapseWithPhases({
        startRecoveryPoint: "started",
        recordPhase: rec.record,
        runCollapse: () => {
          throw boom;
        },
      })
    ).rejects.toThrow("LLM down");
    expect(rec.phases).toEqual(["session_locked"]); // crashed mid-way; last recovery point persisted
  });

  it("is a no-op recorder path when recordPhase is undefined (unkeyed request)", async () => {
    const core = {
      collapseSession: vi.fn(async () => ({ status: "completed", turnsProcessed: 2 })),
    };
    const out = await collapseWithPhases({
      startRecoveryPoint: undefined,
      recordPhase: undefined,
      runCollapse: () => core.collapseSession({ sessionId: "s1", workspaceId: "ws1" }),
    });
    expect(core.collapseSession).toHaveBeenCalledTimes(1);
    expect(out.resumed).toBe(false);
  });

  const base = { operationId: "op1", attempt: 1, reason: "manual", startedAt: 100, now: 150 };

  it("skipped records no llm_called/facts_persisted and a truthful skip record", async () => {
    const rec = fakeRecorder();
    const out = await collapseWithPhases({
      startRecoveryPoint: "started",
      recordPhase: rec.record,
      runCollapse: async () => ({
        status: "skipped",
        skipReason: "too_few_turns",
        turnsProcessed: 1,
      }),
    });
    expect(rec.phases).toEqual(["session_locked"]);
    expect(out.outcome).toBe("skipped");
    const d = buildCollapseAuditDetail({ ...base, outcome: out.outcome, result: out.result });
    expect(d).toMatchObject({
      status: "skipped",
      skipReason: "too_few_turns",
      error: null,
      model: null,
      promptVersion: null,
      tokens: null,
      segment: null,
      episodeId: null,
      durationMs: 50,
    });
  });

  it("completed, resumed and thrown outcomes are truthful; resume does not replay", async () => {
    const done = await collapseWithPhases({
      startRecoveryPoint: "started",
      recordPhase: undefined,
      runCollapse: async () => ({
        status: "completed",
        llmTokensUsed: 7,
        episodeId: "e1",
        turnsProcessed: 3,
      }),
    });
    expect(done.outcome).toBe("completed");
    expect(
      buildCollapseAuditDetail({ ...base, outcome: done.outcome, result: done.result })
    ).toMatchObject({
      status: "completed",
      skipReason: null,
      tokens: 7,
      episodeId: "e1",
      turns: 3,
    });

    const run = vi.fn(async () => ({ status: "completed" }));
    const res = await collapseWithPhases({
      startRecoveryPoint: "completed",
      recordPhase: undefined,
      runCollapse: run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(res.outcome).toBe("resumed");
    expect(buildCollapseAuditDetail({ ...base, attempt: 2, outcome: res.outcome }).status).toBe(
      "resumed"
    );

    const failed = buildCollapseAuditDetail({
      ...base,
      outcome: "failed",
      error: new Error("LLM down"),
    });
    expect(failed).toMatchObject({ status: "failed", error: "Error", tokens: null });
  });

  it("never persists raw (SQL + parameters) error messages into audit detail", () => {
    const pgErr = Object.assign(new Error("connection terminated"), { code: "57P01" });
    const drizzleErr = new Error(
      "Failed query: insert into mnemo_fact values ($1) params: SECRET_STATEMENT",
      { cause: pgErr }
    );
    const d = buildCollapseAuditDetail({ ...base, outcome: "failed", error: drizzleErr });
    expect(JSON.stringify(d)).not.toContain("SECRET_STATEMENT");
    expect(JSON.stringify(d)).not.toContain("insert into");
    expect(d.error).toBe("Error:57P01");
    expect(
      buildCollapseAuditDetail({ ...base, outcome: "failed", error: "raw SECRET" }).error
    ).toBe("Error");
  });

  it("never leaks raw turns/transcript into audit detail", () => {
    const d = buildCollapseAuditDetail({
      ...base,
      outcome: "completed",
      result: { status: "completed", turns: [{ content: "SECRET" }], transcript: "SECRET" },
    });
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });
});
