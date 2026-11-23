/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { census, listRepoFiles } from "./api-path-truth.census.js";
import { ALLOWLIST } from "./api-path-truth.allowlist.js";

/**
 * api-path-truth guard (A5, Req 11).
 *
 * The real API has no URL-path version segment: it is mounted at root
 * (packages/server/src/app.ts, `app.route("/", v1)`) and versioned solely via
 * the `Mnemosyne-Version` date header (packages/server/src/versioning.ts).
 * This guard scans the whole repository for the literal `/v1/` and fails on
 * any occurrence outside the reviewed allowlist — following the same
 * convention as v3-purity.test.ts and migrations.test.ts (CLAUDE.md: these
 * are vitest guards, not lint scripts).
 *
 * Turborepo cache staleness is a non-issue: turbo.json sets "cache": false on
 * the test task, so this guard re-runs every invocation.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("api-path-truth guard: no /v1/ outside the reviewed allowlist", () => {
  it("finds zero unallowlisted /v1/ occurrences in the real repository", async () => {
    const files = await listRepoFiles(REPO_ROOT);
    const violations = census(files, ALLOWLIST);
    expect(violations).toEqual([]);
  }, 180_000); // reads every file in the repo: 3 s alone, 34-60 s+ under a full parallel sweep
});
