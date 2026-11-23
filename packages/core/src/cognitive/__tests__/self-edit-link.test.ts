import { describe, it, expect, vi } from "vitest";
import { evaluateSelfEdit, applySelfEdit, DEFAULT_SELF_EDIT_POLICY } from "../self-edit.js";

describe("self-edit link action", () => {
  it("evaluateSelfEdit allows link and counts as edit", () => {
    const result = evaluateSelfEdit(
      { action: "link", target: "fact-a", reason: "r", editsThisSession: 0, deletesToday: 0 },
      DEFAULT_SELF_EDIT_POLICY,
    );
    expect(result.allow).toBe(true);
    expect(result.countsAsEdit).toBe(true);
  });

  it("evaluateSelfEdit blocks link when session budget exhausted", () => {
    const result = evaluateSelfEdit(
      { action: "link", target: "fact-a", reason: "r", editsThisSession: 5, deletesToday: 0 },
      DEFAULT_SELF_EDIT_POLICY,
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/maxEditsPerSession/);
  });

  it("applySelfEdit link calls createHyperedge with correct memberIds", async () => {
    const createHyperedge = vi.fn().mockResolvedValue({ id: "he-1" });
    const ctx = {
      storage: {
        createHyperedge,
        getFact: vi.fn().mockResolvedValue({ id: "fact-a", workspaceId: "ws-1", kind: "fact" }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      telemetry: { startSpan: vi.fn().mockReturnValue({ end: vi.fn(), setAttribute: vi.fn() }) },
    } as any;

    await applySelfEdit(ctx, {
      action: "link",
      target: "fact-a",
      content: "fact-b,fact-c",
      reason: "testing hyperedge",
      workspaceId: "ws-1",
      agentId: "agent-1",
    } as any);

    expect(createHyperedge).toHaveBeenCalledOnce();
    const args = createHyperedge.mock.calls[0][0];
    expect(args.memberIds).toContain("fact-a");
    expect(args.memberIds).toContain("fact-b");
    expect(args.memberIds).toContain("fact-c");
    expect(args.memberIds).toHaveLength(3);
  });

  it("applySelfEdit link throws when fewer than 3 members", async () => {
    const createHyperedge = vi.fn();
    const ctx = {
      storage: {
        createHyperedge,
        getFact: vi.fn().mockResolvedValue({ id: "fact-a", workspaceId: "ws-1", kind: "fact" }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      telemetry: { startSpan: vi.fn().mockReturnValue({ end: vi.fn(), setAttribute: vi.fn() }) },
    } as any;

    await expect(
      applySelfEdit(ctx, {
        action: "link",
        target: "fact-a",
        content: "fact-b", // only 2 total — should throw
        reason: "test",
        workspaceId: "ws-1",
        agentId: "agent-1",
      } as any),
    ).rejects.toThrow(/3/);
  });

  it("applySelfEdit link with extra whitespace in content works correctly", async () => {
    const createHyperedge = vi.fn().mockResolvedValue({ id: "he-2" });
    const ctx = {
      storage: { createHyperedge },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      telemetry: { startSpan: vi.fn().mockReturnValue({ end: vi.fn(), setAttribute: vi.fn() }) },
    } as any;

    await applySelfEdit(ctx, {
      action: "link",
      target: "fact-x",
      content: " fact-y , fact-z , fact-w ",
      reason: "multi-member test",
      workspaceId: "ws-1",
      agentId: "agent-1",
    } as any);

    const args = createHyperedge.mock.calls[0][0];
    expect(args.memberIds).toHaveLength(4);
    expect(args.memberIds).toContain("fact-y");
    expect(args.memberIds).toContain("fact-z");
    expect(args.memberIds).toContain("fact-w");
  });
});
