import type { Context } from "hono";
import type { ActorProvenance, ActorRef } from "@mnemo-ai/types";
import { formatActorRef } from "@mnemo-ai/types";

import { ForbiddenError } from "./errors.js";
import type { AuthVariables } from "./auth.js";

/**
 * The single place every write path resolves "who acted" from the
 * authenticated Hono context. Replaces the ~20 ad-hoc fallback chains
 * (`userId ?? apiKeyPrefix ?? "api"`, `actorId ?? apiKeyPrefix`, etc.) that
 * used to be scattered per-route with inconsistent, sometimes-inverted
 * priority — see CLAUDE.md "Provenance identity".
 *
 * No `??` chains here. `actorId`/`userId`/`actorType` are read directly from
 * whatever the auth middleware (auth.ts) already resolved; this function
 * only namespaces `actorId` into a well-formed `ActorRef` and picks a
 * conservative default `actorType` for the (should-be-impossible)
 * unauthenticated case. `apiKeyPrefix` is NEVER read here — it is a shared
 * constant (e.g. "mns_live_"), not an identity, and must not leak into
 * provenance.
 *
 * Password dashboard sessions set actorRefKind=user and use user:<mnemo_user.id>.
 * `actorId` is namespaced as `key:<mnemo_api_keys.id>` for every current key
 * kind, including `mk_fed_` federation keys — `AuthVariables` has no separate
 * peer-identity field distinct from the key's own row id today, so a
 * federation key's `ActorRef` is its key id, same as any other key. If a
 * real peer identity becomes available on context in the future, route it
 * to `formatActorRef("peer", ...)` here.
 *
 * `actorType` prefers whatever auth.ts already decided (`c.get("actorType")`)
 * — that is the point in the request lifecycle with the most signal (key
 * kind, prefix, userId binding). NOTE: auth.ts currently hardcodes `"user"`
 * for every legacy `mns_*` key regardless of whether it's actually a human
 * or a service/workspace key (see the comment at its `c.set("actorType",
 * "user")` call) — that is a known, pre-existing gap in the auth layer
 * itself, out of scope here; this function faithfully surfaces whatever
 * auth.ts decided rather than re-deriving (and potentially diverging from)
 * that decision. Only when `actorType` is somehow absent (should not happen
 * for an authenticated request) does this function fall back to a
 * conservative default: `"user"` when a `userId` is bound, else `"agent"` —
 * never invents `"system"`/`"federation"` from nothing.
 */
export function resolveProvenance(c: Context<{ Variables: AuthVariables }>): ActorProvenance {
  const rawActorId = c.get("actorId");
  if (!rawActorId) {
    throw new Error(
      "resolveProvenance() called before auth middleware populated actorId — this route is not authenticated"
    );
  }

  const userId = c.get("userId") ?? null;
  const explicitActorType = c.get("actorType");
  const actorType = explicitActorType ?? (userId ? "user" : "agent");

  const actorId: ActorRef = formatActorRef(c.get("actorRefKind") ?? "key", rawActorId);

  return { actorType, actorId, userId };
}

/** Operator configuration binds a traffic class to an authenticated principal.
 * A free request field can assert that binding, never grant it. */
export function resolveTrafficOrigin(
  c: Context<{ Variables: AuthVariables }>,
  bindings: Readonly<Record<string, import("@mnemo-ai/types").TrafficOrigin>> = {},
  requested?: import("@mnemo-ai/types").TrafficOrigin
): import("@mnemo-ai/types").TrafficOrigin {
  const actor = resolveProvenance(c);
  const origin = bindings[actor.actorId] ?? "organic";
  if (requested && requested !== origin && requested !== "unknown") {
    throw new ForbiddenError("Traffic origin is not authorized for this credential");
  }
  c.set("trafficOrigin", origin);
  return origin;
}

/** Recall effects for the authenticated principal: synthetic traffic retrieves
 * but never trains the organic corpus. Every recall entry point uses this. */
export function resolveRecallEffects(
  c: Context<{ Variables: AuthVariables }>,
  bindings?: Readonly<Record<string, import("@mnemo-ai/types").TrafficOrigin>>
): import("@mnemo-ai/types").RecallEffectsContext {
  return recallEffectsFor(c.get("trafficOrigin") ?? resolveTrafficOrigin(c, bindings));
}

export function recallEffectsFor(
  trafficOrigin: import("@mnemo-ai/types").TrafficOrigin
): import("@mnemo-ai/types").RecallEffectsContext {
  return { trafficOrigin, applyOrganicEffects: trafficOrigin === "organic" };
}

/** Invalid operator bindings fail closed at startup. Values are actor refs, never secrets. */
export function parseTrafficOriginBindings(
  value?: string
): Readonly<Record<string, import("@mnemo-ai/types").TrafficOrigin>> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid MNEMO_TRAFFIC_ORIGINS");
  for (const [actor, origin] of Object.entries(parsed)) {
    if (
      !/^(key|user):[^\s]+$/.test(actor) ||
      !["organic", "evaluation", "installer_verify", "unknown"].includes(String(origin))
    )
      throw new Error("Invalid MNEMO_TRAFFIC_ORIGINS binding");
  }
  return parsed as Record<string, import("@mnemo-ai/types").TrafficOrigin>;
}
