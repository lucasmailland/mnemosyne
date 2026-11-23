import { describe, it, expect } from "vitest";
import { auditHashFields, computeAuditMerkleHash, type AuditHashInput } from "../../merkle.js";

describe("auditHashFields — C2 spec projection", () => {
  // base intentionally carries extra fields (userAgent, metadata, workspaceId,
  // actorId) that the spec-C2 projection MUST ignore. We use a wider type so TS
  // does not reject the extra fields; auditHashFields only picks the 5 spec ones.
  const base: AuditHashInput & Record<string, unknown> = {
    entryId: "e-123",
    action: "fact.create",
    resourceKind: "fact",
    resourceId: "f-1",
    occurredAt: new Date("2026-06-20T00:00:00.000Z"),
    // these MUST be ignored by the hash now:
    userAgent: "curl/8",
    metadata: { pii: "secret" },
    workspaceId: "w-1",
    actorId: "a-1",
  };

  it("commits ONLY to entryId, action, resourceKind, resourceId, occurredAt", () => {
    const fields = auditHashFields(base);
    expect(Object.keys(fields).sort()).toEqual(
      ["action", "entryId", "occurredAt", "resourceId", "resourceKind"].sort(),
    );
    expect(fields).not.toHaveProperty("metadata");
    expect(fields).not.toHaveProperty("userAgent");
  });

  it("is INSENSITIVE to metadata/userAgent changes (GDPR-safe)", () => {
    const a = computeAuditMerkleHash(auditHashFields(base), null);
    // Cast via unknown to allow extra fields that auditHashFields intentionally ignores
    const modified = { ...base, userAgent: "different", metadata: { other: 1 } } as unknown as AuditHashInput;
    const b = computeAuditMerkleHash(auditHashFields(modified), null);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
  });

  it("IS sensitive to action/resource/timestamp/entryId tampering", () => {
    const a = computeAuditMerkleHash(auditHashFields(base), null);
    const b = computeAuditMerkleHash(auditHashFields({ ...base, action: "fact.delete" }), null);
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });
});
