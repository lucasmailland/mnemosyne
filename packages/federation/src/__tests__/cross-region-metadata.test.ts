/**
 * AB2 — Cross-region federation: metadata-only projection.
 * spec §35 lines 4072–4076.
 */
import { describe, it, expect } from "vitest";
import { projectForPeer } from "../syncProtocol.js";

const sampleFacts = [
  { factId: "f1", hash: "h1", region: "us-east-1", statement: "TypeScript is great", content: "full content", embedding: new Float32Array([1,2,3]) },
  { factId: "f2", hash: "h2", region: "us-east-1", statement: "Redis is fast", content: "other content", embedding: new Float32Array([4,5,6]) },
];

describe("projectForPeer — spec §35 lines 4072–4076", () => {
  it("returns only {factId,hash,region} when peer is in a different region", () => {
    const result = projectForPeer(sampleFacts, { localRegion: "us-east-1", peerRegion: "eu-west-1" });
    for (const item of result) {
      expect(Object.keys(item).sort()).toEqual(["factId", "hash", "region"].sort());
      expect((item as any).statement).toBeUndefined();
      expect((item as any).content).toBeUndefined();
      expect((item as any).embedding).toBeUndefined();
    }
  });

  it("returns full payload when peer is in the same region", () => {
    const result = projectForPeer(sampleFacts, { localRegion: "us-east-1", peerRegion: "us-east-1" });
    for (const item of result) {
      expect((item as any).statement).toBeDefined();
      expect((item as any).content).toBeDefined();
    }
  });

  it("returns full payload when localRegion is undefined (single-region mode)", () => {
    const result = projectForPeer(sampleFacts, { localRegion: undefined, peerRegion: "eu-west-1" });
    for (const item of result) {
      expect((item as any).statement).toBeDefined();
    }
  });
});
