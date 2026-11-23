import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { computeMerkleRoot } from "../../merkle.js";

// Helper: produce a deterministic 32-byte hash from a seed string.
function h(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

// Helper: compute the expected parent of two 32-byte buffers (Bitcoin-style).
function sha256pair(a: Buffer, b: Buffer): Buffer {
  return createHash("sha256").update(a).update(b).digest();
}

describe("computeMerkleRoot", () => {
  it("returns null root for an empty array", () => {
    const result = computeMerkleRoot([]);
    expect(result).toEqual({ root: null, entryCount: 0, firstId: null, lastId: null });
  });

  it("returns null root when all entries have null merkleHash", () => {
    const result = computeMerkleRoot([
      { id: "1", merkleHash: null },
      { id: "2", merkleHash: undefined },
    ]);
    expect(result).toEqual({ root: null, entryCount: 0, firstId: null, lastId: null });
  });

  it("single-entry root equals the leaf's own hex digest", () => {
    const leaf = h("leaf1");
    const result = computeMerkleRoot([{ id: "1", merkleHash: leaf }]);
    expect(result.root).toBe(leaf.toString("hex"));
    expect(result.entryCount).toBe(1);
    expect(result.firstId).toBe("1");
    expect(result.lastId).toBe("1");
  });

  it("two-entry root equals sha256(leaf1 ‖ leaf2)", () => {
    const h1 = h("leaf1");
    const h2 = h("leaf2");
    const expected = sha256pair(h1, h2).toString("hex");
    const result = computeMerkleRoot([
      { id: "1", merkleHash: h1 },
      { id: "2", merkleHash: h2 },
    ]);
    expect(result.root).toBe(expected);
    expect(result.entryCount).toBe(2);
    expect(result.firstId).toBe("1");
    expect(result.lastId).toBe("2");
  });

  it("three-entry root uses Bitcoin-style odd-level duplication", () => {
    const h1 = h("leaf1");
    const h2 = h("leaf2");
    const h3 = h("leaf3");
    // Level 0: [h1, h2, h3]
    // Level 1: [sha256(h1‖h2), sha256(h3‖h3)]  ← h3 duplicated
    // Level 2 (root): sha256(level1[0] ‖ level1[1])
    const l1a = sha256pair(h1, h2);
    const l1b = sha256pair(h3, h3);
    const expected = sha256pair(l1a, l1b).toString("hex");
    const result = computeMerkleRoot([
      { id: "1", merkleHash: h1 },
      { id: "2", merkleHash: h2 },
      { id: "3", merkleHash: h3 },
    ]);
    expect(result.root).toBe(expected);
    expect(result.entryCount).toBe(3);
  });

  it("entries with null/undefined merkleHash are skipped; entryCount counts only hashable leaves", () => {
    const h1 = h("leaf1");
    const h3 = h("leaf3");
    const result = computeMerkleRoot([
      { id: "1", merkleHash: h1 },
      { id: "2", merkleHash: null },
      { id: "3", merkleHash: h3 },
      { id: "4", merkleHash: undefined },
    ]);
    // Only h1 and h3 are leaves — entryCount = 2
    expect(result.entryCount).toBe(2);
    expect(result.root).toBe(sha256pair(h1, h3).toString("hex"));
    // firstId/lastId reflect the id of the first and last HASHABLE entries
    expect(result.firstId).toBe("1");
    expect(result.lastId).toBe("3");
  });

  it("is deterministic — identical input produces identical root", () => {
    const entries = [
      { id: "1", merkleHash: h("a") },
      { id: "2", merkleHash: h("b") },
      { id: "3", merkleHash: h("c") },
    ];
    const r1 = computeMerkleRoot(entries);
    const r2 = computeMerkleRoot(entries);
    expect(r1.root).toBe(r2.root);
    expect(r1.entryCount).toBe(r2.entryCount);
  });

  it("entries without an id contribute to the tree but firstId/lastId remain null", () => {
    const leaf = h("no-id");
    const result = computeMerkleRoot([{ merkleHash: leaf }]);
    expect(result.entryCount).toBe(1);
    expect(result.root).toBe(leaf.toString("hex"));
    // id is undefined — firstId and lastId stay null
    expect(result.firstId).toBeNull();
    expect(result.lastId).toBeNull();
  });

  it("accepts Uint8Array (not just Buffer) for merkleHash", () => {
    const leaf = h("uint8");
    const asUint8 = new Uint8Array(leaf);
    const result = computeMerkleRoot([{ id: "42", merkleHash: asUint8 }]);
    expect(result.root).toBe(leaf.toString("hex"));
    expect(result.entryCount).toBe(1);
  });

  it("numeric ids are stringified for firstId/lastId", () => {
    const leaf = h("num-id");
    const result = computeMerkleRoot([{ id: 7, merkleHash: leaf }]);
    expect(result.firstId).toBe("7");
    expect(result.lastId).toBe("7");
  });
});
