// Provenance identity — who/what acted, and on whose behalf.
//
// Root cause this fixes: `actorId` was specified as "the end-user this
// transaction speaks for" (see @mnemo-ai/core tx.ts) but got populated with
// the authenticating API key's own row id, with no way to tell the two
// apart at read time. Every write path then invented its own coercion
// between the two meanings (see CLAUDE.md "Provenance identity").
//
// The fix: three orthogonal fields, always computed together, never as a
// fallback chain of `a ?? b ?? c`:
//   - actorType: WHAT kind of principal acted (always present)
//   - actorId:   WHO acted — a namespaced ActorRef, never a bare id (always present)
//   - userId:    the platform account behind the action, when one exists (nullable)
//
// actorType/actorId answer "what credential acted"; userId answers "on whose
// behalf". They are not alternatives — one never falls back to the other.

/** What kind of principal performed an action. */
export type ActorType = "agent" | "user" | "system" | "federation";

/** The namespace prefix of an ActorRef — mirrors the `scopeOwner` convention (see primitives.ts). */
export type ActorNamespace = "user" | "key" | "system" | "peer";

/**
 * A namespaced, parseable actor identifier: `<namespace>:<id>`.
 *
 * | actorType     | form                                    | source                              |
 * |---------------|-----------------------------------------|--------------------------------------|
 * | `user`        | `user:<mnemo_user.id>`                  | key's bound user, or JWT-resolved account |
 * | `agent`       | `key:<mnemo_api_keys.id>`               | the authenticating key's own row id |
 * | `system`      | `system:<component>`                    | hardcoded per call site (e.g. `system:collapse`) |
 * | `federation`  | `peer:<instanceId>`                     | the remote peer's identity          |
 *
 * A bare, un-namespaced string (a raw key id, or the shared `apiKeyPrefix`
 * constant like `"mns_live_"`) is NEVER a valid ActorRef — see
 * `parseActorRef`, which rejects both.
 */
export type ActorRef = `${ActorNamespace}:${string}`;

export function formatActorRef(namespace: ActorNamespace, id: string): ActorRef {
  return `${namespace}:${id}`;
}

const ACTOR_NAMESPACES: ReadonlySet<string> = new Set<ActorNamespace>([
  "user",
  "key",
  "system",
  "peer",
]);

/**
 * Parse a namespaced ActorRef. Returns null for anything that isn't one —
 * including bare ids and known non-identity constants like an apiKeyPrefix
 * (`mns_live_`, `mk_admin_`, etc.), which must never be mistaken for an
 * ActorRef.
 */
export function parseActorRef(value: string): { namespace: ActorNamespace; id: string } | null {
  const idx = value.indexOf(":");
  if (idx <= 0) return null;
  const namespace = value.slice(0, idx);
  const id = value.slice(idx + 1);
  if (!id || !ACTOR_NAMESPACES.has(namespace)) return null;
  return { namespace: namespace as ActorNamespace, id };
}

/**
 * The identity triple every write path must produce, computed in one place
 * (server-side `resolveProvenance()`) — never assembled ad hoc per route via
 * a fallback chain.
 *
 * Not to be confused with `Provenance` in recall.ts, which is the
 * epistemological-origin enum (`"user_stated" | "objective_fact" | ...`,
 * the `attribution` column) — a different, pre-existing concept. This one is
 * about WHO/WHAT acted; that one is about HOW a memory came to be known.
 */
export interface ActorProvenance {
  /** WHAT kind of principal acted. Always present. */
  actorType: ActorType;
  /** WHO acted — namespaced, parseable, never a bare id. Always present. */
  actorId: ActorRef;
  /** The platform account behind the action, when one exists. null otherwise. */
  userId: string | null;
}
