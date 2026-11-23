/**
 * Merkle hash chain utilities for the audit log (P0.4).
 *
 * Chain algorithm:
 *   SHA-256(prevHashHex + "\n" + canonicalJson(entry))
 *
 * First entry in a workspace uses prevHash = "" (empty string).
 * Terminal records (GDPR erasure) have merkle_hash = NULL and break the chain —
 * verifyAuditChain() skips NULL entries rather than failing.
 *
 * The hash is returned as a Buffer (Uint8Array subclass) to match the
 * AuditLogEntry.merkleHash domain type and the BYTEA Postgres column.
 * The prevHash threading uses the hex digest internally for readability
 * and to avoid binary-encoding ambiguity between DB drivers.
 */

import { createHash } from "node:crypto";

// ─── Canonical audit-hash projection (§5) ──────────────────────────────────────

/**
 * §5 audit-hash projection. The chain commits to EXACTLY:
 *   entryId, action, resourceKind, resourceId, occurredAt
 * (spec: SHA256(prev + entry_id + action + resource + timestamp)). metadata and
 * userAgent are DELIBERATELY EXCLUDED so GDPR crypto-erasure of the detail blob
 * does not break chain verification.
 *
 * Both the write path (DrizzleStorageAdapter.appendAuditEntry) and the read path
 * (verifyAuditChain) MUST derive the hashed object from this single function so
 * the committed bytes and the recomputed bytes are byte-identical.
 */
export interface AuditHashInput {
  entryId?: string | null;
  action?: string | null;
  resourceKind?: string | null;
  resourceId?: string | null;
  /** The committed timestamp. Date or ISO string; normalised to ISO. */
  occurredAt?: string | Date | null;
}

export function auditHashFields(e: AuditHashInput): Record<string, unknown> {
  return {
    entryId: e.entryId ?? null,
    action: e.action ?? null,
    resourceKind: e.resourceKind ?? null,
    resourceId: e.resourceId ?? null,
    occurredAt: e.occurredAt instanceof Date ? e.occurredAt.toISOString() : (e.occurredAt ?? null),
  };
}

// ─── Core hash computation ─────────────────────────────────────────────────────

/**
 * Compute the next Merkle hash in the per-workspace audit chain.
 *
 * @param entry  - The semantic fields to commit to (no id, no createdAt).
 * @param prevHashHex - Hex string of the previous entry's hash, or null/""
 *                     for the first entry in a workspace.
 * @returns SHA-256 digest as a Buffer (Uint8Array).
 */
export function computeAuditMerkleHash(
  entry: Record<string, unknown>,
  prevHashHex: string | null
): Buffer {
  const canonical = canonicalJson(entry);
  const input = (prevHashHex ?? "") + "\n" + canonical;
  return createHash("sha256").update(input, "utf8").digest() as unknown as Buffer;
}

/**
 * Convert a BYTEA Buffer from Postgres into the hex string used for chaining.
 * Returns "" for null (first-entry sentinel).
 */
export function bufferToHex(buf: Uint8Array | null | undefined): string {
  if (!buf) return "";
  return Buffer.from(buf).toString("hex");
}

// ─── Canonical JSON ───────────────────────────────────────────────────────────

/**
 * Deterministic JSON serialisation: object keys are sorted recursively.
 * Arrays preserve insertion order (correct for audit metadata).
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]));
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(value);
}

// ─── Chain verification ───────────────────────────────────────────────────────

/**
 * The digest a stored `merkle_hash` holds, as lowercase hex: 32 raw bytes, or
 * the 64-character ASCII hex text the drizzle `bytea` type wrote before its
 * writer was fixed (those rows stay: the audit log is append-only).
 */
function storedDigestHex(stored: Uint8Array): string {
  const buf = Buffer.from(stored);
  if (buf.length === 64) {
    const text = buf.toString("latin1");
    if (/^[0-9a-f]{64}$/.test(text)) return text;
  }
  return buf.toString("hex");
}

/**
 * Entry shape expected by verifyAuditChain.
 * merkleHash is the raw BYTEA buffer (null for terminal records, or undefined
 * for domain rows like AuditLogEntry where the field is optional). The
 * verifier treats null and undefined identically (chain reset / skip).
 * All other fields are the semantic content that was committed.
 */
