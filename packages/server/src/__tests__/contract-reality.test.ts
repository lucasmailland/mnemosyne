import bcrypt from "bcrypt";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import {
  openApiInventory,
  routeInventory,
  serializeRoute,
  toColonPath,
  type InventoryRoute,
} from "./contract-inventory.js";
import {
  diffGhostAndUnreachable,
  diffPhantomUndocumented,
  flattenCallerSnapshot,
  matchesRouteTemplate,
  type CallerCall,
} from "./contract-reality.js";
import { EXPECTED_DIVERGENCES } from "./contract-reality.allowlist.js";

/**
 * B2.1 — the contract-reality audit's four set differences (Req 12).
 *
 * Mechanical and re-runnable, per design.md B0 ("the audit is executable, not
 * a document"): every finding below is recomputed from a real `createApp()`
 * instance plus B1's three committed caller-route snapshots on every test
 * run, never hand-maintained.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function allowlistedKeys(kind: (typeof EXPECTED_DIVERGENCES)[number]["kind"]): Set<string> {
  const keys = new Set<string>();
  for (const d of EXPECTED_DIVERGENCES) {
    if (d.kind !== kind) continue;
    for (const k of d.keys) keys.add(k);
  }
  return keys;
}

describe("contract-reality: pure set-difference logic (in-memory fixtures)", () => {
  const routes: InventoryRoute[] = [
    { method: "GET", path: "/facts/:id" },
    { method: "POST", path: "/facts" },
    { method: "GET", path: "/only-in-routes" },
  ];

  it("diffPhantomUndocumented finds phantom (OpenAPI-only) and undocumented (route-only) entries", () => {
    const openApi: InventoryRoute[] = [
      { method: "GET", path: "/facts/{id}" }, // matches routes (brace vs colon)
      { method: "POST", path: "/facts" }, // matches routes
      { method: "GET", path: "/only-in-openapi" }, // phantom
    ];
    const { phantom, undocumented } = diffPhantomUndocumented(routes, openApi);
    expect(phantom).toEqual(["GET /only-in-openapi"]);
    expect(undocumented).toEqual(["GET /only-in-routes"]);
  });

  it("diffGhostAndUnreachable matches a concrete caller path against a colon-style route template", () => {
    expect(matchesRouteTemplate("/facts/fact_1", "/facts/:id")).toBe(true);
    expect(matchesRouteTemplate("/facts/fact_1/pin", "/facts/:id")).toBe(false);
  });

  it("flags a ghost caller: a call whose (method, path) matches no route template", () => {
    const calls: CallerCall[] = [
      { source: "mcp", key: "memory_get_fact", method: "GET", path: "/facts/fact_1" }, // matches GET /facts/:id
      { source: "cli", key: "bogus", method: "POST", path: "/does/not/exist" }, // ghost
    ];
    const { ghostCallers, unreachable } = diffGhostAndUnreachable(routes, calls);
    expect(ghostCallers).toEqual(["cli:bogus POST /does/not/exist"]);
    // /facts/:id was reached; /facts and /only-in-routes were not.
    expect(unreachable).toEqual(["GET /only-in-routes", "POST /facts"]);
  });

  it("flattenCallerSnapshot skips non-array entries (B1.3's skip-reason strings)", () => {
    const snapshot = {
      real: [{ method: "GET", path: "/x" }],
      "skipped (skipped)": "spawns docker",
    };
    const calls = flattenCallerSnapshot("cli", snapshot);
    expect(calls).toEqual([{ source: "cli", key: "real", method: "GET", path: "/x" }]);
  });
});

describe("contract-reality: real repo audit (Req 12)", () => {
  it("computes all four set differences against the real app + committed B1 snapshots", async () => {
    const PLAINTEXT_KEY = "mns_live_contractrealitytestkey00001";
    const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);

    // Full-surface deps: every conditionally-mounted route family
    // (federation, admin keys/tenants/workspaces, approvals, break-glass)
    // is gated behind a truthy `deps` field at REGISTRATION time only —
    // none of these stubs is ever invoked by a handler in this test (only
    // `routeInventory`/`openApiInventory` run, never a substantive request).
    // Omitting them would silently shrink the "real" route inventory to a
    // subset of production and misreport every route in those families as a
    // false-positive ghost-caller/phantom finding — confirmed empirically
    // while authoring this test (see this task's return summary).
    const deps = {
      apiKeys: {
        listActive: async () => [
          {
            id: "key_contract_reality",
            keyHash,
            workspaceId: "00000000-0000-0000-0000-0000000000c2",
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
      metricsPgClient: (() => {}) as unknown,
      federation: {} as unknown,
      approvals: {} as unknown,
      breakGlass: {} as unknown,
      scopedKeyStore: {} as unknown,
    } as unknown as ServerDeps;

    const app = createApp({ deps, version: "0.0.0-test" });
    const routes = routeInventory(app);
    const openApi = await openApiInventory(app as any, {
      headers: { Authorization: `Bearer ${PLAINTEXT_KEY}` },
    });

    const mcpSnapshot = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/mcp/src/__tests__/tool-routes.snapshot.json"), "utf8")
    );
    const cliSnapshot = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "packages/cli/src/__tests__/command-routes.snapshot.json"),
        "utf8"
      )
    );
    const sdkSnapshot = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "packages/client-ts/src/__tests__/sdk-routes.snapshot.json"),
        "utf8"
      )
    );
    const calls: CallerCall[] = [
      ...flattenCallerSnapshot("mcp", mcpSnapshot),
      ...flattenCallerSnapshot("cli", cliSnapshot),
      ...flattenCallerSnapshot("sdk", sdkSnapshot),
    ];

    const { phantom, undocumented } = diffPhantomUndocumented(routes, openApi);
    const { ghostCallers, unreachable } = diffGhostAndUnreachable(routes, calls);

    // Requirement 12, scenario "Phantom endpoint is flagged" / "Undocumented
    // endpoint is flagged" / ghost-caller / unreachable: any finding not
    // covered by a reviewed EXPECTED_DIVERGENCES entry of the matching kind
    // fails here — this is the regression guard (mirrors api-path-truth's
    // allowlist mechanic, applied to contract shape).
    const unexpectedPhantom = phantom.filter((k) => !allowlistedKeys("phantom").has(k));
    const unexpectedUndocumented = undocumented.filter(
      (k) => !allowlistedKeys("undocumented").has(k)
    );
    const unexpectedGhostCallers = ghostCallers.filter(
      (k) => !allowlistedKeys("ghost-caller").has(k)
    );
    const unexpectedUnreachable = unreachable.filter((k) => !allowlistedKeys("unreachable").has(k));

    expect(unexpectedPhantom).toEqual([]);
    expect(unexpectedUndocumented).toEqual([]);
    expect(unexpectedGhostCallers).toEqual([]);
    expect(unexpectedUnreachable).toEqual([]);

    // The canonical merged snapshot this audit runs against (B2.1) — distinct
    // from B1's four per-surface snapshots. CI diffs this file on every run;
    // any route added, renamed, or removed shows up as a reviewable PR diff.
    const snapshot = {
      routes: routes.map((r) => serializeRoute(r)),
      openApi: openApi.map((r) => serializeRoute({ method: r.method, path: toColonPath(r.path) })),
    };
    await expect(JSON.stringify(snapshot, null, 2) + "\n").toMatchFileSnapshot(
      "./routes.snapshot.json"
    );
  });
});
