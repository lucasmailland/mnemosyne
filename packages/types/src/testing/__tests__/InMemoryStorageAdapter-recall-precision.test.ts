// harden-hooks-and-measure-precision (Slice 4, A2-read, Requirement 5/6, task 4.6).
//
// Exercises the actual precision-at-k computation (not just SQL text — see
// packages/adapter-postgres/src/__tests__/unit/recall-repository-boundaries.test.ts
// for the Postgres-side query-shape assertions) against InMemoryStorageAdapter,
// which mirrors the same "credited" definition documented in design.md.
import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

/** Record one served hit, mirroring recall-cold.ts's recordRecall call shape. */
async function recordHit(
  adapter: InMemoryStorageAdapter,
  workspaceId: string,
  factId: string,
  sessionId: string,
  hitRank: number
): Promise<void> {
  await adapter.recordRecall({
    workspaceId,
    factId,
    sessionId,
    hitRank,
    tdCredit: Math.pow(0.7, hitRank),
    activationScore: 1,
  });
}

describe("InMemoryStorageAdapter — getRecallPrecision (recall-precision-report)", () => {
  it("returns insufficient-data (null precision, zero sample size) for an empty workspace", async () => {
    const adapter = new InMemoryStorageAdapter();

    const report = await adapter.getRecallPrecision(WS_A);

    expect(report.insufficientData).toBe(true);
    expect(report.totalHits).toBe(0);
    expect(report.pendingHits).toBe(0);
    for (const entry of report.precisionAtK) {
      expect(entry.precision).toBeNull();
      expect(entry.sampleSize).toBe(0);
    }
    expect(report.methodologyNote).toMatch(/coarse/i);
  });

  it("excludes hits from a session that never collapsed — pending, not a failure", async () => {
    const adapter = new InMemoryStorageAdapter();
    const session = await adapter.createSession({ workspaceId: WS_A });
    const fact = await adapter.createFact({
      workspaceId: WS_A,
      statement: "pending session fact",
      subject: "ws",
      kind: "trait",
      scope: "global",
      attribution: "objective_fact",
    });
    await recordHit(adapter, WS_A, fact.id, session.id, 0);
    // Session is never closed/collapsed.

    const report = await adapter.getRecallPrecision(WS_A);

    expect(report.totalHits).toBe(1);
    expect(report.pendingHits).toBe(1);
    expect(report.insufficientData).toBe(true);
    for (const entry of report.precisionAtK) {
      expect(entry.sampleSize).toBe(0);
      expect(entry.precision).toBeNull();
    }
  });

  it("yields the expected precision for a workspace with known recall+collapse history", async () => {
    const adapter = new InMemoryStorageAdapter();

    // Session 1: collapses and creates a fact — its 2 recalled predecessor
    // hits (rank 0, rank 1) both fall inside the top-20 window and get credit.
    const session1 = await adapter.createSession({ workspaceId: WS_A });
    const predecessor1 = await adapter.createFact({
      workspaceId: WS_A,
      statement: "predecessor 1",
      subject: "ws",
      kind: "trait",
      scope: "global",
      attribution: "objective_fact",
    });
    const predecessor2 = await adapter.createFact({
      workspaceId: WS_A,
      statement: "predecessor 2",
      subject: "ws",
      kind: "trait",
      scope: "global",
      attribution: "objective_fact",
    });
    await recordHit(adapter, WS_A, predecessor1.id, session1.id, 0);
    await recordHit(adapter, WS_A, predecessor2.id, session1.id, 1);
    // Collapse creates a fact attributed to this session (factCount > 0 proxy).
    await adapter.createFact({
      workspaceId: WS_A,
      statement: "created by session 1",
      subject: "ws",
      kind: "trait",
      scope: "global",
      attribution: "objective_fact",
      sessionId: session1.id,
    });
    await adapter.closeSession(session1.id, WS_A);

    // Session 2: collapses but creates NO fact — its one hit (rank 0) is in a
    // resolved session (counts in the denominator) but is never credited.
    const session2 = await adapter.createSession({ workspaceId: WS_A });
    const uncredited = await adapter.createFact({
      workspaceId: WS_A,
      statement: "uncredited",
      subject: "ws",
      kind: "trait",
      scope: "global",
      attribution: "objective_fact",
    });
    await recordHit(adapter, WS_A, uncredited.id, session2.id, 0);
    await adapter.closeSession(session2.id, WS_A);

    const report = await adapter.getRecallPrecision(WS_A);

    // k=1: 2 hits at rank < 1 in resolved sessions (session1 rank0, session2
    // rank0); 1 credited (session1's rank0) → precision 0.5.
    const k1 = report.precisionAtK.find((p) => p.k === 1)!;
    expect(k1.sampleSize).toBe(2);
    expect(k1.precision).toBeCloseTo(0.5);

    // k=3 and k=5: 3 hits total in resolved sessions; 2 credited (session1's
    // rank0+rank1) → precision 2/3.
    for (const k of [3, 5]) {
      const entry = report.precisionAtK.find((p) => p.k === k)!;
      expect(entry.sampleSize).toBe(3);
      expect(entry.precision).toBeCloseTo(2 / 3);
    }

    expect(report.insufficientData).toBe(false);
    expect(report.totalHits).toBe(3);
    expect(report.pendingHits).toBe(0);
  });

  it("caps credit at the 20-most-recently-recalled window, mirroring getTdPredecessors", async () => {
    const adapter = new InMemoryStorageAdapter();
    const session = await adapter.createSession({ workspaceId: WS_A });

    // 25 hits recorded in order; only the 20 most recent are creditable.
    const factIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const fact = await adapter.createFact({
        workspaceId: WS_A,
        statement: `fact ${i}`,
        subject: "ws",
        kind: "trait",
        scope: "global",
        attribution: "objective_fact",
      });
      factIds.push(fact.id);
      await recordHit(adapter, WS_A, fact.id, session.id, 0);
    }
    await adapter.createFact({
      workspaceId: WS_A,
      statement: "created",
      subject: "ws",
      kind: "trait",
      scope: "global",
      attribution: "objective_fact",
      sessionId: session.id,
    });
    await adapter.closeSession(session.id, WS_A);

    const report = await adapter.getRecallPrecision(WS_A);
    // All 25 hits share hitRank 0, so k=1/3/5 all see the same 25-hit sample —
    // exactly 20 of the 25 (the most recently recorded) are credited.
    for (const k of [1, 3, 5]) {
      const entry = report.precisionAtK.find((p) => p.k === k)!;
      expect(entry.sampleSize).toBe(25);
      expect(entry.precision).toBeCloseTo(20 / 25);
    }
  });

  it("holds workspace isolation — a report for WS_A never reflects WS_B's history", async () => {
    const adapter = new InMemoryStorageAdapter();

    const sessionB = await adapter.createSession({ workspaceId: WS_B });
    const factB = await adapter.createFact({
      workspaceId: WS_B,
      statement: "other workspace fact",
      subject: "ws",
      kind: "trait",
      scope: "global",
      attribution: "objective_fact",
    });
    await recordHit(adapter, WS_B, factB.id, sessionB.id, 0);
    await adapter.createFact({
      workspaceId: WS_B,
      statement: "created in B",
      subject: "ws",
      kind: "trait",
      scope: "global",
      attribution: "objective_fact",
      sessionId: sessionB.id,
    });
    await adapter.closeSession(sessionB.id, WS_B);

    const reportA = await adapter.getRecallPrecision(WS_A);
    const reportB = await adapter.getRecallPrecision(WS_B);

    expect(reportA.totalHits).toBe(0);
    expect(reportA.insufficientData).toBe(true);
    expect(reportB.totalHits).toBe(1);
    expect(reportB.insufficientData).toBe(false);
  });
});
