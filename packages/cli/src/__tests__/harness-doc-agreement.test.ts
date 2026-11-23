/**
 * The guide's invocations are fed to the real parser.
 *
 * Documentation that drifts from the flag it documents is worse than none: the
 * reader runs the documented command, gets "Unknown option", and concludes the
 * feature does not exist. Since `parseInstallArgs` is pure, the agreement can be
 * checked rather than reviewed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseInstallArgs } from "../install-args.js";

const GUIDE = join(import.meta.dirname, "..", "..", "..", "..", "docs", "guides", "HARNESS.md");

/** Every `mnemo install …` line in an indented code block. */
function documentedInvocations(): string[][] {
  const text = readFileSync(GUIDE, "utf8");
  const lines = text.split("\n");
  const found: string[][] = [];
  for (const line of lines) {
    const match = /^\s{4,}mnemo install\s+(.+?)\s*$/.exec(line);
    if (match) found.push(match[1]!.split(/\s+/));
  }
  return found;
}

describe("the harness guide documents the flag that actually shipped", () => {
  it("shows at least one --capture invocation", () => {
    const invocations = documentedInvocations();
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.some((argv) => argv.includes("--capture"))).toBe(true);
  });

  it.each(documentedInvocations())("`mnemo install %s` parses", (...argv) => {
    const result = parseInstallArgs(argv);
    if (!result.ok) throw new Error(`the guide documents an argv the CLI rejects: ${result.error}`);
    expect(result.args.capture.length).toBeGreaterThan(0);
  });

  it("documents every host the parser accepts, and no others", () => {
    const documented = new Set(
      documentedInvocations().flatMap((argv) => {
        const result = parseInstallArgs(argv);
        return result.ok ? result.args.capture : [];
      })
    );
    expect([...documented].sort()).toEqual(["claude-code", "codex", "opencode"]);
  });

  it("names the consent marker at the path the code writes", () => {
    // The one path a reader would go looking for when capture is not running.
    expect(readFileSync(GUIDE, "utf8")).toContain("~/.mnemo/harness/capture/<host>.json");
  });
});
