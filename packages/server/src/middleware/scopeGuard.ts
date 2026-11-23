// Coarse API-key scope decision (F11).
//
// Historically an empty `scopes` array meant "legacy key = full access". That is
// a fail-open bypass: any key returned with [] silently skipped the scope guard.
// We now DENY empty-scope keys by default and only restore the legacy behavior
// behind the explicit MNEMO_ALLOW_LEGACY_FULL_SCOPE=true escape hatch.
//
// Pure function so it can be unit-tested without a Hono context.

export interface ScopeDecision {
  allowed: boolean;
  /** The scope(s) the route required (null when the route needs none; an array is any-of). */
  required: string | string[] | null;
  /** Human-readable denial reason (undefined when allowed). */
  reason?: string;
  /**
   * Machine-readable error code for the denial.
   * "EMPTY_SCOPE" — key has no scopes at all (F11 bypass disabled).
   * "INSUFFICIENT_SCOPE" — key has scopes but not the required one.
   * Absent when allowed.
   */
  code?: "EMPTY_SCOPE" | "INSUFFICIENT_SCOPE";
}

export interface ScopeGuardOptions {
  /**
   * When true, an empty `scopes` array is treated as legacy full access.
   * Boot path sets this from MNEMO_ALLOW_LEGACY_FULL_SCOPE === "true".
   * Default posture (false) DENIES empty-scope keys.
   */
  allowLegacyFullScope: boolean;
}

/**
 * MNEMO_ALLOW_LEGACY_FULL_SCOPE, read the same way by every transport that runs
 * decideScopeAccess (HTTP /v1, the dashboard API, gRPC), so they cannot
 * disagree on the override.
 */
export function legacyFullScopeAllowed(): boolean {
  return process.env.MNEMO_ALLOW_LEGACY_FULL_SCOPE === "true";
}

/**
 * `required` may be a single scope, an any-of list (e.g. a workspace-role
 * `read` member should satisfy a route via `memory:read` OR the broader
 * `memory:admin`), or null (no scope required).
 */
export function decideScopeAccess(
  scopes: ReadonlyArray<string> | undefined,
  required: string | string[] | null,
  opts: ScopeGuardOptions
): ScopeDecision {
  // Empty / missing scopes: deny unless the legacy override is enabled.
  if (!scopes || scopes.length === 0) {
    if (opts.allowLegacyFullScope) {
      return { allowed: true, required };
    }
    return {
      allowed: false,
      required,
      code: "EMPTY_SCOPE",
      reason:
        "API key has empty scope set — full-access bypass is disabled. " +
        "Mint a scoped key, or set MNEMO_ALLOW_LEGACY_FULL_SCOPE=true to allow " +
        "legacy empty-scope keys.",
    };
  }

  // Non-empty scopes: enforce the required scope (override does not relax this).
  // An array is any-of — at least one of the listed scopes must be present.
  const requiredList = required === null ? [] : Array.isArray(required) ? required : [required];
  if (requiredList.length > 0 && !requiredList.some((r) => scopes.includes(r))) {
    return {
      allowed: false,
      required,
      code: "INSUFFICIENT_SCOPE",
      reason: Array.isArray(required)
        ? `API key scope insufficient: requires one of [${required.join(", ")}]`
        : `API key scope insufficient: requires '${required}'`,
    };
  }
  return { allowed: true, required };
}
