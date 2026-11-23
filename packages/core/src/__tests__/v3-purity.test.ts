/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hexagonal-purity guard (cardinal rule, widened — design.md D5,
 * tasks.md Phase 8/Phase 9, apply-progress.md PR20/Phase 9).
 *
 * flatten-legacy-dual-core Slice 5: this guard used to scan ONLY
 * `packages/core/src/cognitive/` (the v2 legacy code outside it had
 * "documented drizzle/pg debt"). Now that Phase 7 deleted `factory.ts`/
 * `CoreLike` and Phase 8 deleted every confirmed-dead legacy module that
 * still imported infrastructure directly, the guard scans ALL of
 * `packages/core/src` (excluding `__tests__` and `*.test.ts`), parameterized
 * with `it.each`, against a reason-annotated allowlist.
 *
 * Two assertions, both directions:
 *   (a) a non-allowlisted file importing drizzle-orm/postgres/pg/ioredis/
 *       redis/@neondatabase FAILS.
 *   (b) an allowlist entry that no longer exists, or no longer imports
 *       infrastructure, ALSO FAILS — so the list can only shrink, never rot.
 *
 * History (investigated, not assumed at each step — full trail in
 * apply-progress.md):
 *
 *   - PR20 (Phase 8) widened the scan from `cognitive/` to all of
 *     `packages/core/src`, found the tree carried a much larger "v1.x
 *     utility library" surface than PR19's ~10-module finding captured,
 *     deleted 22 confirmed-dead infra-importing files, and landed at a
 *     25-entry allowlist — NOT design.md D5's originally-stated 2-file
 *     target (`tx.ts` + `api-key-lookup.ts`), with `db/schema/*` (18
 *     files) kept as a disclosed, structurally-required exception (the
 *     `Schema` generic parameter every `DbClient` construction needed).
 *   - Phase 9 (this revision, closing Requirement 8's literal gap) deleted
 *     `health/{index,compute}.ts` (ported to the v3 `StorageAdapter` port),
 *     `primitives/fact.ts` + `index/pointer.ts` (split types out, deleted
 *     the dead CRUD), and then re-investigated `db/schema/*` from scratch:
 *     with the ~10 legacy v1.x table consumers gone (PR19/20) and `health/*`
 *     now gone too, NOTHING anywhere in the repo — this package, server
 *     boot, adapters, MCP, CLI, client-ts, or any test — imports an
 *     individual table object by name or uses Drizzle's `.query.*`
 *     relational API against this package's `DbClient`. Every real consumer
 *     (`tx.ts`, `api-key-lookup.ts`, `packages/server/src/index.ts`'s own
 *     raw-SQL queries) exclusively uses `.execute(sql\`...\`)`/
 *     `.transaction()`, neither of which depends on `TSchema`. `Schema` was
 *     redefined as the empty `Record<string, never>` and all 18
 *     `db/schema/*.ts` files were physically deleted — Requirement 8 is now
 *     genuinely, fully satisfied: the allowlist is the 2-file D5 target
 *     (`tx.ts`, `api-key-lookup.ts`) plus `cli/migrate.ts` (a genuine 3rd
 *     canonical exception, the standalone `mnemo-migrate` CLI) plus
 *     `db/types.ts` (imports `NodePgDatabase`/`PostgresJsDatabase` from
 *     `drizzle-orm/*` purely for the structural `DbClient`/`Tx` type — no
 *     runtime table dependency) — 4 entries, not 25.
 */

const FORBIDDEN = [
  "drizzle-orm",
  '"postgres"',
  "'postgres'",
  '"pg"',
  "'pg'",
  "ioredis",
  '"redis"',
  "'redis'",
  "@neondatabase",
];

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

interface AllowlistEntry {
  path: string;
  reason: string;
}

// Paths are relative to packages/core/src, POSIX-separated, matching the
// `File Changes` / `Interfaces` shape design.md D5 specifies.
const LEGACY_INFRA_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    path: "tx.ts",
    reason: "withMnemoTx — canonical RLS transaction boundary (CLAUDE.md 'RLS mechanics').",
  },
  {
    path: "api-key-lookup.ts",
    reason:
      "Auth bootstrap — chicken-and-egg with withMnemoTx (needs a workspaceId before one exists). CLAUDE.md 'Auth bootstrap exception'.",
  },
  {
    path: "cli/migrate.ts",
    reason:
      "Standalone `mnemo-migrate` CLI (package.json#bin) — applies migrations against a bare Postgres connection before RLS/withMnemoTx machinery exists. Invoked directly by docker/Dockerfile.migrate's CMD and by external npm consumers via `npx mnemo-migrate`.",
  },
  {
    path: "db/types.ts",
    reason:
      "DbClient/Tx structural types (NodePgDatabase<Schema>/PostgresJsDatabase<Schema>) — the generic parameter every DB client construction (server boot, tests) needs to type-check against. Schema itself is now Record<string, never> (empty) — flatten-legacy-dual-core Phase 9 (task 9.4) deleted packages/core/src/db/schema/* (18 files) entirely after confirming zero consumer, internal or external, ever used a named table export or Drizzle's `.query.*` relational API against this package's DbClient. See db/types.ts's own header comment for the full investigation.",
  },
];

