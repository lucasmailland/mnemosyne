import { describe, it, expect } from "vitest";
import { federatedConsensus } from "../federatedConsensus.js";
import type { FederationVote } from "../federatedConsensus.js";

const FRESH = new Date("2026-01-15T00:00:00Z").toISOString();

let _voteSeq = 0;
function vote(over: Partial<FederationVote> = {}): FederationVote {
  return {
    instanceId: `i-${++_voteSeq}`,
    factVersion: "v1",
    trustAnchor: "user_stated",
    worth: 1.0,
    freshness: FRESH,
    ...over,
  };
}

describe("federatedConsensus — §33 supermajority", () => {
  it("declares a winner above strict > 0.66", () => {
    const votes = [vote(), vote(), vote(), vote({ factVersion: "v2" })];
    const r = federatedConsensus(votes);
    expect(r.status).toBe("consensus");
    if (r.status === "consensus") {
      expect(r.adoptedVersion).toBe("v1");
      expect(r.confidence).toBeGreaterThan(0.66);
    }
  });

  it("BOUNDARY: exactly 0.66 is NOT a winner → contested", () => {
    const v1 = vote({ factVersion: "v1", worth: 66 / 90 });
    const v2 = vote({ factVersion: "v2", worth: 34 / 90 });
    const r = federatedConsensus([v1, v2]);
    expect(r.status).toBe("contested");
    if (r.status === "contested") {
      expect(r.versions.sort()).toEqual(["v1", "v2"]);
      expect(r.recommendation).toBe("human_review");
    }
  });

  it("just above 0.66 IS a winner", () => {
    const v1 = vote({ factVersion: "v1", worth: 67 / 90 });
    const v2 = vote({ factVersion: "v2", worth: 33 / 90 });
    const r = federatedConsensus([v1, v2]);
    expect(r.status).toBe("consensus");
  });

  it("weight = trust_anchor × worth × freshness_decay — a stale high-trust vote loses to fresh", () => {
    const stale = vote({ factVersion: "v1", trustAnchor: "user_stated", freshness: new Date("2025-01-15T00:00:00Z").toISOString() }); // 1 year before FRESH
    const fresh = vote({ factVersion: "v2", trustAnchor: "user_stated", freshness: FRESH });
    const r = federatedConsensus([stale, fresh, fresh]);
    expect(r.status).toBe("consensus");
    if (r.status === "consensus") expect(r.adoptedVersion).toBe("v2");
  });

  it("low trust anchor (federation_received 20) is intrinsically light", () => {
    const lo = vote({ factVersion: "v1", trustAnchor: "federation_received" });
    const hi = vote({ factVersion: "v2", trustAnchor: "objective_fact" });
    const r = federatedConsensus([lo, hi]);
    expect(r.status).toBe("consensus");
    if (r.status === "consensus") expect(r.adoptedVersion).toBe("v2");
  });

  it("preserves ALL versions in a 3-way contested split", () => {
    const r = federatedConsensus([
      vote({ factVersion: "a" }), vote({ factVersion: "b" }), vote({ factVersion: "c" }),
    ]);
    expect(r.status).toBe("contested");
    if (r.status === "contested") expect(r.versions.sort()).toEqual(["a", "b", "c"]);
  });
});
