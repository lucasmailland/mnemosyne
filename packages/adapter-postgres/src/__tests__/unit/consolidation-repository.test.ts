import { describe, expect, it, vi } from "vitest";

import { ConsolidationRepository } from "../../repositories/ConsolidationRepository.js";

const WS = "11111111-1111-4111-8111-111111111111";
const LEASE = new Date("2026-07-17T12:15:00.000Z");

function sqlAsText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks.flatMap((chunk) => {
    const value = (chunk as { value?: unknown[] })?.value;
    return Array.isArray(value)
      ? value.filter((part): part is string => typeof part === "string")
      : [sqlAsText(chunk)];
  }).join(" ").replace(/\s+/g, " ").trim();
}

function makeRepository(
  state: "restored" | "pending" | "retained" | "divergent" = "restored",
  changedCount = 3,
) {
  const events: string[] = [];
  let rollbacks = 0;
  const hasMarker = state === "pending";
  const absorbedMerged = state === "pending" || state === "retained";
  const survivorMergedWorth = state !== "restored";
  const marker = {
    operationId: "operation-1",
    workspaceId: WS,
    survivorId: "survivor",
    absorbedFactIds: ["absorbed-b", "absorbed-a"],
    previousWorth: { alpha: 2.125, beta: 3.375, success: 0.125, failure: 1.375 },
    expectedMergedWorth: { alpha: 3.125, beta: 3.375, success: 1.125, failure: 1.375 },
    leaseExpiresAt: LEASE.toISOString(),
  };
  const participantRows = [
    {
      id: "absorbed-a", workspace_id: WS, status: absorbedMerged ? "merged" : "active",
      valid_to: absorbedMerged ? LEASE : null, merged_into_id: absorbedMerged ? "survivor" : null,
      metadata: hasMarker ? { absorbed: "a", __mnemoConsolidationPending: marker } : { absorbed: "a" }, worth_alpha: "2.0000", worth_beta: "2.0000",
      worth_success: "0.0000", worth_failure: "0.0000",
    },
    {
      id: "absorbed-b", workspace_id: WS, status: absorbedMerged ? "merged" : "active",
      valid_to: absorbedMerged ? LEASE : null, merged_into_id: absorbedMerged ? "survivor" : null,
      metadata: hasMarker ? { absorbed: "b", __mnemoConsolidationPending: marker } : { absorbed: "b" }, worth_alpha: "2.0000", worth_beta: "2.0000",
      worth_success: "0.0000", worth_failure: "0.0000",
    },
    {
      id: "survivor", workspace_id: WS, status: "active", valid_to: null,
      merged_into_id: null,
      metadata: hasMarker ? { survivor: "kept", __mnemoConsolidationPending: marker } : { survivor: "kept" },
      worth_alpha: survivorMergedWorth ? "3.1250" : "2.1250", worth_beta: "3.3750",
      worth_success: survivorMergedWorth ? "1.1250" : "0.1250", worth_failure: "1.3750",
    },
  ];
  const tx = {
    execute: vi.fn(async (query: unknown) => {
      const text = sqlAsText(query);
      events.push(text);
      if (text.includes("pg_has_role")) return [{ m: true }];
      if (text.includes("FOR UPDATE")) return participantRows;
      if (text.includes("RETURNING id")) return participantRows.slice(0, changedCount).map(({ id }) => ({ id }));
      return [];
    }),
  };
  const db = { transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => {
    try {
      return await fn(tx);
    } catch (error) {
      rollbacks += 1;
      throw error;
    }
  }) };
  return { repository: new ConsolidationRepository(db as never), events, getRollbacks: () => rollbacks };
}

