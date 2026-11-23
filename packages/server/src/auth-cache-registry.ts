/**
 * Process-wide handle on the API key auth caches (HTTP middleware, gRPC
 * interceptor), so a route that revokes a user's keys or changes their
 * membership can drop what this process remembers about that user at once.
 *
 * Each transport keeps a 60 s token cache (token -> key facts, userId among
 * them) and a 30 s role cache keyed `${userId}:${workspaceId}`. Without this, a
 * key revoked by a member removal, or from the API Keys page, would keep
 * authenticating from the token cache until it expired. Other server processes
 * still wait out their TTLs.
 *
 * The caches are held weakly: an app that is dropped (tests build many) does
 * not stay alive because it registered here.
 */
import type { LRUCache } from "lru-cache";

/** `actorId` is the key's `mnemo_api_keys.id`. */
type KeyCache = LRUCache<string, { userId?: string | null; actorId?: string }>;
type RoleCache = LRUCache<string, { role: string | null }>;

const keyCaches = new Set<WeakRef<KeyCache>>();
const roleCaches = new Set<WeakRef<RoleCache>>();

/** Register one transport's token cache and role cache. */
export function registerAuthCaches<V extends { userId?: string | null; actorId?: string }>(
  keys: LRUCache<string, V>,
  roles: RoleCache
): void {
  keyCaches.add(new WeakRef(keys as unknown as KeyCache));
  roleCaches.add(new WeakRef(roles));
}

function each<T extends object>(refs: Set<WeakRef<T>>, fn: (cache: T) => void): void {
  for (const ref of refs) {
    const cache = ref.deref();
    if (cache) fn(cache);
    else refs.delete(ref);
  }
}

/**
 * Forget every cached key bound to `userId` and every cached role of theirs,
 * in this process. The next request re-reads the key (revoked keys are not
 * found) and the role from the database.
 */
export function forgetUserAuth(userId: string): void {
  each(keyCaches, (cache) => {
    const stale: string[] = [];
    for (const [token, entry] of cache.entries()) if (entry.userId === userId) stale.push(token);
    for (const token of stale) cache.delete(token);
  });
  const prefix = `${userId}:`;
  each(roleCaches, (cache) => {
    const stale = [...cache.keys()].filter((key) => key.startsWith(prefix));
    for (const key of stale) cache.delete(key);
  });
}

/**
 * Forget every cached token of one key (`mnemo_api_keys.id`), in this process,
 * so a revoked key is refused on its next request instead of up to 60 s later,
 * and a rotated one starts reporting its deprecation at once.
 */
export function forgetKeyAuth(keyId: string): void {
  each(keyCaches, (cache) => {
    const stale: string[] = [];
    for (const [token, entry] of cache.entries()) if (entry.actorId === keyId) stale.push(token);
    for (const token of stale) cache.delete(token);
  });
}
