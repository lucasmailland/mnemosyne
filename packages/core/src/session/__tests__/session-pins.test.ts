import { describe, it, expect } from "vitest";
import { countPinnedTurns, requirePinSatisfied, estimateTokens } from "../collapse.js";
import type { SessionTurn } from "@mnemo-ai/types";

function turn(over: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: "t", workspaceId: "ws", sessionId: "s", turnIndex: 0,
    role: "user", content: "hello world", createdAt: new Date(), ...over, // determinism-ok: throwaway fixture date, not asserted
  };
}

describe("session pins (spec §7)", () => {
  it("countPinnedTurns counts only pinned turns", () => {
    expect(countPinnedTurns([turn({ pinned: true }), turn(), turn({ pinned: true })])).toBe(2);
    expect(countPinnedTurns([turn(), turn()])).toBe(0);
  });

  it("requirePinSatisfied: passes when requirePin is off, regardless of pins", () => {
    expect(requirePinSatisfied(false, [turn()])).toBe(true);
  });

  it("requirePinSatisfied: requires >=1 pin when requirePin is on", () => {
    expect(requirePinSatisfied(true, [turn()])).toBe(false);
    expect(requirePinSatisfied(true, [turn({ pinned: true })])).toBe(true);
  });

  it("estimateTokens uses tokenCount when present, else len/4", () => {
    expect(estimateTokens(turn({ content: "x".repeat(40) }))).toBe(10);
    expect(estimateTokens(turn({ content: "x", tokenCount: 99 }))).toBe(99);
  });
});
