import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_TOOL_COUNT } from "../registry.js";
import { captureRegistry } from "./support/capture-registry.js";

/**
 * tool-promise-remediation Phase 17 — one tool count, asserted everywhere it is
 * written down.
 *
 * The number lives in five places: the registry (the only real one), the root
 * `CLAUDE.md` table and its summary line, and the MCP package README. Four of
 * those are prose, and prose does not recompile. Every one of them has been
 * stale at some point this week — `CLAUDE.md` still said 35 with 36 registered
 * when this test was written, three days after the 36th tool shipped.
 *
 * `registry.ts` is the source of truth by construction: `MCP_TOOL_COUNT` is
 * `TOOL_REGISTRARS.length`. Everything else is checked against it, never
 * against another copy — comparing two documents to each other is how both
 * drift together and agree.
 *
 * The hook's `select:` list is deliberately NOT re-checked here: it has its own
 * guard (`hook-tool-list.test.ts`) that compares NAMES in both directions,
 * which strictly implies the count. Duplicating it would mean two tests failing
 * for one cause.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLAUDE_MD = join(REPO, "CLAUDE.md");
const MCP_README = join(REPO, "packages", "mcp", "README.md");

/** Rows of the MCP tools table: `| \`memory_x\` | … |`. */
function claudeTableRows(source: string): string[] {
  return source.split("\n").filter((l) => /^\|\s*`memory_[a-z_]+`/.test(l));
}

describe("Phase 17 — tool count parity", () => {
  const registry = captureRegistry();

  it("MCP_TOOL_COUNT equals what registerAllTools actually registers", () => {
    // If these ever disagree, every other assertion here is comparing against a
    // constant that does not describe the server.
    expect(registry.size).toBe(MCP_TOOL_COUNT);
  });

  it("CLAUDE.md's tools table has exactly one row per registered tool", () => {
    const source = readFileSync(CLAUDE_MD, "utf8");
    const rows = claudeTableRows(source);
    const named = rows
      .map((l) => /`(memory_[a-z_]+)`/.exec(l)?.[1])
      .filter((n): n is string => Boolean(n));

    // Report the diff by NAME, not just the count: "35 ≠ 36" sends someone
    // counting rows by hand; "memory_fact is missing" is actionable.
    const missing = [...registry.keys()].filter((n) => !named.includes(n)).sort();
    const extra = named.filter((n) => !registry.has(n)).sort();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect(new Set(named).size).toBe(named.length);
  });

  it("CLAUDE.md's summary line states the real count", () => {
    const source = readFileSync(CLAUDE_MD, "utf8");
    expect(source).toContain(`${MCP_TOOL_COUNT} tools in \`packages/mcp/src/tools/\``);
    expect(source).toContain(`**${MCP_TOOL_COUNT} live, 0 stubs**`);
    expect(source).toContain(`MCP stdio server (${MCP_TOOL_COUNT} tools, 0 stubs)`);
  });

  it("the MCP README states the real count", () => {
    // `scripts/check-docs-lint.sh` already greps this file at pre-push. Asserted
    // here too so it fails inside `pnpm test` — where a developer sees it before
    // the hook does, and where CI's existing gate catches it.
    const source = readFileSync(MCP_README, "utf8");
    expect(source).toContain(`all ${MCP_TOOL_COUNT} live`);
    expect(source).toContain(`(${MCP_TOOL_COUNT} registered)`);
  });

  it("the row extractor actually matches rows (teeth)", () => {
    // A regex that silently matches nothing would make the table assertion
    // report every tool as "missing" — loud. But one that matches EVERYTHING
    // would make it vacuous, so pin both directions on a fixture.
    expect(claudeTableRows("| `memory_recall` | ✅ | x |\n| not a row |")).toHaveLength(1);
    expect(claudeTableRows("nothing here")).toHaveLength(0);
  });
});
