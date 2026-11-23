import { describe, expect, it, vi } from "vitest";
import { FactRevisionConflictError } from "@mnemo-ai/types";
import {
  applySelfEdit,
  revertSelfEdit,
  SelfEditContentRequiredError,
  SelfEditTargetNotFoundError,
} from "../self-edit.js";

function makeCtx(replaceResult: unknown) {
  const source = {
    id: "fact-1",
    workspaceId: "ws-1",
    statement: "old",
    status: "active",
    validTo: undefined,
  };
  const storage = {
    getFact: vi.fn(async () => source),
    updateFact: vi.fn(async () => source),
    replaceFact: vi.fn(async () => replaceResult),
    appendOutbox: vi.fn(async () => undefined),
    getStrategy: vi.fn(async () => ({ id: "strat-1", action: "do x" })),
    updateStrategy: vi.fn(async () => undefined),
    getAgentProfile: vi.fn(async () => ({ summary: "profile" })),
    upsertAgentProfile: vi.fn(async () => undefined),
    enqueueReviewItem: vi.fn(async () => undefined),
    appendAuditEntry: vi.fn(async () => undefined),
  };
  return {
    storage,
    ctx: {
      storage,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      telemetry: { startSpan: () => ({ end() {} }) },
    } as never,
  };
}

describe("fact self-edit bitemporal replacement", () => {
  it("uses replaceFact and returns the successor id", async () => {
    const replacement = { id: "fact-2" };
    const { ctx, storage } = makeCtx({ previous: { id: "fact-1" }, replacement });

    const outcome = await applySelfEdit(ctx, {
      workspaceId: "ws-1",
      agentId: "editor-agent",
      requestedBy: "user-1",
      actorIsolationId: "owner-1",
      action: "replace",
      target: "fact-1",
      content: "new",
      reason: "correction",
    });

    expect(storage.replaceFact).toHaveBeenCalledWith({
      id: "fact-1",
      workspaceId: "ws-1",
      statement: "new",
      requestedBy: "user-1",
      agentId: "editor-agent",
      actorIsolationId: "owner-1",
    });
    expect(storage.updateFact).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ targetKind: "fact", replacementId: "fact-2" });
  });

  it("raises a dedicated target-not-found error when storage returns null", async () => {
    const { ctx } = makeCtx(null);

    await expect(
      applySelfEdit(ctx, {
        workspaceId: "ws-1",
        agentId: "editor-agent",
        action: "replace",
        target: "fact-1",
        content: "new",
        reason: "correction",
      })
    ).rejects.toBeInstanceOf(SelfEditTargetNotFoundError);
  });

  it("refuses stale fact undo when the target is closed", async () => {
    const { ctx, storage } = makeCtx({ previous: { id: "fact-1" }, replacement: { id: "fact-2" } });
    await applySelfEdit(ctx, {
      workspaceId: "ws-1",
      agentId: "editor-agent",
      action: "append",
      target: "fact-1",
      content: "more",
      reason: "context",
    });
    storage.getFact.mockResolvedValue({
      id: "fact-1",
      workspaceId: "ws-1",
      statement: "old\nmore",
      status: "forgotten",
      validTo: new Date(), // determinism-ok: test date
    });
    storage.updateFact.mockClear();

    await expect(
      revertSelfEdit(ctx, "fact-1", {
        workspaceId: "ws-1",
        undoWindowSeconds: 300,
      })
    ).resolves.toBe(false);
    expect(storage.updateFact).not.toHaveBeenCalled();
  });

  // PRIM-1: `replace` without content used to call replaceFact with `content ?? ""`,
  // closing the fact and leaving an EMPTY active successor. Append without
  // content reported `applied: true` and changed nothing. Both are now refused
  // before any read, mutation, review item or audit entry.
  describe.each(["replace", "append"] as const)("%s without usable content", (action) => {
    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["whitespace-only", "  \n\t "],
    ])("rejects %s content on every target kind and mutates nothing", async (_label, content) => {
      for (const target of ["fact-1", "strategy:strat-1", "profile"]) {
        const { ctx, storage } = makeCtx({ previous: { id: "fact-1" }, replacement: { id: "x" } });
        await expect(
          applySelfEdit(ctx, {
            workspaceId: "ws-1",
            agentId: "editor-agent",
            action,
            target,
            ...(content !== undefined ? { content } : {}),
            reason: "correction",
            evalResult: { allow: true, countsAsEdit: true, countsAsDelete: false, abuseFlag: true },
            provenance: { actorType: "agent", actorId: "key:k1", userId: null },
          })
        ).rejects.toBeInstanceOf(SelfEditContentRequiredError);
        expect(storage.replaceFact).not.toHaveBeenCalled();
        expect(storage.updateFact).not.toHaveBeenCalled();
        expect(storage.updateStrategy).not.toHaveBeenCalled();
        expect(storage.upsertAgentProfile).not.toHaveBeenCalled();
        expect(storage.enqueueReviewItem).not.toHaveBeenCalled();
        expect(storage.appendAuditEntry).not.toHaveBeenCalled();
      }
    });
  });

  it("keeps the supplied replacement text unchanged (no trimming)", async () => {
    const { ctx, storage } = makeCtx({ previous: { id: "fact-1" }, replacement: { id: "fact-2" } });
    await applySelfEdit(ctx, {
      workspaceId: "ws-1",
      agentId: "editor-agent",
      action: "replace",
      target: "fact-1",
      content: "  new text  ",
      reason: "correction",
    });
    expect(storage.replaceFact).toHaveBeenCalledWith(
      expect.objectContaining({ statement: "  new text  " })
    );
  });

  // CHAOS-8: append is read-modify-write. Two concurrent appends both read the
  // same text and the second UPDATE overwrote the first. The write is now
  // conditional on the revision that was read, and a conflict re-reads.
  it("conditions append on the revision it read and retries on a conflict", async () => {
    const { ctx, storage } = makeCtx(null);
    const rows = [
      { id: "fact-1", workspaceId: "ws-1", statement: "base", status: "active", revisionCount: 1 },
      {
        id: "fact-1",
        workspaceId: "ws-1",
        statement: "base\nfrom another writer",
        status: "active",
        revisionCount: 2,
      },
    ];
    storage.getFact.mockResolvedValueOnce(rows[0]).mockResolvedValueOnce(rows[1]);
    storage.updateFact
      .mockRejectedValueOnce(new FactRevisionConflictError("fact-1", 1, 2))
      .mockResolvedValueOnce({ ...rows[1], statement: "base\nfrom another writer\nmine" });

    await applySelfEdit(ctx, {
      workspaceId: "ws-1",
      agentId: "editor-agent",
      action: "append",
      target: "fact-1",
      content: "mine",
      reason: "context",
    });

    expect(storage.updateFact).toHaveBeenNthCalledWith(1, "fact-1", "ws-1", {
      statement: "base\nmine",
      expectedRevision: 1,
    });
    expect(storage.updateFact).toHaveBeenNthCalledWith(2, "fact-1", "ws-1", {
      statement: "base\nfrom another writer\nmine",
      expectedRevision: 2,
    });
  });
});
