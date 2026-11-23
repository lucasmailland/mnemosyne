import { describe, it, expect } from "vitest";
import { computeAnticipationAccuracy, type AnticipationSlot } from "../anticipation-accuracy.js";

describe("computeAnticipationAccuracy (spec §30 — hits/staged on .id)", () => {
  it("returns hits/staged when some staged ids are recalled (extracted as facts)", () => {
    const slot: AnticipationSlot = {
      generatedAt: "2026-06-15T10:00:00.000Z",
      items: [{ id: "fact-1" }, { id: "fact-2" }, { id: "fact-3" }, { id: "fact-4" }],
    };
    // 1 of 4 staged ids was extracted this session.
    const acc = computeAnticipationAccuracy(slot, ["fact-2", "other-x", "other-y"]);
    expect(acc).toBe(0.25);
  });

  it("returns 1 when every staged id is recalled", () => {
    const slot: AnticipationSlot = {
      generatedAt: "x",
      items: [{ id: "a" }, { id: "b" }],
    };
    expect(computeAnticipationAccuracy(slot, ["a", "b", "c"])).toBe(1);
  });

  it("returns 0 when none of the staged ids are recalled", () => {
    const slot: AnticipationSlot = { generatedAt: "x", items: [{ id: "a" }] };
    expect(computeAnticipationAccuracy(slot, ["z"])).toBe(0);
  });

  it("returns null when the slot is null", () => {
    expect(computeAnticipationAccuracy(null, ["a"])).toBeNull();
  });

  it("returns null when the slot has no items (covers the double-encode string case)", () => {
    // Defensive: a malformed slot (e.g. a string, or {} ) must not throw — accuracy stays null.
    expect(computeAnticipationAccuracy({ items: [] } as AnticipationSlot, ["a"])).toBeNull();
    expect(computeAnticipationAccuracy("not-an-object" as unknown as AnticipationSlot, ["a"])).toBeNull();
  });
});
