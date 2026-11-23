import { describe, it, expect, vi } from "vitest";
import { applySelfEdit, revertSelfEdit, DEFAULT_SELF_EDIT_POLICY } from "../self-edit.js";
import type { SelfEditContext } from "../self-edit.js";

function makeCtx(initialStatement: string) {
  const fact = { id: "fact-1", workspaceId: "ws1", statement: initialStatement, status: "active", validTo: undefined as Date | undefined };
  const storage = {
    getFact: vi.fn(async () => ({ ...fact })),
    updateFact: vi.fn(async (_id: string, _workspaceId: string, patch: { statement?: string }) => {
      if (patch.statement !== undefined) fact.statement = patch.statement;
      return { ...fact };
    }),
    appendOutbox: vi.fn(async () => undefined),
  } as any;
  const ctx: SelfEditContext = {
    storage,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    telemetry: { startSpan: () => ({ end: () => {} }) } as any,
  };
  return { ctx, storage, fact };
}

describe("WP14.6 — self-edit undo window (spec §13 editGracePeriod)", () => {
  it("reverts an append within the undo window, restoring the pre-edit content", async () => {
    const { ctx, fact } = makeCtx("original statement");
    await applySelfEdit(ctx, {
      workspaceId: "ws1", agentId: "agent-1", action: "append", target: "fact-1",
      content: "edited statement", reason: "test",
    });
    expect(fact.statement).toBe("original statement\nedited statement");

    const reverted = await revertSelfEdit(ctx, "fact-1", {
      workspaceId: "ws1", undoWindowSeconds: DEFAULT_SELF_EDIT_POLICY.undoWindowSeconds, now: Date.now(), // determinism-ok: window check; exact value not asserted
    });
    expect(reverted).toBe(true);
    expect(fact.statement).toBe("original statement");
  });

  it("refuses to revert after the undo window has elapsed", async () => {
    const { ctx, fact } = makeCtx("original statement");
    const editedAt = 1_000_000;
    await applySelfEdit(ctx, {
      workspaceId: "ws1", agentId: "agent-1", action: "append", target: "fact-1",
      content: "more", reason: "test", now: editedAt,
    } as any);
    const afterStatement = fact.statement;

    const reverted = await revertSelfEdit(ctx, "fact-1", {
      workspaceId: "ws1",
      undoWindowSeconds: 30,
      now: editedAt + 31_000, // 31s later — window is 30s
    });
    expect(reverted).toBe(false);
    expect(fact.statement).toBe(afterStatement); // unchanged
  });

  it("returns false when there is no snapshot for the target", async () => {
    const { ctx } = makeCtx("original");
    const reverted = await revertSelfEdit(ctx, "never-edited", {
      workspaceId: "ws1", undoWindowSeconds: 300, now: Date.now(), // determinism-ok: window check; exact value not asserted
    });
    expect(reverted).toBe(false);
  });
});
