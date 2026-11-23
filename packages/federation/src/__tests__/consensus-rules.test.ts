import { describe, it, expect } from "vitest";
import { resolveConflict } from "../resolveConflict.js";
import type { ConflictFact } from "../resolveConflict.js";

function fact(over: Partial<ConflictFact> = {}): ConflictFact {
  return {
    attribution: "user_belief",
    worth: 0.5,
    validFrom: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("resolveConflict — §33 four rules", () => {
  it("Rule 1: higher trust anchor wins (conf 0.9)", () => {
    const local = fact({ attribution: "objective_fact" });
    const incoming = fact({ attribution: "inferred" });
    const v = resolveConflict(local, incoming);
    expect(v).toEqual({ winner: "local", reason: "trust_anchor", confidence: 0.9 });
  });

  it("Rule 1: incoming can win on trust anchor", () => {
    const v = resolveConflict(fact({ attribution: "inferred" }), fact({ attribution: "user_stated" }));
    expect(v.winner).toBe("incoming");
    expect(v.reason).toBe("trust_anchor");
    expect(v.confidence).toBe(0.9);
  });

  it("Rule 2: equal trust → more recent validFrom wins (conf 0.7)", () => {
    const local = fact({ attribution: "user_stated", validFrom: new Date("2026-06-03T00:00:00Z") });
    const incoming = fact({ attribution: "user_stated", validFrom: new Date("2026-06-01T00:00:00Z") });
    const v = resolveConflict(local, incoming);
    expect(v).toEqual({ winner: "local", reason: "recency", confidence: 0.7 });
  });

  it("Rule 3: equal trust + equal recency + worth gap > 0.2 → higher worth wins (conf 0.6)", () => {
    const t = new Date("2026-06-01T00:00:00Z");
    const local = fact({ attribution: "user_stated", validFrom: t, worth: 0.8 });
    const incoming = fact({ attribution: "user_stated", validFrom: t, worth: 0.5 });
    const v = resolveConflict(local, incoming);
    expect(v).toEqual({ winner: "local", reason: "worth", confidence: 0.6 });
  });

  it("Rule 3 boundary: worth gap of exactly 0.2 does NOT trigger (falls to rule 4)", () => {
    const t = new Date("2026-06-01T00:00:00Z");
    const v = resolveConflict(
      fact({ attribution: "user_stated", validFrom: t, worth: 0.7 }),
      fact({ attribution: "user_stated", validFrom: t, worth: 0.5 }),
    );
    expect(v.winner).toBe("undecided");
  });

  it("Rule 4: cannot determine → undecided/ambiguous (conf 0)", () => {
    const t = new Date("2026-06-01T00:00:00Z");
    const v = resolveConflict(
      fact({ attribution: "user_stated", validFrom: t, worth: 0.5 }),
      fact({ attribution: "user_stated", validFrom: t, worth: 0.5 }),
    );
    expect(v).toEqual({ winner: "undecided", reason: "ambiguous", confidence: 0 });
  });
});
