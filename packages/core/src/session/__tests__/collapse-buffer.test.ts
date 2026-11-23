// packages/core/src/session/__tests__/collapse-buffer.test.ts
import { describe, it, expect, vi } from "vitest";
import type { SessionTurn } from "@mnemo-ai/types";

// We assert the wiring contract: when ctx.sessionBuffer is present, collapse reads
// turns through ctx.sessionBuffer.getDurableTurns(ws, id) rather than
// ctx.storage.listTurns(...). getDurableTurns itself is PG-backed (WP6.2) so
// correctness/durability is preserved while the buffer becomes the single read path.
import { resolveCollapseTurns } from "../collapse.js";

const WS = "11111111-1111-1111-1111-111111111111";
const SID = "s-1";

function turns(): SessionTurn[] {
  return [
    { id: "t0", workspaceId: WS, sessionId: SID, turnIndex: 0, role: "user", content: "a", createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
    { id: "t1", workspaceId: WS, sessionId: SID, turnIndex: 1, role: "assistant", content: "b", createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
  ];
}

describe("collapse reads turns via SessionBuffer when present (WP6.5)", () => {
  it("uses ctx.sessionBuffer.getDurableTurns when a buffer is wired", async () => {
    const getDurableTurns = vi.fn().mockResolvedValue(turns());
    const listTurns = vi.fn().mockResolvedValue([]);
    const ctx = { storage: { listTurns }, sessionBuffer: { getDurableTurns } } as never;

    const result = await resolveCollapseTurns(ctx, WS, SID);
    expect(getDurableTurns).toHaveBeenCalledWith(WS, SID);
    expect(listTurns).not.toHaveBeenCalled();
    expect(result.map((t) => t.content)).toEqual(["a", "b"]);
  });

  it("falls back to ctx.storage.listTurns when no buffer is wired", async () => {
    const listTurns = vi.fn().mockResolvedValue(turns());
    const ctx = { storage: { listTurns } } as never;

    const result = await resolveCollapseTurns(ctx, WS, SID);
    expect(listTurns).toHaveBeenCalledWith(SID, WS);
    expect(result.map((t) => t.content)).toEqual(["a", "b"]);
  });
});
