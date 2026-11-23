import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_TOOL_NAMES, MCP_TOOL_COUNT } from "../registry.js";
import { captureRegistry } from "./support/capture-registry.js";

/**
 * P64 tasks 12.1–12.5 — the hook's `select:` list must equal the live registry.
 *
 * `user-prompt-submit.sh` names every tool it wants pre-loaded in a single
 * `select:` line. That list is a hand-maintained copy of the registry, and a
 * copy drifts: a tool added to `registry.ts` and not to the hook is simply
 * never offered to the model, with nothing failing anywhere. No error, no log,
 * no test — the tool just quietly does not exist for the agent.
 *
 * Asserted in BOTH directions on purpose. One direction catches the new tool
 * nobody added; the other catches the deleted tool nobody removed, which
 * silently asks the host to preload something that no longer exists.
 *
 * This guard found its first drift the moment it was written: `memory_fact`
 * (added by P67 the day before) was in the registry and not in the hook.
 */

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOOK = join(PACKAGES, "plugin", "scripts", "user-prompt-submit.sh");
/**
 * `sync-plugin.cjs` copies the plugin into the CLI package at build time. That
 * copy is not versioned (a clean clone does not have it), so the test runs the
 * same script into a temp dir rather than reading packages/cli/plugin.
 */
const SYNC = join(PACKAGES, "cli", "scripts", "sync-plugin.cjs");
const PREFIX = "mcp__mnemosyne__";

/**
 * Audit 3.3 (2026-11-22): the hook preloads exactly the core profile, the
 * tools every profile serves (full is the default; MNEMO_MCP_TOOLS=core trims
 * to these). Preloading the rest would ask for schemas that do not exist under
 * core and cost context under full.
 */
export const OFFERED = CORE_TOOL_NAMES;

function selectLines(source: string): string[] {
  return source.split("\n").filter((l) => l.includes("select:"));
}

function hookToolNames(source: string): string[] {
  const line = selectLines(source)[0]!;
  const list = line.slice(line.indexOf("select:") + "select:".length).replace(/["'\s]+$/, "");
  return list
    .split(",")
    .map((n) => n.trim().replace(/^"+|"+$/g, ""))
    .filter(Boolean)
    .map((n) => (n.startsWith(PREFIX) ? n.slice(PREFIX.length) : n));
}

describe("P64 — the hook's select: list is the core profile of the live registry", () => {
  const source = readFileSync(HOOK, "utf8");

  it("has exactly one select: line — a second, divergent copy is itself the bug", () => {
    // Two lists means one of them is stale and nothing says which.
    expect(selectLines(source)).toHaveLength(1);
  });

  it("every tool in the hook exists in the registry (offered subset)", () => {
    const registry = new Set(captureRegistry().keys());
    const hook = new Set(hookToolNames(source));

    const inHookNotRegistered = [...hook].filter((n) => !registry.has(n)).sort();
    expect(inHookNotRegistered).toEqual([]);
  });

  it("offers exactly the core profile", () => {
    expect([...hookToolNames(source)].sort()).toEqual([...OFFERED].sort());
  });

  it("lists unique prefixed entries with no duplicates or malformed prefixes", () => {
    const names = hookToolNames(source);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(OFFERED.length);

    const line = selectLines(source)[0]!;
    const raw = line.slice(line.indexOf("select:") + 7).replace(/["'\s]+$/, "");
    const entries = raw.split(",").map((n) => n.trim().replace(/^"+|"+$/g, ""));
    const malformed = entries.filter((n) => !n.startsWith(PREFIX) || n === PREFIX);
    expect(malformed).toEqual([]);
  });

  it("complete registry still retains all MCP_TOOL_COUNT tools", () => {
    const registry = captureRegistry();
    expect(registry.size).toBe(MCP_TOOL_COUNT);
  });

  it("the CLI mirror is byte-identical to its source", () => {
    // `sync-plugin.cjs` copies plugin/ into the CLI package. If the copy drifts,
    // an installed CLI ships a different hook than the repo tests — and every
    // assertion above would be checking a file nobody runs.
    const out = mkdtempSync(join(tmpdir(), "mnemo-cli-plugin-"));
    try {
      execFileSync(process.execPath, [SYNC, out], { stdio: "ignore" });
      expect(readFileSync(join(out, "scripts", "user-prompt-submit.sh"), "utf8")).toBe(source);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("the extractor actually parses the list (teeth)", () => {
    // Guards against a regex that silently returns [] and makes the set
    // comparisons vacuously pass.
    expect(hookToolNames(`select:${PREFIX}memory_recall,${PREFIX}memory_fact"`)).toEqual([
      "memory_recall",
      "memory_fact",
    ]);
  });
});
