/**
 * AB7.1 — Keyset cursor utilities for tasks/events pagination (spec §35 lines 4422–4423).
 *
 * Opaque base64url cursor encodes { createdAt: ISO string, id: string }.
 * This is O(1) at any depth vs offset pagination which is O(n).
 *
 * Pure module — no DB imports.
 */

export interface CursorPayload {
  createdAt: string;
  id: string;
}

/**
 * Encode a (createdAt, id) pair to an opaque base64url cursor string.
 */
export function encodeCursor(createdAt: string, id: string): string {
  const json = JSON.stringify({ createdAt, id });
  return Buffer.from(json, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Decode an opaque base64url cursor. Returns null if invalid.
 */
export function decodeCursor(cursor: string): CursorPayload | null {
  if (!cursor) return null;
  try {
    // Re-pad for base64 decoding
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (padded.length % 4)) % 4;
    const base64 = padded + "=".repeat(pad);
    const json = Buffer.from(base64, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).createdAt === "string" &&
      typeof (parsed as Record<string, unknown>).id === "string"
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export interface CursorEnvelope<T> {
  items: T[];
  /** Opaque cursor for the next page, or null if this is the last page. */
  nextCursor: string | null;
  /** Total count (pre-pagination). */
  total: number;
}

/**
 * Build a cursor-paginated envelope from a list of items.
 *
 * @param items        The items returned from the DB (length ≤ limit)
 * @param total        The total count across all pages
 * @param tsKey        Key on each item for the timestamp (used to encode cursor)
 * @param limit        The requested page size (default = items.length)
 */
export function buildCursorEnvelope<T extends { id: string } & Record<string, unknown>>(
  items: T[],
  total: number,
  tsKey: string,
  limit?: number,
): CursorEnvelope<T> {
  const pageSize = limit ?? items.length;
  const hasMore = items.length > 0 && items.length >= pageSize && total > pageSize;

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1]!;
    const ts = last[tsKey] as string | undefined;
    if (ts) {
      nextCursor = encodeCursor(ts, last.id);
    }
  }

  return { items, nextCursor, total };
}
