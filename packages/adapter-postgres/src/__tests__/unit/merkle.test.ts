import { describe, it, expect } from "vitest";
import {
  computeAuditMerkleHash,
  verifyAuditChain,
  bufferToHex,
  auditHashFields,
} from "../../merkle.js";

// ─── computeAuditMerkleHash ──────────────────────────────────────────────────

describe("computeAuditMerkleHash", () => {
  it("returns a 32-byte Buffer (SHA-256 output)", () => {
    const entry = { workspaceId: "ws1", action: "create", resourceId: "f1" };
    const hash = computeAuditMerkleHash(entry, null);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);
  });

  it("first entry with null prevHash is deterministic", () => {
    const entry = { workspaceId: "ws1", action: "remember", resourceId: "f1" };
    const h1 = computeAuditMerkleHash(entry, null);
    const h2 = computeAuditMerkleHash(entry, null);
    expect(Buffer.compare(h1, h2)).toBe(0);
  });

  it("null and empty-string prevHash produce the same result", () => {
    const entry = { workspaceId: "ws1", action: "recall", resourceId: "f1" };
    const h1 = computeAuditMerkleHash(entry, null);
    const h2 = computeAuditMerkleHash(entry, "");
    expect(Buffer.compare(h1, h2)).toBe(0);
  });

  it("chaining produces a different hash from the first entry", () => {
    const entry = { action: "create", resourceId: "f1" };
    const h1 = computeAuditMerkleHash(entry, null);
    const h2 = computeAuditMerkleHash(entry, h1.toString("hex"));
    expect(h1.toString("hex")).not.toBe(h2.toString("hex"));
  });

  it("canonical json makes key order irrelevant", () => {
    const a = { b: 2, a: 1 };
    const b = { a: 1, b: 2 };
    const ha = computeAuditMerkleHash(a, null);
    const hb = computeAuditMerkleHash(b, null);
    expect(Buffer.compare(ha, hb)).toBe(0);
  });

  it("different entry content produces different hashes", () => {
    const e1 = { action: "create", resourceId: "x" };
    const e2 = { action: "delete", resourceId: "x" };
    const h1 = computeAuditMerkleHash(e1, null);
    const h2 = computeAuditMerkleHash(e2, null);
    expect(h1.toString("hex")).not.toBe(h2.toString("hex"));
  });

  it("handles nested objects and arrays in entry", () => {
    const entry = { meta: { tags: ["a", "b"], count: 2 }, action: "export" };
    const hash = computeAuditMerkleHash(entry, null);
    expect(hash.length).toBe(32);
    // Same result with same nested structure
    expect(Buffer.compare(hash, computeAuditMerkleHash(entry, null))).toBe(0);
  });
});

// ─── bufferToHex ─────────────────────────────────────────────────────────────

