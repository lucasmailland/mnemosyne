import { describe, it, expect, vi } from "vitest";
import { applySelfEdit } from "../self-edit.js";
import type { SelfEditContext } from "../self-edit.js";
import type { ActorProvenance } from "@mnemo-ai/types";

/**
 * p50-audit-log-emitters (PR7, Phase 7, task 7.1): self_edit is emitted from
 * INSIDE core applySelfEdit — not at the route level — so both the HTTP
 * transport (routes/self.ts) and the gRPC transport (grpc.ts) are covered by
 * a single emitter (design D3). Gated on `req.provenance` being present so
 * every pre-existing caller/test that never threads a provenance triple
 * keeps compiling and passing unchanged (see self-edit-undo.test.ts,
 * self-edit-bitemporal-replace.test.ts, self-edit-link.test.ts — none of
 * their storage stubs implement appendAuditEntry).
 */
function makeCtx() {
  const fact = {
    id: "fact-1",
    workspaceId: "ws-1",
    statement: "original",
    status: "active",
    validTo: undefined as Date | undefined,
  };
  const strategy = { id: "strat-1", workspaceId: "ws-1", action: "old action" };
  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
  const storage = {
    getFact: vi.fn(async () => ({ ...fact })),
    updateFact: vi.fn(async (_id: string, _ws: string, patch: { statement?: string }) => {
      if (patch.statement !== undefined) fact.statement = patch.statement;
      return { ...fact };
    }),
    replaceFact: vi.fn(async () => ({
      previous: { id: "fact-1" },
      replacement: { id: "fact-2" },
    })),
    getStrategy: vi.fn(async () => ({ ...strategy })),
    updateStrategy: vi.fn(async () => undefined),
    updateWorth: vi.fn(async () => undefined),
    archiveFact: vi.fn(async () => undefined),
    archiveStrategy: vi.fn(async () => undefined),
    getAgentProfile: vi.fn(async () => ({ workspaceId: "ws-1", agentId: "agent-1", summary: "" })),
    upsertAgentProfile: vi.fn(async () => undefined),
    appendOutbox: vi.fn(async () => undefined),
    // P111 — the §34.7 abuse flag now lands in mnemo_review_item instead of a
    // `self_edit_abuse_review` queue job that had no handler. Deliberately left
    // unguarded in production code: a security signal that cannot be recorded
    // must fail loudly, not be swallowed.
    enqueueReviewItem: vi.fn(async () => undefined),
    appendAuditEntry,
  } as any;
  const ctx: SelfEditContext = {
    storage,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    telemetry: { startSpan: () => ({ end: () => {} }) } as any,
  };
  return { ctx, storage, appendAuditEntry };
}

const provenance: ActorProvenance = {
  actorType: "agent",
  actorId: "key:agent-key-1",
  userId: "user-1",
};

describe("self_edit audit emission (p50 PR7)", () => {
  it("emits action:self_edit with the caller's provenance when req.provenance is present", async () => {
    const { ctx, appendAuditEntry } = makeCtx();

    await applySelfEdit(ctx, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      action: "append",
      target: "fact-1",
      content: "more",
      reason: "context",
      provenance,
    });

    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        actorType: "agent",
        actorId: "key:agent-key-1",
        action: "self_edit",
        resourceKind: "self_edit",
        resourceId: "fact-1",
        isTerminal: false,
        detail: expect.objectContaining({
          userId: "user-1",
          action: "append",
          targetKind: "fact",
          agentId: "agent-1",
        }),
      })
    );
  });

  it("does not emit and does not throw when req.provenance is absent (back-compat)", async () => {
    const { ctx, appendAuditEntry } = makeCtx();

    const outcome = await applySelfEdit(ctx, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      action: "append",
      target: "fact-1",
      content: "more",
      reason: "context",
    });

    expect(outcome.applied).toBe(true);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("uses agentId as resourceId for a profile target (ParsedTarget has no id)", async () => {
    const { ctx, appendAuditEntry } = makeCtx();

    await applySelfEdit(ctx, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      action: "replace",
      target: "profile",
      content: "new summary",
      reason: "update",
      provenance,
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKind: "self_edit",
        resourceId: "agent-1",
        detail: expect.objectContaining({ targetKind: "profile" }),
      })
    );
  });

  it("includes replacementId in detail for a replace action on a fact", async () => {
    const { ctx, appendAuditEntry } = makeCtx();

    await applySelfEdit(ctx, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      action: "replace",
      target: "fact-1",
      content: "corrected",
      reason: "correction",
      provenance,
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ replacementId: "fact-2" }),
      })
    );
  });

  it("includes abuseFlag in detail when evalResult flagged abuse", async () => {
    const { ctx, appendAuditEntry } = makeCtx();

    await applySelfEdit(ctx, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      action: "strengthen",
      target: "fact-1",
      reason: "verified",
      provenance,
      evalResult: { allow: true, countsAsEdit: true, countsAsDelete: false, abuseFlag: true },
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ abuseFlag: true }),
      })
    );
  });

  it("never emits action:self_edit for the reflect action (routed to runReflectionCycle instead)", async () => {
    const { ctx, appendAuditEntry } = makeCtx();

    await expect(
      applySelfEdit(ctx, {
        workspaceId: "ws-1",
        agentId: "agent-1",
        action: "reflect",
        target: "profile",
        reason: "n/a",
        provenance,
      })
    ).rejects.toThrow();

    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});
