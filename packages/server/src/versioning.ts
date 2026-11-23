/**
 * Date-based API versioning middleware.
 *
 * Clients pin to a date via `Mnemosyne-Version: YYYY-MM-DD`.
 * The server always processes with the latest business logic, then applies
 * backward-compatibility transforms to the response for older clients.
 *
 * Spec §35 lines 3905–3939.
 */

import type { MiddlewareHandler } from "hono";

export const CURRENT_API_VERSION = "2026-06-16";

/** A single backward-incompatible change and its transforms. */
export interface VersionChange {
  /** The date this change went live (YYYY-MM-DD). Clients pinned *before* this
   *  date will have `backward` applied to their responses. */
  date: string;
  description: string;
  /** Transform response body *from* new shape → old shape (for older clients). */
  backward: (body: unknown) => unknown;
  /** Transform request body *from* old shape → new shape (for the handler). */
  forward: (body: unknown) => unknown;
}

/**
 * Mutable registry — tests may push/pop entries to simulate a registered change.
 * Production code appends entries here as breaking changes land.
 */
export const VERSION_CHANGES: VersionChange[] = [];

/**
 * Returns the set of changes that are "newer than" the client's pinned version,
 * i.e. the changes the client hasn't opted into yet.
 *
 * These are the transforms we need to apply backwards to the response.
 */
function changesNewerThan(pinnedDate: string): VersionChange[] {
  return VERSION_CHANGES.filter((c) => c.date > pinnedDate);
}

/**
 * Apply backward transforms in *reverse* order (newest change undone first).
 */
function applyBackwardTransforms(
  body: unknown,
  changes: VersionChange[],
): unknown {
  // Apply in reverse: if changes are [A(2024), B(2025)] and client pinned to 2023,
  // both apply; we undo B first, then A.
  const sorted = [...changes].sort((a, b) => b.date.localeCompare(a.date));
  let result = body;
  for (const change of sorted) {
    result = change.backward(result);
  }
  return result;
}

export function createVersioningMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const clientVersion =
      c.req.header("Mnemosyne-Version") ?? CURRENT_API_VERSION;

    // Run the handler with the latest logic.
    await next();

    // Always echo the resolved version.
    c.res.headers.set("Mnemosyne-Version", CURRENT_API_VERSION);

    // Find changes newer than the client's pinned date.
    const applicable = changesNewerThan(clientVersion);
    if (applicable.length === 0) return;

    // Re-parse the response body, transform it, and replace the response.
    const originalBody = await c.res.clone().json().catch(() => null);
    if (originalBody === null) return; // non-JSON responses are untouched

    const transformed = applyBackwardTransforms(originalBody, applicable);

    // Replace response body while keeping status + headers.
    const status = c.res.status;
    const headers = new Headers(c.res.headers);
    headers.set("Content-Type", "application/json");
    c.res = new Response(JSON.stringify(transformed), { status, headers });
  };
}