describe("ConsolidationRepository apply/finalize", () => {
  it("sets safe transaction context, locks sorted participants, snapshots decimals, and emits no outbox", async () => {
    const { repository, events } = makeRepository();

    const snapshot = await repository.applyConsolidationMerge({
      operationId: "operation-1",
      workspaceId: WS,
      survivorId: "survivor",
      absorbedFactIds: ["absorbed-b", "absorbed-a"],
      leaseExpiresAt: LEASE,
    });

    expect(snapshot).toEqual({
      operationId: "operation-1",
      workspaceId: WS,
      survivorId: "survivor",
      absorbedFactIds: ["absorbed-b", "absorbed-a"],
      previousWorth: { alpha: 2.125, beta: 3.375, success: 0.125, failure: 1.375 },
      expectedMergedWorth: { alpha: 3.125, beta: 3.375, success: 1.125, failure: 1.375 },
    });
    const joined = events.join("\n");
    expect(events.findIndex((event) => event.includes("pg_has_role"))).toBeLessThan(
      events.findIndex((event) => event.includes("FROM mnemosyne.mnemo_fact") && event.includes("FOR UPDATE")),
    );
    expect(joined).toContain("SET LOCAL ROLE app_user");
    expect(joined).toContain("SET LOCAL search_path TO mnemosyne, public");
    expect(joined).toContain("app.workspace_id");
    expect(joined).toContain("mnemosyne.workspace_id");
    expect(joined).toContain("ORDER BY id FOR UPDATE");
    expect(joined).toContain("jsonb_set");
    expect(joined).toContain("__mnemoConsolidationPending");
    expect(joined).toContain("status = 'active'");
    expect(joined).toContain("valid_to IS NULL");
    expect(joined).toContain("ELSE 'merged'");
    expect(joined).toContain("merged_into_id");
    expect(joined).not.toContain("mnemo_outbox");
  });

  it("finalizes with participant CAS and an atomic optional replay boost", async () => {
    const { repository, events } = makeRepository("pending");
    const snapshot = {
      operationId: "operation-1",
      workspaceId: WS,
      survivorId: "survivor",
      absorbedFactIds: ["absorbed-b", "absorbed-a"],
      previousWorth: { alpha: 2.125, beta: 3.375, success: 0.125, failure: 1.375 },
      expectedMergedWorth: { alpha: 3.125, beta: 3.375, success: 1.125, failure: 1.375 },
    };

    await expect(repository.finalizeConsolidationMerge({
      snapshot,
      applyReplayBoost: true,
    })).resolves.toBe("finalized");

    const joined = events.join("\n");
    expect(joined).toContain("metadata - '");
    expect(joined).toContain("__mnemoConsolidationPending");
    expect(joined).toContain("operationId");
    expect(joined).toContain("worth_alpha");
    expect(joined).toContain("worth_beta");
    expect(joined).toContain("worth_success");
    expect(joined).toContain("worth_failure");
    expect(joined).toContain("status = 'merged'");
    expect(joined).toContain("valid_to IS NOT NULL");
    expect(joined).not.toContain("mnemo_outbox");
  });

  it("rolls back the transaction when finalize CAS updates only part of the cluster", async () => {
    const { repository, getRollbacks } = makeRepository("pending", 2);
    const snapshot = {
      operationId: "operation-1",
      workspaceId: WS,
      survivorId: "survivor",
      absorbedFactIds: ["absorbed-b", "absorbed-a"],
      previousWorth: { alpha: 2.125, beta: 3.375, success: 0.125, failure: 1.375 },
      expectedMergedWorth: { alpha: 3.125, beta: 3.375, success: 1.125, failure: 1.375 },
    };

    await expect(repository.finalizeConsolidationMerge({ snapshot, applyReplayBoost: false })).resolves.toBe("conflict");
    expect(getRollbacks()).toBe(1);
  });

  it("uses participant CAS for rollback, restores exact decimals, inserts raw baseline review, and emits no outbox", async () => {
    const { repository, events } = makeRepository("pending");
    const snapshot = {
      operationId: "operation-1",
      workspaceId: WS,
      survivorId: "survivor",
      absorbedFactIds: ["absorbed-b", "absorbed-a"],
      previousWorth: { alpha: 2.125, beta: 3.375, success: 0.125, failure: 1.375 },
      expectedMergedWorth: { alpha: 3.125, beta: 3.375, success: 1.125, failure: 1.375 },
    };

    await repository.rollbackConsolidationMerge({
      snapshot,
      review: {
        reason: "replay_validation_failed",
        passCount: 2,
        failCount: 3,
        queriesUsed: ["q1", "q2", "q3", "q4", "q5"],
      },
    });

    const joined = events.join("\n");
    expect(joined).toContain("metadata - '");
    expect(joined).toContain("__mnemoConsolidationPending");
    expect(joined).toContain("status = 'active'");
    expect(joined).toContain("valid_to = NULL");
    expect(joined).toContain("merged_into_id = NULL");
    expect(joined).toContain("worth_alpha");
    expect(joined).toContain("worth_beta");
    expect(joined).toContain("worth_success");
    expect(joined).toContain("worth_failure");
    expect(joined).toContain("INSERT INTO mnemosyne.mnemo_review_queue");
    expect(joined).toContain("(id, workspace_id, fact_id, reason)");
    expect(joined).toContain("'manual'");
    const reviewInsert = events.find((event) => event.includes("INSERT INTO mnemosyne.mnemo_review_queue"));
    expect(reviewInsert).not.toContain("metadata");
    expect(reviewInsert).not.toContain("detail");
    expect(joined).not.toContain("mnemo_outbox");
  });

  it("refreshes every participant marker and inspection locks every participant", async () => {
    const { repository, events } = makeRepository("pending");
    const snapshot = {
      operationId: "operation-1",
      workspaceId: WS,
      survivorId: "survivor",
      absorbedFactIds: ["absorbed-b", "absorbed-a"],
      previousWorth: { alpha: 2.125, beta: 3.375, success: 0.125, failure: 1.375 },
      expectedMergedWorth: { alpha: 3.125, beta: 3.375, success: 1.125, failure: 1.375 },
    };

    await repository.refreshConsolidationMergeLease({ snapshot, leaseExpiresAt: LEASE });
    await repository.inspectConsolidationMergeState(snapshot);

    const joined = events.join("\n");
    expect(joined).toContain("leaseExpiresAt");
    expect(joined).toContain("operationId");
    expect(joined).toContain("ORDER BY id FOR UPDATE");
    expect(joined).toContain("RETURNING id");
  });

  it.each([
    ["pending", "pending"],
    ["restored", "restored"],
    ["retained", "retained"],
    ["divergent", "divergent"],
  ] as const)("classifies %s durable rows as %s", async (fixtureState, expected) => {
    const { repository } = makeRepository(fixtureState);
    const snapshot = {
      operationId: "operation-1",
      workspaceId: WS,
      survivorId: "survivor",
      absorbedFactIds: ["absorbed-b", "absorbed-a"],
      previousWorth: { alpha: 2.125, beta: 3.375, success: 0.125, failure: 1.375 },
      expectedMergedWorth: { alpha: 3.125, beta: 3.375, success: 1.125, failure: 1.375 },
    };

    await expect(repository.inspectConsolidationMergeState(snapshot)).resolves.toBe(expected);
  });

  it("rechecks expiry after discovery and skips an operation refreshed before its locks", async () => {
    const expiredMarker = {
      operationId: "operation-expired",
      workspaceId: WS,
      survivorId: "survivor",
      absorbedFactIds: ["absorbed-a", "absorbed-b"],
      previousWorth: { alpha: 2.125, beta: 3.375, success: 0.125, failure: 1.375 },
      expectedMergedWorth: { alpha: 3.125, beta: 3.375, success: 1.125, failure: 1.375 },
      leaseExpiresAt: LEASE.toISOString(),
    };
    const refreshedMarker = {
      ...expiredMarker,
      leaseExpiresAt: "2026-07-17T12:15:00.001Z",
    };
    let transactionNumber = 0;
    const events: string[] = [];
    const db = {
      transaction: vi.fn(async (fn: (tx: { execute(query: unknown): Promise<unknown[]> }) => unknown) => {
        transactionNumber += 1;
        const tx = {
          execute: vi.fn(async (query: unknown) => {
            const text = sqlAsText(query);
            events.push(text);
            if (text.includes("pg_has_role")) return [{ m: true }];
            if (text.includes("DISTINCT")) {
              return [{ operation_id: "operation-expired", marker: expiredMarker }];
            }
            if (text.includes("FOR UPDATE")) {
              expect(transactionNumber).toBe(2);
              return [
                { id: "absorbed-a", workspace_id: WS, status: "merged", valid_to: LEASE, metadata: { __mnemoConsolidationPending: refreshedMarker }, worth_alpha: "2", worth_beta: "2", worth_success: "0", worth_failure: "0" },
                { id: "absorbed-b", workspace_id: WS, status: "merged", valid_to: LEASE, metadata: { __mnemoConsolidationPending: refreshedMarker }, worth_alpha: "2", worth_beta: "2", worth_success: "0", worth_failure: "0" },
                { id: "survivor", workspace_id: WS, status: "active", valid_to: null, metadata: { __mnemoConsolidationPending: refreshedMarker }, worth_alpha: "3.125", worth_beta: "3.375", worth_success: "1.125", worth_failure: "1.375" },
              ];
            }
            return [];
          }),
        };
        return fn(tx);
      }),
    };
    const repository = new ConsolidationRepository(db as never);

    await expect(repository.recoverExpiredConsolidationMerges({
      workspaceId: WS,
      expiredBefore: LEASE,
    })).resolves.toBe(0);
    expect(events.join("\n")).not.toContain("INSERT INTO mnemosyne.mnemo_review_queue");
  });
});
