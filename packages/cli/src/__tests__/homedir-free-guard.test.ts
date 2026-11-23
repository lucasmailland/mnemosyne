/**
 * `homedir()` is resolved once, at the `cmdInstall` edge, and passed down.
 *
 * Why this is a structural guard and not a matter of taste: a module that reads
 * the real home cannot be tested against a scratch directory, so its tests
 * either run against the developer's actual config or they mock the filesystem —
 * and a mocked filesystem is exactly where a path bug hides. Both of the
 * packaging bugs this change fixed were of that shape: a wrong path that
 * produced a SAFE wrong answer, invisible to every test that never touched a
 * real directory.
 *
 * If this fails, thread the home through as a parameter. Do not weaken it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MODULES = [
  "codex-config.ts",
  "atomic-file.ts",
  "install-args.ts",
  "capture-install.ts",
  "capture-effects.ts",
  "harness-install.ts",
] as const;

/**
 * Comments removed before matching: these modules EXPLAIN at length why they do
 * not read the home, and a guard that fires on its own rationale teaches people
 * to delete the rationale.
 */
function code(file: string): string {
  return readFileSync(join(import.meta.dirname, "..", file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the config-editing modules take a home, they never ask for one", () => {
  it.each(MODULES)("%s does not call homedir()", (file) => {
    expect(code(file)).not.toMatch(/\bhomedir\s*\(/);
  });

  it.each(MODULES)("%s does not read $HOME from the environment either", (file) => {
    // Same hazard by another route: an implicit home is an untestable one.
    expect(code(file)).not.toMatch(/process\.env\[?["']?HOME/);
  });

  it("still catches a real call, so the comment-stripping cannot hide one", () => {
    // Guarding the guard: strip comments, keep code.
    const stripped = "/* homedir() in prose */\nconst h = homedir();\n"
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).toMatch(/\bhomedir\s*\(/);
  });
});
