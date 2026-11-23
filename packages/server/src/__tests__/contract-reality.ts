import type { InventoryRoute } from "./contract-inventory.js";
import { toColonPath } from "./contract-inventory.js";

/**
 * Pure set-difference logic for the contract-reality audit (Phase 2, B2,
 * Req 12). Split from `contract-reality.test.ts` so the algorithm is
 * unit-testable against in-memory fixtures, matching the established
 * `api-path-truth.census.ts` / `.test.ts` split (A5.2).
 *
 * Four findings, per design.md "B2. The audit itself":
 *  - phantom:       openApiPaths \ routePaths       (documented, not implemented)
 *  - undocumented:  routePaths \ openApiPaths        (implemented, not documented)
 *  - ghost-caller:  (mcp ∪ cli ∪ sdk) \ routePaths   (a caller invokes a route that doesn't exist)
 *  - unreachable:   routePaths \ (mcp ∪ cli ∪ sdk)   (no caller ever reaches this route)
 */

/** One recorded call from an MCP tool, CLI command, or SDK method (B1.2/B1.3/B1.4 snapshots). */
export interface CallerCall {
  /** Which introspected surface produced this call, e.g. "mcp", "cli", "sdk". */
  source: string;
  /** The tool/command/method key within that surface, e.g. "memory_forget:task". */
  key: string;
  method: string;
  /** Concrete, interpolated path as actually issued (e.g. "/facts/fact_1"), not a template. */
  path: string;
}

/** `"METHOD path"` canonical key. */
function key(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * Converts a Hono route template (colon-style, e.g. "/facts/:id/pin") into a
 * regex that matches a CONCRETE interpolated path (e.g. "/facts/fact_1/pin").
 * Every `:param` segment matches one non-empty path segment.
 */
function templateToRegex(template: string): RegExp {
  const escaped = template
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("/");
  return new RegExp(`^${escaped}$`);
}

/** True if `concretePath` is an instance of `template` (colon-style route pattern). */
export function matchesRouteTemplate(concretePath: string, template: string): boolean {
  return templateToRegex(template).test(concretePath);
}

export interface PhantomUndocumentedResult {
  /** `"METHOD colon-path"` entries documented in the OpenAPI spec with no matching registered route. */
  phantom: string[];
  /** `"METHOD colon-path"` entries registered as real routes with no OpenAPI spec entry. */
  undocumented: string[];
}

/**
 * Requirement 12(a): OpenAPI spec vs registered Hono routes.
 *
 * Both inventories are canonicalized to Hono's own colon-style path params
 * before comparison (`toColonPath` converts the OpenAPI document's
 * brace-style `{id}` params) so `/facts/{id}` and `/facts/:id` compare equal.
 */
export function diffPhantomUndocumented(
  routes: readonly InventoryRoute[],
  openApi: readonly InventoryRoute[]
): PhantomUndocumentedResult {
  const routeKeys = new Set(routes.map((r) => key(r.method, r.path)));
  const openApiKeys = new Set(openApi.map((r) => key(r.method, toColonPath(r.path))));

  const phantom = [...openApiKeys].filter((k) => !routeKeys.has(k)).sort();
  const undocumented = [...routeKeys].filter((k) => !openApiKeys.has(k)).sort();

  return { phantom, undocumented };
}

export interface GhostUnreachableResult {
  /** `"source:key METHOD /concrete/path"` — a caller invoked a (method, path) with no matching registered route. */
  ghostCallers: string[];
  /** `"METHOD colon-path"` — a real registered route no MCP tool, CLI command, or SDK method ever calls. */
  unreachable: string[];
}

/**
 * Requirement 12(b)/(c)/(d): every MCP tool, CLI command, and SDK method's
 * recorded (method, concrete path) vs the real route templates.
 *
 * A concrete recorded call (e.g. `GET /facts/fact_1`) is matched against
 * every route template (e.g. `GET /facts/:id`) via regex, since callers
 * record interpolated fixture values, not templates. A call matching NO
 * template is a ghost caller; a template matched by NO call is unreachable.
 */
export function diffGhostAndUnreachable(
  routes: readonly InventoryRoute[],
  calls: readonly CallerCall[]
): GhostUnreachableResult {
  const reachedTemplates = new Set<string>();
  const ghostCallers = new Set<string>();

  for (const call of calls) {
    const matches = routes.filter(
      (r) => r.method === call.method && matchesRouteTemplate(call.path, r.path)
    );
    if (matches.length === 0) {
      ghostCallers.add(`${call.source}:${call.key} ${call.method} ${call.path}`);
      continue;
    }
    for (const m of matches) reachedTemplates.add(key(m.method, m.path));
  }

  const unreachable = routes
    .map((r) => key(r.method, r.path))
    .filter((k) => !reachedTemplates.has(k))
    .sort();

  return {
    ghostCallers: [...ghostCallers].sort(),
    unreachable: [...new Set(unreachable)].sort(),
  };
}

/** Flattens a committed B1 snapshot into `CallerCall[]`, tagging each with its source surface. */
export function flattenCallerSnapshot(
  source: string,
  snapshot: Record<string, unknown>
): CallerCall[] {
  const calls: CallerCall[] = [];
  for (const [callerKey, records] of Object.entries(snapshot)) {
    // B1.3's snapshot carries string entries for explicitly skipped commands
    // (e.g. "init (skipped)": "spawns docker, ..."). Those values are
    // human-readable reasons, not {method,path} records — skip non-arrays.
    if (!Array.isArray(records)) continue;
    for (const record of records as ReadonlyArray<{ method: string; path: string }>) {
      calls.push({ source, key: callerKey, method: record.method, path: record.path });
    }
  }
  return calls;
}
