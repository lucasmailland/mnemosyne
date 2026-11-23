/**
 * APP-066 (audit 2026-11-22): files were tracked inside a git-ignored,
 * generated directory (packages/cli/plugin/), so edits to the source showed
 * up as diffs in a copy. It had already regressed once (R-14). This guard
 * fails the moment any tracked file is also ignored.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("repository hygiene", () => {
  it("tracks no file that .gitignore ignores", () => {
    const out = execFileSync("git", ["ls-files", "-ci", "--exclude-standard"], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(out.split("\n").filter(Boolean)).toEqual([]);
  });
});
