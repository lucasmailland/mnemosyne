import type { Context } from "hono";
import { SENSITIVITY_ORDER, type Sensitivity, type StorageAdapter } from "@mnemo-ai/types";
import type { AuthVariables } from "./auth.js";
import { HttpError, NotFoundError } from "./errors.js";

/**
 * Sensitivity-ceiling enforcement (TASK-7003, fixes MED-23).
 *
 * Every comparison goes through SENSITIVITY_ORDER's numeric mapping.
 * NEVER compare sensitivity strings directly — alphabetical order does
 * not match the privilege order (public < internal < confidential < restricted).
 *
 * Per-key ceilings: the effective recall ceiling for a request is the MORE
 * RESTRICTIVE of (a) the process-wide MNEMO_SENSITIVITY_CEILING and (b) the
 * authenticating key's maxSensitivity grant when present (carried on
 * AuthVariables by the scoped-key auth path). See effectiveCeiling() — a key
 * can only LOWER its ceiling below the process limit, never raise it. Keys
 * without a per-key grant (e.g. legacy mns_* keys) leave it undefined → the
 * process-wide ceiling applies unchanged.
 */

/** Facts without an explicit sensitivity are treated as this level. */
export const DEFAULT_SENSITIVITY: Sensitivity = "internal";

const VALID_LEVELS = new Set<string>(Object.keys(SENSITIVITY_ORDER));

/** True if a caller with `ceiling` may read content marked `factSensitivity`. */
export function canReadSensitivity(
  ceiling: Sensitivity,
  factSensitivity: Sensitivity | string | undefined
): boolean {
  const level = (
    factSensitivity && VALID_LEVELS.has(factSensitivity) ? factSensitivity : DEFAULT_SENSITIVITY
  ) as Sensitivity;
  return SENSITIVITY_ORDER[level] <= SENSITIVITY_ORDER[ceiling];
}

/** Keeps only the items the caller's ceiling allows. */
export function filterBySensitivity<T extends { sensitivity?: string }>(
  items: readonly T[],
  ceiling: Sensitivity
): T[] {
  return items.filter((item) => canReadSensitivity(ceiling, item.sensitivity));
}

/** Parses MNEMO_SENSITIVITY_CEILING; invalid/missing values fall back safely. */
export function resolveDefaultCeiling(raw: string | undefined): Sensitivity {
  return raw && VALID_LEVELS.has(raw) ? (raw as Sensitivity) : DEFAULT_SENSITIVITY;
}

/**
 * The effective recall ceiling for a request: the MOST RESTRICTIVE of the
 * process-wide env ceiling and the request key's per-key grant (when present).
 *
 * "Most restrictive" = the lower tier in SENSITIVITY_ORDER (never a string
 * comparison — alphabetical order is semantically wrong, MED-23). A per-key
 * grant can therefore only LOWER the ceiling below the process limit, never
 * raise it. When the key carries no grant (`keyMax` undefined), the env ceiling
 * is returned unchanged — preserving the existing default behaviour.
 */
export function effectiveCeiling(
  envCeiling: Sensitivity,
  keyMax: Sensitivity | undefined
): Sensitivity {
  if (!keyMax) return envCeiling;
  return SENSITIVITY_ORDER[keyMax] <= SENSITIVITY_ORDER[envCeiling] ? keyMax : envCeiling;
}

/**
 * Resolves the effective sensitivity ceiling for the current request.
 * Combines the process-wide env ceiling with the per-key grant (if any).
 * Use this at the top of any handler that returns sensitive content.
 */
export function resolveCeiling(c: Context<{ Variables: AuthVariables }>): Sensitivity {
  return effectiveCeiling(
    resolveDefaultCeiling(process.env.MNEMO_SENSITIVITY_CEILING),
    c.get("maxSensitivity")
  );
}

/**
 * Throws NotFoundError (404, not 403) when the caller's ceiling does not permit
 * reading `factSensitivity`. Anti-probing: never confirm a resource exists.
 *
 * Drop-in replacement for the repeated 4-line block:
 *   const ceiling = effectiveCeiling(resolveDefaultCeiling(...), c.get("maxSensitivity"));
 *   if (!canReadSensitivity(ceiling, fact.sensitivity)) throw new NotFoundError(...);
 */
export function assertCanReadFact(
  c: Context<{ Variables: AuthVariables }>,
  factId: string,
  sensitivity: Sensitivity | string | undefined,
  /** The kind the route names in its own "not found" (`Task`, `Entity`…), so a
   * hidden row's 404 reads word for word like a missing one's. */
  label = "Fact"
): void {
  if (!canReadSensitivity(resolveCeiling(c), sensitivity)) {
    throw new NotFoundError(`${label} ${factId} not found`);
  }
}

