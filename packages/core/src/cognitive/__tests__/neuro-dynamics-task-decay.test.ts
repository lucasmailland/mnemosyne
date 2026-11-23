import { describe, it, expect } from "vitest";
import { decayClassForKind, DECAY_HALF_LIVES } from "../neuro-dynamics.js";

describe("WP14.3 — Task is lifecycle-based, NOT Beta-evidence-decayed (spec §25.2 / 3445-3447)", () => {
  it("decayClassForKind('task') throws — tasks have no decay class", () => {
    expect(() => decayClassForKind("task")).toThrowError(/no decay class for kind: task/);
  });

  it("decayClassForKind('hyperedge') throws for the same reason", () => {
    expect(() => decayClassForKind("hyperedge")).toThrowError(/no decay class for kind: hyperedge/);
  });

  it("the five decay classes that DO exist remain mapped", () => {
    expect(decayClassForKind("fact")).toBe("semantic");
    expect(decayClassForKind("strategy")).toBe("procedural");
    expect(decayClassForKind("episode")).toBe("episodic");
    expect(decayClassForKind("entity")).toBe("entity");
    expect(decayClassForKind("reasoning")).toBe("reasoning");
    expect(DECAY_HALF_LIVES.entity).toBe(0); // immortal
  });
});
