/**
 * B3.2 — enumeration-driven coverage-obligation guard (design.md "B3. Full-
 * surface test coverage architecture", Req 13).
 *
 * Deliberately NOT integration-tier: this test reads three already-committed,
 * machine-generated snapshots (B1.1/B1.2/B1.3's `routes.snapshot.json`,
 * `tool-routes.snapshot.json`, `command-routes.snapshot.json`) plus this
 * package's own `registry.ts` — no Docker, no live server, runs under the
 * ordinary Node-20 `pnpm test`.
 *
 * The obligation itself ("every route/tool/command needs a coverage
 * decision") is generated from those real inventories, never hand-typed —
 * same philosophy as `api-path-truth`'s allowlist and B2's
 * `contract-reality` set differences. What CAN be hand-authored is the
 * DECISION for a given key (`registry.ts`'s `COVERAGE_OVERRIDES`); anything
 * without a decision is `"pending"`, and the exact set of currently-pending
 * keys is pinned via `toMatchFileSnapshot` — the same "allowlist you must
 * shrink deliberately" mechanic used throughout this change. A new
 * route/tool/command added later, with no corresponding registry decision,
 * changes the pending set and fails this test until a human either covers
 * it, marks it a permanent skip, or (rarely, and visibly in the PR diff)
 * re-pins the larger pending set.
 *
 * B3 intentionally does NOT fill in real coverage (that is B4's job, not
 * authorized this task) — every key below defaults to "pending" except the
 * 4 CLI commands B1.3 already permanently excluded. It is correct and
 * expected for `coverage-pending.snapshot.json` to currently list nearly
 * every route/tool/command.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliKey, COVERAGE_OVERRIDES, mcpKey, resolveCoverage, routeKey } from "./registry.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

interface RoutesSnapshot {
  routes: string[];
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), "utf8")) as T;
}

/** Strips B1.3's `"name (skipped)"` display suffix back to the bare `COMMANDS` key. */
function bareCommandName(snapshotKey: string): string {
  return snapshotKey.replace(/ \(skipped\)$/, "");
}

describe("coverage-enumeration guard (B3.2, Req 13)", () => {
  const routesSnapshot = readJson<RoutesSnapshot>(
    "packages/server/src/__tests__/routes.snapshot.json"
  );
  const toolSnapshot = readJson<Record<string, unknown>>(
    "packages/mcp/src/__tests__/tool-routes.snapshot.json"
  );
  const cliSnapshot = readJson<Record<string, unknown>>(
    "packages/cli/src/__tests__/command-routes.snapshot.json"
  );

  const routeKeys = routesSnapshot.routes.map((r) => routeKey(r));
  const mcpToolKeys = Object.keys(toolSnapshot).map((t) => mcpKey(t));
  const cliCommandKeys = Object.keys(cliSnapshot).map((c) => cliKey(bareCommandName(c)));

  const allKeys = [...routeKeys, ...mcpToolKeys, ...cliCommandKeys];

  it("every enumerated route, MCP tool[:action], and CLI command resolves to a coverage decision", () => {
    // resolveCoverage() never returns undefined (its default is "pending"),
    // so this is really asserting the enumeration itself is well-formed —
    // the actual "did anything slip through unacknowledged" guard is the
    // pinned pending-set snapshot below.
    const unresolved = allKeys.filter((k) => resolveCoverage(k) === undefined);
    expect(unresolved).toEqual([]);
  });

  it("COVERAGE_OVERRIDES has no stale entries for keys that no longer exist", () => {
    const known = new Set(allKeys);
    const stale = Object.keys(COVERAGE_OVERRIDES).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  it("pins the exact set of still-pending coverage obligations (Req 13) — shrinks only when B4 covers or permanently skips a key", async () => {
    const pending = allKeys.filter((k) => resolveCoverage(k) === "pending").sort();
    await expect(JSON.stringify(pending, null, 2) + "\n").toMatchFileSnapshot(
      "./coverage-pending.snapshot.json"
    );
  });

  it("reports the current coverage-obligation backlog (informational)", () => {
    const covered = allKeys.filter((k) => resolveCoverage(k) === "covered").length;
    const skipped = allKeys.filter((k) => resolveCoverage(k) === "skip").length;
    const pending = allKeys.filter((k) => resolveCoverage(k) === "pending").length;

    // eslint-disable-next-line no-console -- deliberate visibility into B4's remaining backlog
    console.info(
      `[coverage-guard] routes=${routeKeys.length} tools=${mcpToolKeys.length} cli=${cliCommandKeys.length} ` +
        `| covered=${covered} skip=${skipped} pending=${pending} (of ${allKeys.length} total obligations)`
    );

    expect(covered + skipped + pending).toBe(allKeys.length);
  });
});
