import type { Hono } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";

/**
 * Pure introspection helpers for the contract-reality audit (Phase 2, B1).
 *
 * Empirically confirmed (see the sibling `contract-inventory.test.ts`)
 * against the real `createApp()`: Hono's `app.route(path, subApp)` iterates
 * `subApp.routes` and re-registers each entry onto the PARENT app via its
 * own `#addRoute`, so the parent's own `.routes` array ends up flat and
 * complete — it already contains every route mounted on the versioned
 * sub-router, with the mount prefix applied, plus every route registered
 * directly on the root app (the spec-exact aliases). No fallback
 * introspection of the sub-router is needed; reading `app.routes` after
 * `createApp()` returns is sufficient on its own.
 *
 * `RouterRoute` (`{ basePath, path, method, handler }`) is Hono's own
 * per-route bookkeeping type, but it is an internal shape not re-exported
 * from the package's public entry point — we narrow structurally instead of
 * importing it.
 */
interface RawRouterRoute {
  method: string;
  path: string;
}

/** One entry in either inventory: an HTTP verb paired with a path. */
export interface InventoryRoute {
  method: string;
  path: string;
}

/**
 * Reads the app's own flat route table and returns every REGISTERED
 * endpoint — i.e. excludes Hono's `.use()`-registered middleware, which
 * Hono internally files under the synthetic method `"ALL"`. The app never
 * registers a genuine catch-all handler via `.all(...)`, so filtering out
 * `"ALL"` entries removes only middleware, never a real endpoint.
 */
export function routeInventory(app: Hono): InventoryRoute[] {
  const routes = (app as unknown as { routes: RawRouterRoute[] }).routes;
  const seen = new Set<string>();
  const out: InventoryRoute[] = [];
  for (const r of routes) {
    if (r.method === "ALL") continue; // middleware registered via `.use()`
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return canonicalSort(out);
}

/** Minimal shape of the generated OpenAPI document this helper actually reads. */
interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
}

const HTTP_METHOD_KEYS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

/**
 * Requests the in-process `/openapi.json` document (no server boot, no
 * Docker — `mountOpenApi` already serves it on the same app instance) and
 * flattens its `paths` object into the same `{method, path}` shape as
 * {@link routeInventory}.
 *
 * Empirically confirmed: `mountOpenApi` is called on the versioned
 * sub-router, so `GET /openapi.json` sits behind the same auth middleware
 * as every other route once merged onto the parent app — it is NOT a
 * public, unauthenticated endpoint. Callers running against a real
 * `createApp()` MUST pass a valid `Authorization` header via `init`.
 *
 * OpenAPI path templates use brace-style params (e.g. `/facts/{id}`);
 * Hono's own route paths use colon-style (`/facts/:id`). This helper
 * returns paths verbatim in OpenAPI's own brace style — callers that need
 * to compare the two inventories against each other should route both
 * through {@link toColonPath} (or {@link toBracePath}) first.
 */
export async function openApiInventory(
  app: OpenAPIHono<any>,
  init?: RequestInit
): Promise<InventoryRoute[]> {
  const res = await app.request("/openapi.json", init);
  if (!res.ok) {
    throw new Error(
      `openApiInventory: GET /openapi.json returned ${res.status} — pass a valid Authorization header via init.`
    );
  }
  const doc = (await res.json()) as OpenApiDocument;
  const out: InventoryRoute[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      if (!HTTP_METHOD_KEYS.has(method)) continue; // skip non-method keys (e.g. "parameters")
      out.push({ method: method.toUpperCase(), path });
    }
  }
  return canonicalSort(out);
}

/** Deterministic ordering so snapshot diffs are stable across runs. */
export function canonicalSort(routes: readonly InventoryRoute[]): InventoryRoute[] {
  return [...routes].sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) return byPath;
    return a.method.localeCompare(b.method);
  });
}

/** `"METHOD path"` — the canonical string key used for set comparisons and snapshots. */
export function serializeRoute(route: InventoryRoute): string {
  return `${route.method} ${route.path}`;
}

/** OpenAPI brace-style params (`{id}`) → Hono colon-style (`:id`). */
export function toColonPath(bracePath: string): string {
  return bracePath.replace(/\{([^}]+)\}/g, ":$1");
}

/** Hono colon-style params (`:id`) → OpenAPI brace-style (`{id}`). */
export function toBracePath(colonPath: string): string {
  return colonPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}
