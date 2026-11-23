// in-memory/support.ts — shared pure helpers for InMemoryStorageAdapter's domain modules.
// Moved verbatim from InMemoryStorageAdapter.ts lines 139-228 (decompose-inmemory-storage-adapter
// Batch B0, design.md D6/D7 — move-only, no behavior change).

import type { MnemoFact } from "../../primitives.js";
import type { ConsolidationMergeSnapshot, ConsolidationWorthSnapshot } from "../../ports.js";
import type { PaginatedResult } from "../../common.js";

// ─── Tiny UUID helper (no node:crypto dependency) ─────────────────────────────

export function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function factStatementHash(statement: string, subject: string): Promise<string> {
  const canonical = `${statement.trim().toLowerCase()}|${subject}|fact`;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical)
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Entity-projected semantic-neighbor edge — mirrors GraphRepository's identically-shaped local type. */
export interface SemanticEdgeRow {
  sourceId: string;
  targetId: string;
  cosine: number;
}

/** Brute-force cosine similarity for InMemory L3 query-cache lookup. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function paginate<T>(items: T[], offset = 0, limit = 20): PaginatedResult<T> {
  const sliced = items.slice(offset, offset + limit);
  return {
    items: sliced,
    total: items.length,
    offset,
    limit,
    hasMore: offset + sliced.length < items.length,
  };
}

export const PENDING_KEY = "__mnemoConsolidationPending";

export interface ConsolidationMarker extends ConsolidationMergeSnapshot {
  leaseExpiresAt: string;
}

export function worthSnapshot(fact: MnemoFact): ConsolidationWorthSnapshot {
  return {
    alpha: fact.worthAlpha,
    beta: fact.worthBeta,
    success: fact.worthSuccess,
    failure: fact.worthFailure,
  };
}

export function worthEquals(fact: MnemoFact, worth: ConsolidationWorthSnapshot): boolean {
  return (
    fact.worthAlpha === worth.alpha &&
    fact.worthBeta === worth.beta &&
    fact.worthSuccess === worth.success &&
    fact.worthFailure === worth.failure
  );
}

export function markerFor(fact: MnemoFact): ConsolidationMarker | undefined {
  const marker = fact.metadata?.[PENDING_KEY];
  return marker && typeof marker === "object" ? (marker as ConsolidationMarker) : undefined;
}

export function withoutPendingMarker(metadata: Record<string, unknown>): Record<string, unknown> {
  const { [PENDING_KEY]: _pending, ...rest } = metadata;
  return rest;
}

export function hasPendingMarker(metadata: Record<string, unknown> | undefined): boolean {
  return Object.prototype.hasOwnProperty.call(metadata ?? {}, PENDING_KEY);
}

/** A close instant never before the row's own start (mirrors adapter-postgres's `closeAt`). */
export function closeAt(validTo: Date, validFrom: Date): Date {
  return validTo < validFrom ? validFrom : validTo;
}
