/**
 * Mnemosyne — Sensitivity-ceiling RBAC middleware (TASK-7003).
 *
 * Security contract (AUDIT_REPORT.md MED-23):
 *
 *   NEVER compare sensitivity levels with string equality.
 *   ALWAYS use SENSITIVITY_ORDER numeric comparison. String equality was the
 *   bug in MED-23: "confidential" > "internal" evaluates to false in JS
 *   dictionary order, which let restricted facts leak to internal-ceiling agents.
 *
 * Usage — enforce ceiling before returning facts to callers:
 *
 *   const facts = await storage.queryFacts(filter);
 *   return facts.filter(f => canRead(auth, f.sensitivity));
 *
 * The SENSITIVITY_ORDER and canRead/canWrite helpers are exported so
 * route handlers and core services can reuse them directly without
 * re-importing from @mnemo-ai/types.
 */

import type { AuthContext } from "./auth.js";
import { SENSITIVITY_ORDER } from "@mnemo-ai/types";
import type { Sensitivity } from "@mnemo-ai/types";
import { HttpError } from "../errors.js";

export type { Sensitivity };

// ─── Read / write ceiling checks ─────────────────────────────────────────────

/**
 * Returns true iff the authenticated agent may READ a fact at the given
 * sensitivity level.
 *
 * Defaulting to "internal" rather than "public" means that agents without
 * an explicit policy can read standard workspace facts but not confidential
 * or restricted material. This is the principle of least privilege.
 */
export function canRead(
  auth: AuthContext & { agentAccess?: { readScopes?: { maxSensitivity?: Sensitivity } } },
  factSensitivity: Sensitivity
): boolean {
  const maxAllowed: Sensitivity = auth.agentAccess?.readScopes?.maxSensitivity ?? "internal";
  return SENSITIVITY_ORDER[factSensitivity] <= SENSITIVITY_ORDER[maxAllowed];
}

/**
 * Returns true iff the authenticated agent may WRITE a fact at the given
 * sensitivity level.
 *
 * Write ceiling defaults to "internal" (stricter than read-default for most
 * deployments where agents are allowed to READ their own past facts).
 */
export function canWrite(
  auth: AuthContext & { agentAccess?: { writeScopes?: { maxSensitivity?: Sensitivity } } },
  factSensitivity: Sensitivity
): boolean {
  const maxAllowed: Sensitivity = auth.agentAccess?.writeScopes?.maxSensitivity ?? "internal";
  return SENSITIVITY_ORDER[factSensitivity] <= SENSITIVITY_ORDER[maxAllowed];
}

/**
 * Returns true iff levelA is at least as sensitive as levelB.
 * Useful for "is this fact too sensitive for this agent?" guards:
 *
 *   if (sensitivityAtLeast(fact.sensitivity, agentCeiling)) throw forbidden()
 */
export function sensitivityAtLeast(a: Sensitivity, b: Sensitivity): boolean {
  return SENSITIVITY_ORDER[a] >= SENSITIVITY_ORDER[b];
}

// ─── Fact sensitivity filter ──────────────────────────────────────────────────

/**
 * Filter a list of items that have a `sensitivity` field, keeping only
 * those the agent may read. Call this before returning facts to callers.
 *
 * Example:
 *   const visible = filterBySensitivity(auth, facts);
 *   return c.json({ hits: visible });
 */
export function filterBySensitivity<T extends { sensitivity?: Sensitivity }>(
  auth: AuthContext & { agentAccess?: { readScopes?: { maxSensitivity?: Sensitivity } } },
  items: T[]
): T[] {
  return items.filter((item) => canRead(auth, item.sensitivity ?? "internal"));
}

// ─── Scope check ─────────────────────────────────────────────────────────────

/**
 * Returns true iff the auth context includes the required scope.
 * Used by route handlers to short-circuit before any storage call.
 *
 * Example:
 *   if (!hasScope(auth, "memory:write")) throw new ForbiddenError(...)
 */
export function hasScope(auth: Pick<AuthContext, "scopes">, required: string): boolean {
  return (auth.scopes as ReadonlyArray<string>).includes(required);
}

/**
 * Throws ForbiddenError if the auth context is missing any of the required
 * scopes. Prefer `requireScopes` over `hasScope` in route handlers so the
 * error format is consistent and the check is not accidentally skipped.
 */
export function requireScopes(auth: Pick<AuthContext, "scopes">, ...required: string[]): void {
  for (const scope of required) {
    if (!hasScope(auth, scope)) {
      throw new RbacError(`Missing required scope: ${scope}`, {
        required: scope,
        granted: [...auth.scopes],
      });
    }
  }
}

// ─── Error type ───────────────────────────────────────────────────────────────

/**
 * Thrown when a scope or sensitivity ceiling check fails.
 *
 * Extends HttpError so the global error handler's `toErrorBody()` (errors.ts)
 * actually maps this to HTTP 403 — `toErrorBody()` special-cases HttpError
 * only, and coerces anything else (including a plain `Error` with a `status`
 * field merely declared, not inherited) to a 500 `internal_error`. Prior to
 * this fix `RbacError extends Error` silently produced 500s on every scope
 * failure despite the docstring's claim.
 *
 * Code is "INSUFFICIENT_SCOPE" (not a generic "forbidden") so an inline
 * `requireScopes()` rejection is byte-identical to the central
 * `getScopeForRequest()` router-gate rejection — a caller cannot fingerprint
 * which layer denied it.
 */
export class RbacError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(403, "INSUFFICIENT_SCOPE", message, details);
    this.name = "RbacError";
  }
}