describe("bufferToHex", () => {
  it("converts a Buffer to hex", () => {
    const buf = Buffer.from("hello");
    expect(bufferToHex(buf)).toBe("68656c6c6f");
  });

  it("returns empty string for null", () => {
    expect(bufferToHex(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(bufferToHex(undefined)).toBe("");
  });

  it("round-trips with computeAuditMerkleHash", () => {
    const entry = { action: "recall", resourceId: "r1" };
    const hash = computeAuditMerkleHash(entry, null);
    const hex = bufferToHex(hash);
    expect(hex).toHaveLength(64); // 32 bytes × 2 hex chars
    expect(/^[0-9a-f]{64}$/.test(hex)).toBe(true);
  });
});

// ─── verifyAuditChain ────────────────────────────────────────────────────────

describe("verifyAuditChain", () => {
  // Mirror the production contract: the chain commits to the canonical
  // projection (auditHashFields), NOT to whatever loose object the caller holds.
  // Maps from the VerifiableAuditEntry shape (entryUid/createdAt) to the
  // AuditHashInput shape (entryId/occurredAt) — same mapping verifyAuditChain uses.
  const hashOf = (e: Record<string, unknown>, prev: string | null) =>
    computeAuditMerkleHash(
      auditHashFields({
        entryId: (e["entryUid"] ?? e["entry_uid"] ?? e["entryId"]) as string | undefined,
        action: e["action"] as string | undefined,
        resourceKind: e["resourceKind"] as string | undefined,
        resourceId: e["resourceId"] as string | undefined,
        occurredAt: (e["createdAt"] ?? e["occurredAt"]) as string | Date | undefined,
      }),
      prev
    );

  it("returns -1 for an empty chain", () => {
    expect(verifyAuditChain([])).toBe(-1);
  });

  it("returns -1 for a single valid entry", () => {
    const e1 = { action: "create", resourceId: "f1" };
    const h1 = hashOf(e1, null);
    expect(verifyAuditChain([{ ...e1, merkleHash: h1 }])).toBe(-1);
  });

  it("returns -1 for a valid two-entry chain", () => {
    const e1 = { action: "create", resourceId: "f1" };
    const h1 = hashOf(e1, null);
    const e2 = { action: "recall", resourceId: "f1" };
    const h2 = hashOf(e2, h1.toString("hex"));
    const chain = [
      { ...e1, merkleHash: h1 },
      { ...e2, merkleHash: h2 },
    ];
    expect(verifyAuditChain(chain)).toBe(-1);
  });

  it("returns broken index when content is tampered", () => {
    const e1 = { action: "create", resourceId: "f1" };
    const h1 = hashOf(e1, null);
    const e2 = { action: "recall", resourceId: "f1" };
    const h2 = hashOf(e2, h1.toString("hex"));
    const chain = [
      { ...e1, merkleHash: h1 },
      // content changed but hash kept — should fail at index 1
      { action: "TAMPERED", resourceId: "evil", merkleHash: h2 },
    ];
    expect(verifyAuditChain(chain)).toBe(1);
  });

  it("returns broken index when hash is forged", () => {
    const e1 = { action: "create", resourceId: "f1" };
    const h1 = hashOf(e1, null);
    const forgedHash = Buffer.alloc(32, 0xde);
    const chain = [
      { ...e1, merkleHash: h1 },
      { action: "recall", resourceId: "f1", merkleHash: forgedHash },
    ];
    expect(verifyAuditChain(chain)).toBe(1);
  });

  it("skips null-hash terminal records and does not break valid surrounding chain", () => {
    // Terminal GDPR records have merkleHash = null. AUDIT-MERKLE: the writer
    // (AuditRepository.appendAuditEntry) chains the next entry to the last
    // NON-terminal row, so the chain carries across the terminal record — it
    // used to be verified as a reset, which no real chain matched.
    const e1 = { action: "create", resourceId: "f1" };
    const h1 = hashOf(e1, null);
    const terminal = { action: "erasure_complete", resourceId: "f1", merkleHash: null };
    const e3 = { action: "create", resourceId: "f2" };
    const h3 = hashOf(e3, h1.toString("hex"));
    const chain = [{ ...e1, merkleHash: h1 }, terminal, { ...e3, merkleHash: h3 }];
    expect(verifyAuditChain(chain)).toBe(-1);
    // A chain restarted after the terminal row is not what the writer makes.
    const restarted = [chain[0]!, terminal, { ...e3, merkleHash: hashOf(e3, null) }];
    expect(verifyAuditChain(restarted)).toBe(2);
  });

  // AUDIT-MERKLE: the drizzle bytea type stores the digest as the ASCII text
  // of its hex, and the writer chains on the hex of those stored bytes.
  it("verifies the encoding real rows are stored in (ASCII hex text)", () => {
    const asStored = (digest: Buffer) => Buffer.from(digest.toString("hex"), "latin1");
    const e1 = { entryUid: "u1", action: "create", resourceId: "f1" };
    const s1 = asStored(hashOf(e1, null));
    const e2 = { entryUid: "u2", action: "update", resourceId: "f1" };
    const s2 = asStored(hashOf(e2, s1.toString("hex")));
    expect(s1).toHaveLength(64);
    expect(
      verifyAuditChain([
        { ...e1, merkleHash: s1 },
        { ...e2, merkleHash: s2 },
      ])
    ).toBe(-1);
    const forged = asStored(Buffer.alloc(32, 0xab));
    expect(
      verifyAuditChain([
        { ...e1, merkleHash: s1 },
        { ...e2, merkleHash: forged },
      ])
    ).toBe(1);
  });

  it("detects tampering at index 0", () => {
    const e1 = { action: "create", resourceId: "f1" };
    const wrongHash = Buffer.alloc(32, 0xff);
    const chain = [{ ...e1, merkleHash: wrongHash }];
    expect(verifyAuditChain(chain)).toBe(0);
  });

  it("validates a three-entry chain end-to-end", () => {
    const entries = [
      { action: "session_open", resourceId: "s1" },
      { action: "create", resourceId: "f1" },
      { action: "session_close", resourceId: "s1" },
    ];
    let prevHex: string | null = null;
    const chain = entries.map((e) => {
      const hash = hashOf(e, prevHex);
      prevHex = hash.toString("hex");
      return { ...e, merkleHash: hash };
    });
    expect(verifyAuditChain(chain)).toBe(-1);
  });

  // ── §5: chain commits to entryId/action/resource/timestamp only (C2 spec) ───
  // userAgent and metadata are EXCLUDED from the hash so GDPR crypto-erasure of
  // the detail blob does not break chain verification. Changes to those fields
  // do NOT invalidate the chain — this is intentional per spec.

  it("does NOT detect changes to userAgent (GDPR-safe per spec C2)", () => {
    const e = {
      entryUid: "uid-1",
      action: "recall",
      resourceKind: "fact",
      resourceId: "f1",
      userAgent: "curl/8.0",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const h = hashOf(e, null);
    // userAgent changed but chain should still verify — metadata/UA not committed
    const chain = [{ ...e, userAgent: "evil/1.0", merkleHash: h }];
    expect(verifyAuditChain(chain)).toBe(-1);
  });

  it("does NOT detect changes to metadata/detail (GDPR-safe per spec C2)", () => {
    const e = {
      entryUid: "uid-2",
      action: "delete",
      resourceKind: "fact",
      resourceId: "f1",
      detail: { reason: "gdpr" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const h = hashOf(e, null);
    // detail changed but chain should still verify
    const chain = [{ ...e, detail: { reason: "cover-up" }, merkleHash: h }];
    expect(verifyAuditChain(chain)).toBe(-1);
  });

  it("detects tampering of the timestamp (§5)", () => {
    const e = {
      entryUid: "uid-3",
      action: "create",
      resourceKind: "fact",
      resourceId: "f1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const h = hashOf(e, null);
    const chain = [{ ...e, createdAt: new Date("2030-01-01T00:00:00Z"), merkleHash: h }];
    expect(verifyAuditChain(chain)).toBe(0);
  });
});
