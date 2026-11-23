import { describe, it, expect } from "vitest";
import { resolveConsensus } from "../consensus.js";
import type { FederationClaim } from "../consensus.js";

const NO_PEERS: ReadonlyMap<string, number> = new Map();
const PEERS: ReadonlyMap<string, number> = new Map([
  ["peer-a", 0.8],
  ["peer-b", 0.6],
  ["peer-c", 0.4],
]);

describe("resolveConsensus", () => {
  it("returns winner when single claim version dominates", () => {
    const claims: FederationClaim[] = [
      { version: "v1", peerId: "peer-a" },
      { version: "v1", peerId: "peer-b" },
    ];
    const result = resolveConsensus(claims, PEERS);
    expect(result.status).toBe("winner");
    if (result.status === "winner") {
      expect(result.version).toBe("v1");
      expect(result.confidence).toBeCloseTo(1.0);
    }
  });

  it("returns no_consensus on 50/50 weighted split", () => {
    // peer-a (0.8) votes v1, peer-b (0.6) votes v2 — neither exceeds 2/3
    // But 0.8/(0.8+0.6) = 0.571 < 2/3
    const claims: FederationClaim[] = [
      { version: "v1", peerId: "peer-a" },
      { version: "v2", peerId: "peer-b" },
    ];
    const result = resolveConsensus(claims, PEERS);
    expect(result.status).toBe("no_consensus");
  });

  it("returns winner when one version has > 2/3 weight", () => {
    // peer-a (0.8) + peer-b (0.6) = 1.4 for v1; peer-c (0.4) for v2.
    // 1.4 / 1.8 = 0.778 > 2/3
    const claims: FederationClaim[] = [
      { version: "v1", peerId: "peer-a" },
      { version: "v1", peerId: "peer-b" },
      { version: "v2", peerId: "peer-c" },
    ];
    const result = resolveConsensus(claims, PEERS);
    expect(result.status).toBe("winner");
    if (result.status === "winner") expect(result.version).toBe("v1");
  });

  it("returns rejected when claims < minQuorum", () => {
    const claims: FederationClaim[] = [{ version: "v1" }];
    const result = resolveConsensus(claims, NO_PEERS, { minQuorum: 3 });
    expect(result.status).toBe("rejected");
  });

  it("uses default peerWeight=0.5 for unknown peerId", () => {
    const claims: FederationClaim[] = [
      { version: "v1", peerId: "unknown-peer" },
      { version: "v1", peerId: "also-unknown" },
      { version: "v2" },   // no peerId → 0.5
    ];
    // v1: 0.5+0.5=1.0; v2: 0.5; total 1.5; v1 = 0.667 which is NOT > 2/3 (equal, not strictly greater)
    const result = resolveConsensus(claims, NO_PEERS);
    expect(result.status).toBe("no_consensus");
  });

  it("applies clock skew decay to peer weight", () => {
    // High clock skew (1 hour = 3_600_000ms) → decay ≈ e^(-60) ≈ near zero
    const claims: FederationClaim[] = [
      { version: "v1", peerId: "peer-a", clockSkewMs: 3_600_000 },
      { version: "v2", peerId: "peer-b" },
    ];
    const result = resolveConsensus(claims, PEERS);
    // peer-a's vote is nearly zeroed out, peer-b wins easily
    expect(result.status).toBe("winner");
    if (result.status === "winner") expect(result.version).toBe("v2");
  });

  it("applies worth factor to vote weight", () => {
    const claims: FederationClaim[] = [
      { version: "v1", worth: 0.01 },   // nearly zero-weight
      { version: "v2", worth: 1.0 },
    ];
    const result = resolveConsensus(claims, NO_PEERS);
    expect(result.status).toBe("winner");
    if (result.status === "winner") expect(result.version).toBe("v2");
  });

  it("returns no_consensus on three-way split", () => {
    const claims: FederationClaim[] = [
      { version: "v1", peerId: "peer-a" },
      { version: "v2", peerId: "peer-b" },
      { version: "v3", peerId: "peer-c" },
    ];
    const result = resolveConsensus(claims, PEERS);
    expect(result.status).toBe("no_consensus");
    if (result.status === "no_consensus") {
      expect(result.versions).toHaveLength(3);
      expect(result.recommendation).toBe("human_review");
    }
  });

  it("allows custom supermajority threshold", () => {
    // 0.6/(0.6+0.4) = 0.6; with threshold 0.55 that's a winner
    const claims: FederationClaim[] = [
      { version: "v1", peerId: "peer-b" },   // 0.6
      { version: "v2", peerId: "peer-c" },   // 0.4
    ];
    const result = resolveConsensus(claims, PEERS, { supermajority: 0.55 });
    expect(result.status).toBe("winner");
  });
});
