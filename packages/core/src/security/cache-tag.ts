// Wave X — X1.2: Cache-poisoning workspace tag.
//
// When a fact is stored in the Redis hot-tier (ZSet + optional value cache),
// wrap the value with the workspace ID so that a mis-configured or compromised
// cache cannot serve a workspace-A payload to workspace-B.
//
// On unwrap, the workspace tag is verified and a CachePoisoningError is thrown
// on mismatch. The hot-tier MUST catch this error and evict the poisoned entry.
//
// PURE MODULE — no host imports.

/**
 * Thrown when a cached value's workspace tag does not match the expected
 * workspace. Callers MUST evict the cache entry and re-fetch from Postgres.
 */
export class CachePoisoningError extends Error {
  readonly expectedWorkspace: string;
  readonly actualWorkspace: string | undefined;

  constructor(expected: string, actual: string | undefined) {
    super(
      `Cache poisoning: payload tagged '${actual ?? "<none>"}' read under workspace '${expected}'`,
    );
    this.name = "CachePoisoningError";
    this.expectedWorkspace = expected;
    this.actualWorkspace = actual;
  }
}

/**
 * A workspace-tagged cache value. The `__ws` field carries the workspace ID
 * that originally wrote this entry; `v` is the actual payload.
 *
 * Not exported as part of the public cache protocol — it is internal to the
 * wrap/unwrap pair.
 */
export interface TaggedCacheValue<T> {
  __ws: string;
  v: T;
}

/**
 * Wrap a value with the current workspace ID before storing it in cache.
 *
 * @example
 * const wrapped = wrapCacheValue(workspaceId, factIds);
 * await cache.set(key, JSON.stringify(wrapped), ttl);
 */
export function wrapCacheValue<T>(workspaceId: string, value: T): TaggedCacheValue<T> {
  return { __ws: workspaceId, v: value };
}

/**
 * Unwrap a cached value, verifying the workspace tag.
 *
 * Throws CachePoisoningError if the tag is absent or does not match
 * `workspaceId`. The caller should then evict the stale/poisoned entry and
 * re-fetch from the authoritative store (Postgres).
 *
 * @example
 * const raw: TaggedCacheValue<string[]> = JSON.parse(await cache.get(key));
 * const factIds = unwrapCacheValue(workspaceId, raw); // throws on mismatch
 */
export function unwrapCacheValue<T>(
  workspaceId: string,
  wrapped: TaggedCacheValue<T>,
): T {
  // Defensively check __ws even if the type claims it exists
  const tag = (wrapped as { __ws?: string } | null)?.__ws;
  if (tag !== workspaceId) {
    throw new CachePoisoningError(workspaceId, tag);
  }
  return wrapped.v;
}