export interface VerifiableAuditEntry {
  merkleHash?: Uint8Array | null;
  [key: string]: unknown;
}

/**
 * Verify a chain of audit entries (ordered oldest-first, same workspace).
 *
 * Returns the index of the first broken link, or -1 if the entire chain is
 * valid. Entries with merkleHash = null (terminal GDPR records) carry no hash
 * and are skipped: the writer (AuditRepository.appendAuditEntry) chains the
 * next entry to the last NON-terminal row, so prevHash carries across them.
 *
 * Stored encoding (AUDIT-MERKLE): rows written before the `bytea` writer fix
 * hold the ASCII text of the digest's hex (64 characters); newer rows hold the
 * 32 raw bytes. Both shapes verify, also mixed in one chain. The writer threads the
 * hex of the STORED bytes as the next prevHash, and so does this function.
 *
 * The parameter only statically requires `merkleHash`; every other field is
 * read structurally at runtime (spread into the canonical hash). This lets
 * concrete domain rows (e.g. @mnemo-ai/types' AuditLogEntry, which has no
 * index signature) be passed directly, as well as the looser
 * VerifiableAuditEntry shape used by the unit tests.
 */
export function verifyAuditChain(
  entries: ReadonlyArray<{ merkleHash?: Uint8Array | null }>
): number {
  let prevHashHex: string | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as VerifiableAuditEntry;
    const merkleHash = entry.merkleHash;

    // Terminal records (GDPR erasure) legitimately have no hash; skip them.
    // The chain continues from the last hashed entry, as the writer does.
    if (merkleHash === null || merkleHash === undefined) continue;

    // §5: recompute over the spec projection the write path commits to:
    // entryId, action, resourceKind, resourceId, occurredAt.
    // metadata/userAgent are EXCLUDED so GDPR crypto-erasure does not break
    // chain verification. AuditLogEntry names the timestamp `createdAt` and
    // the stable entry uuid `entryUid`/`entry_uid`; map them here.
    const fields = auditHashFields({
      entryId: (entry.entryUid ?? entry.entry_uid) as string | undefined,
      action: entry.action as string | undefined,
      resourceKind: entry.resourceKind as string | undefined,
      resourceId: entry.resourceId as string | undefined,
      occurredAt: (entry.createdAt ?? entry.occurredAt) as string | Date | undefined,
    });
    const expectedHex = computeAuditMerkleHash(fields, prevHashHex).toString("hex");
    if (storedDigestHex(merkleHash) !== expectedHex) return i;

    prevHashHex = Buffer.from(merkleHash).toString("hex");
  }

  return -1;
}

// ─── Merkle root (tree) computation ──────────────────────────────────────────

export interface MerkleRootResult {
  root: string | null;
  entryCount: number;
  firstId: string | null;
  lastId: string | null;
}

/**
 * Build a Merkle tree over a set of audit entries and return the root hash.
 *
 * Algorithm: binary tree, SHA-256 over concatenated child hashes.
 * Odd levels duplicate the last leaf (Bitcoin-style), so any number of
 * leaves produces a deterministic root.
 *
 * This is a pure function — no DB calls, safe to call from any context.
 *
 * @param entries - Audit log entries; only those with a non-null merkleHash
 *                  are included (terminal GDPR records are skipped).
 * @returns MerkleRootResult — root hex string (null when there are no
 *          hashable leaves), leaf count, and the first/last id seen.
 */
export function computeMerkleRoot(
  entries: ReadonlyArray<{ id?: string | number; merkleHash?: Uint8Array | Buffer | null }>
): MerkleRootResult {
  const leaves: Buffer[] = [];
  let firstId: string | null = null;
  let lastId: string | null = null;
  for (const e of entries) {
    if (e.merkleHash === null || e.merkleHash === undefined) continue;
    leaves.push(Buffer.from(e.merkleHash));
    const idStr = e.id === undefined ? null : String(e.id);
    if (idStr !== null) {
      if (firstId === null) firstId = idStr;
      lastId = idStr;
    }
  }
  if (leaves.length === 0) return { root: null, entryCount: 0, firstId: null, lastId: null };
  let level: Buffer[] = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(createHash("sha256").update(left).update(right).digest());
    }
    level = next;
  }
  return { root: level[0]!.toString("hex"), entryCount: leaves.length, firstId, lastId };
}
