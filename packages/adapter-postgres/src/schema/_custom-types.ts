import { customType } from "drizzle-orm/pg-core";

/**
 * halfvec(1536) — pgvector half-precision vector type.
 * Used for embedding columns across multiple tables.
 */
export const halfvec = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "halfvec";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(",").map(Number);
  },
});

/**
 * Parametric vector custom type for vector(dim).
 */
export function vectorCustomType(dim: number) {
  return customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return value.slice(1, -1).split(",").map(Number);
    },
  })();
}

/**
 * tsvector — PostgreSQL full-text search vector type.
 * Used for text_lemmatized columns.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * inet — PostgreSQL network address type.
 * Used for ip_address in audit log.
 */
export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

/**
 * bytea — PostgreSQL binary data type.
 * Used for merkle_hash in audit log and encrypted_key in mnemo_actor_dek.
 * Uses Uint8Array (ES2022 standard) — avoids Buffer dependency on Node types.
 *
 * Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1) fix: `fromDriver`
 * previously typed its input as `string` and called `.startsWith('\\x')` on
 * it — but postgres.js's built-in bytea type parser already decodes bytea
 * columns to a Node `Buffer` (a `Uint8Array` subclass) before Drizzle's
 * `fromDriver` ever runs, for every read that goes through the query builder
 * (`.select()`/`.update().returning()`/etc — raw `tx.execute(sql...)` reads
 * bypass this entirely and were never affected). `merkle_hash` never
 * surfaced this because `AuditRepository` only reads it via raw SQL; wiring
 * `mnemo_actor_dek.encrypted_key` to this type reproduced it immediately
 * (`TypeError: value.startsWith is not a function`,
 * `actor-dek-user-id.integration.test.ts`, empirically verified — not fixed
 * from memory). Handles both shapes so the type is correct for every actual
 * caller, not just the ones exercised so far.
 *
 * Writer fix: `toDriver` used to send the hex text with no `\x` prefix, which
 * Postgres parses in escape format, so a row stored the ASCII characters of the
 * hex (64 bytes for a 32-byte digest) instead of the bytes. It now sends a
 * Buffer, which postgres.js binds as real bytea. Only `merkle_hash` was ever
 * written through this type (`encrypted_key` is written with
 * `decode(..., 'base64')`). Reads return the stored bytes unchanged on
 * purpose: the audit chain hashes the hex of the STORED bytes into the next
 * row, so decoding a legacy row here would break the link after it.
 * `verifyAuditChain` (merkle.ts, storedDigestHex) reads both shapes, and the
 * append-only audit log cannot be rewritten, so old rows stay as they are.
 */
export const bytea = customType<{ data: Uint8Array; driverData: string | Uint8Array }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Uint8Array {
    return Buffer.from(value);
  },
  fromDriver(value: string | Uint8Array): Uint8Array {
    if (value instanceof Uint8Array) return value;
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  },
});