const ALLOWLIST_PATHS = new Set(LEGACY_INFRA_ALLOWLIST.map((e) => e.path));

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function importsInfra(content: string): string[] {
  const hits: string[] = [];
  for (const specifier of FORBIDDEN) {
    // Only flag actual import/require lines, not comments mentioning the
    // name — but require the specifier token itself to appear as part of a
    // quoted module string on that same line (not just anywhere in prose),
    // so a comment like "This file imports ONLY @mnemo-ai/types (no
    // drizzle)" does not false-positive just because it contains the word
    // "import" earlier on the line.
    // The module string must BE the package or one of its subpaths: a relative
    // file like "./redis-acl.js" is not an import of redis.
    const mod = `${specifier.replace(/["']/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/[^"']*)?`;
    const importLine = new RegExp(
      `^\\s*(import|export)\\b[^\\n]*\\bfrom\\s*["']${mod}["']|` +
        `\\bimport\\(\\s*["']${mod}["']\\s*\\)|` +
        `=\\s*require\\(\\s*["']${mod}["']\\s*\\)`,
      "m"
    );
    if (importLine.test(content)) {
      hits.push(specifier);
    }
  }
  return hits;
}

const allFiles = collectTsFiles(SRC_DIR).map((f) => ({
  abs: f,
  rel: relative(SRC_DIR, f).split("\\").join("/"),
}));

describe("hexagonal purity: packages/core/src (widened scan, design.md D5)", () => {
  it.each(allFiles)("$rel has no unauthorized infrastructure imports", ({ abs, rel }) => {
    const content = readFileSync(abs, "utf8");
    const hits = importsInfra(content);
    if (ALLOWLIST_PATHS.has(rel)) {
      // Allowlisted files are checked by the direction-(b) test below, not
      // here — this test only asserts non-allowlisted files stay clean.
      return;
    }
    expect(hits, `${rel} imports forbidden infra: ${hits.join(", ")}`).toEqual([]);
  });

  it.each(LEGACY_INFRA_ALLOWLIST)(
    "allowlist entry $path still exists and still imports infrastructure (direction b)",
    ({ path, reason }) => {
      expect(reason.length, `${path} allowlist entry must have a non-empty reason`).toBeGreaterThan(
        0
      );
      const abs = join(SRC_DIR, path);
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        throw new Error(
          `Allowlist entry "${path}" no longer exists on disk — remove it from LEGACY_INFRA_ALLOWLIST (the list can only shrink).`
        );
      }
      const hits = importsInfra(content);
      expect(
        hits.length,
        `Allowlist entry "${path}" no longer imports any forbidden infra (${FORBIDDEN.join(", ")}) — remove it from LEGACY_INFRA_ALLOWLIST (the list can only shrink, never rot).`
      ).toBeGreaterThan(0);
    }
  );

  it("allowlist has no duplicate or stale-relative-to-scan entries", () => {
    const seen = new Set<string>();
    for (const entry of LEGACY_INFRA_ALLOWLIST) {
      expect(seen.has(entry.path), `duplicate allowlist entry: ${entry.path}`).toBe(false);
      seen.add(entry.path);
    }
    const scannedPaths = new Set(allFiles.map((f) => f.rel));
    for (const entry of LEGACY_INFRA_ALLOWLIST) {
      expect(
        scannedPaths.has(entry.path),
        `allowlist entry "${entry.path}" does not match any file the scan collected (typo, or it's in __tests__/*.test.ts which is excluded by design)`
      ).toBe(true);
    }
  });
});