/**
 * The ids among `ids` that name a row above the caller's ceiling (an id that
 * resolves to nothing is not hidden). One lookup, none when nothing could be.
 */
export async function findHiddenFor(
  c: Context<{ Variables: AuthVariables }>,
  storage: Pick<StorageAdapter, "findHiddenIds">,
  workspaceId: string,
  ids: string[]
): Promise<Set<string>> {
  const ceiling = resolveCeiling(c);
  if (ids.length === 0 || ceiling === "restricted") return new Set();
  return new Set(await storage.findHiddenIds({ workspaceId, ids, maxSensitivity: ceiling }));
}

/**
 * `rows` with every id pointer to a row above the caller's ceiling dropped: an
 * id list leaves it out and a single id field reads as a missing target does —
 * null for `ids`, absent for `optionalIds` (fields a missing target leaves out
 * of the body) — so a response never names what the caller cannot read (the
 * 404 rule applied to ids). One lookup per response, none when nothing could
 * be hidden.
 */
export async function dropHiddenPointers<T extends object>(
  c: Context<{ Variables: AuthVariables }>,
  storage: Pick<StorageAdapter, "findHiddenIds">,
  workspaceId: string,
  rows: T[],
  fields: { lists?: Array<keyof T>; ids?: Array<keyof T>; optionalIds?: Array<keyof T> }
): Promise<T[]> {
  const lists = fields.lists ?? [];
  const ids = fields.ids ?? [];
  const optionalIds = fields.optionalIds ?? [];
  const named = new Set<string>();
  for (const row of rows) {
    for (const k of lists) for (const id of (row[k] as string[] | undefined) ?? []) named.add(id);
    for (const k of [...ids, ...optionalIds])
      if (typeof row[k] === "string") named.add(row[k] as string);
  }
  const hidden = await findHiddenFor(c, storage, workspaceId, [...named]);
  if (hidden.size === 0) return rows;
  return rows.map((row) => {
    const out: Partial<Record<keyof T, unknown>> = { ...row };
    for (const k of lists) {
      const list = row[k] as string[] | undefined;
      if (list) out[k] = list.filter((id) => !hidden.has(id));
    }
    for (const k of ids) if (hidden.has(row[k] as string)) out[k] = null;
    for (const k of optionalIds) if (hidden.has(row[k] as string)) delete out[k];
    return out as T;
  });
}

/**
 * PRIM-14: refuses a write whose sensitivity is above the caller's own read
 * ceiling. The row could never be read back by its writer (GET, list and recall
 * all answer 404), so it is not stored (`create`) or not changed (`update`,
 * PATCH /events/:id/sensitivity). 404 per the ceiling rule (S6), with its own
 * code; never silently downgraded. Same status and code as POST /remember.
 * `sensitivity` undefined means the default tier.
 */
export function assertCanWriteSensitivity(
  c: Context<{ Variables: AuthVariables }>,
  sensitivity: Sensitivity | string | undefined,
  write: "create" | "update" = "create"
): void {
  const ceiling = resolveCeiling(c);
  if (canReadSensitivity(ceiling, sensitivity)) return;
  const requested = sensitivity ?? DEFAULT_SENSITIVITY;
  throw new HttpError(
    404,
    "sensitivity_above_ceiling",
    write === "update"
      ? `sensitivity '${requested}' is above this credential's read ceiling ('${ceiling}'); the event could never be read again, so it was not changed.`
      : `sensitivity '${requested}' is above this credential's read ceiling ('${ceiling}'); the memory could never be read back, so it was not stored.`,
    { sensitivity: requested, ceiling }
  );
}

/**
 * Returns true if `fromAgentId` may delegate a task to `toAgentId`.
 *
 * Self and empty targets are always rejected.
 * When `allowList` is provided it is the policy's `taskScopes.canDelegateTo`:
 *   - `["*"]` permits any non-self target.
 *   - a non-empty list permits only its members.
 *   - `[]` denies all targets.
 * When `allowList` is omitted, the legacy self/empty-only check applies.
 */
export function canDelegateTo(
  fromAgentId: string,
  toAgentId: string,
  allowList?: readonly string[]
): boolean {
  if (!toAgentId || toAgentId === fromAgentId) return false;
  if (allowList === undefined) return true;
  if (allowList.includes("*")) return true;
  return allowList.includes(toAgentId);
}
