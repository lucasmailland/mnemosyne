import bcrypt from "bcrypt";
import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import {
  routeInventory,
  openApiInventory,
  toColonPath,
  toBracePath,
  serializeRoute,
} from "./contract-inventory.js";

/**
 * B1.1 — smoke coverage for the two pure introspection helpers B2's
 * set-difference audit will consume. This file does not compute the four
 * set differences itself (that is B2's `contract-reality.test.ts`); it only
 * proves the two inventories are wired correctly against the real app.
 */

const PLAINTEXT_KEY = "mns_live_contractinventorytestkey1";
let app: ReturnType<typeof createApp>;
let authHeader: HeadersInit;

beforeAll(async () => {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  // Minimal deps — enough for `createApp` to synchronously register every
  // route (route registration never invokes `deps.core`/`deps.cognitive`;
  // those are only read lazily inside request handlers). Same minimal shape
  // already used by `restAliases.test.ts`, plus one valid key: empirically,
  // `GET /openapi.json` is mounted on the versioned sub-router and sits
  // behind the same auth middleware as every other route.
  const deps = {
    apiKeys: {
      listActive: async () => [
        {
          id: "key_contract_inventory",
          keyHash,
          workspaceId: "00000000-0000-0000-0000-0000000000c1",
          scopes: ["memory:read"],
        },
      ],
      touch: async () => {},
    },
    embedModel: "text-embedding-3-small",
    telemetry: {
      startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "0.0.0-test" });
  authHeader = { Authorization: `Bearer ${PLAINTEXT_KEY}` };
});

describe("routeInventory", () => {
  it("includes routes mounted deep inside the versioned sub-router", () => {
    const routes = routeInventory(app);
    expect(routes.some((r) => r.method === "POST" && r.path === "/recall")).toBe(true);
    // flatten-legacy-dual-core PR8: POST /facts was DELETED (D2 step 2);
    // POST /remember is its replacement write path, mounted the same way.
    expect(routes.some((r) => r.method === "POST" && r.path === "/remember")).toBe(true);
    expect(routes.some((r) => r.method === "GET" && r.path === "/openapi.json")).toBe(true);
  });

  it("includes root-level spec-exact aliases registered before the mount", () => {
    const routes = routeInventory(app);
    expect(routes.some((r) => r.method === "DELETE" && r.path === "/sessions/:id")).toBe(true);
  });

  it("excludes middleware (`.use()` registrations filed under method ALL)", () => {
    const routes = routeInventory(app);
    expect(routes.every((r) => r.method !== "ALL")).toBe(true);
  });

  it("returns a canonically sorted, de-duplicated list", () => {
    const routes = routeInventory(app);
    const keys = routes.map(serializeRoute);
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...keys].sort();
    // path-then-method sort and plain string sort agree once serialized as
    // "METHOD path" only when path is the primary key; verify no key is
    // out of its canonical relative position instead of assuming string
    // sort order matches exactly (methods are not prefixed by path there).
    expect(routes).toEqual(
      [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    );
    void sorted;
  });
});

describe("openApiInventory", () => {
  it("flattens the generated OpenAPI document's paths", async () => {
    const routes = await openApiInventory(app as any, { headers: authHeader });
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some((r) => r.method === "POST" && r.path === "/remember")).toBe(true);
  });

  it("uses OpenAPI brace-style params, distinct from Hono's colon style", async () => {
    const routes = await openApiInventory(app as any, { headers: authHeader });
    const paramRoute = routes.find((r) => r.path.includes("{"));
    expect(paramRoute).toBeDefined();
    expect(paramRoute?.path).not.toContain(":");
  });
});

describe("path-style canonicalization", () => {
  it("round-trips brace <-> colon param styles", () => {
    expect(toColonPath("/facts/{id}/pin")).toBe("/facts/:id/pin");
    expect(toBracePath("/facts/:id/pin")).toBe("/facts/{id}/pin");
    expect(toColonPath(toBracePath("/facts/:id"))).toBe("/facts/:id");
  });
});
