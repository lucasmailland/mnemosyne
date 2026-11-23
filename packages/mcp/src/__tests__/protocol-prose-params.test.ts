import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_INSTRUCTIONS } from "../instructions.js";
import { captureRegistry, type CapturedTool } from "./support/capture-registry.js";

/**
 * P64 tasks 13.1–13.8 — every `memory_x(param: …)` we write in PROSE must name
 * a tool that exists and a parameter it actually accepts.
 *
 * This is the defect P64 was opened for. The injected protocol told the model
 * to call `memory_remember(text: "…")` while the tool's parameter is
 * `statement:` — so the model followed our instructions and got a validation
 * error, and nothing in the repo could notice, because prose is not typechecked
 * and the tool schema is not prose.
 *
 * The fix landed. The guard did not: P64 shipped its 30 repair tasks and left
 * 11.x–14.x unbuilt, which is why the item's own title ("…y nada lo testea")
 * stayed true after it was marked complete. This is that missing half.
 */

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The four copies of the protocol (D9). Prose in any of them reaches a model. */
const PROTOCOL_SOURCES: Array<{ label: string; read: () => string | null }> = [
  { label: "MCP_INSTRUCTIONS", read: () => MCP_INSTRUCTIONS },
  {
    label: "plugin/skills/memory/SKILL.md",
    read: () => readIfExists(join(PACKAGES, "plugin", "skills", "memory", "SKILL.md")),
  },
  {
    label: "plugin/AGENTS.md",
    read: () => readIfExists(join(PACKAGES, "plugin", "AGENTS.md")),
  },
  {
    label: "plugin/GEMINI.md",
    read: () => readIfExists(join(PACKAGES, "plugin", "GEMINI.md")),
  },
];

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export interface ProseCall {
  source: string;
  tool: string;
  params: string[];
}

/**
 * Single-line only, deliberately: `[^)\n]*` keeps a match from spanning a
 * newline, so ordinary prose that happens to contain a parenthesis cannot
 * swallow half a paragraph and invent parameters.
 */
export function extractProseCalls(source: string, text: string): ProseCall[] {
  const calls: ProseCall[] = [];
  for (const m of text.matchAll(/\b(memory_[a-z_]+)\(([^)\n]*)\)/g)) {
    const params = m[2]!
      .split(",")
      // `name:` is a named argument; a bare token is a value or prose, not a
      // parameter, so only `ident:` counts.
      .map((frag) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(frag)?.[1])
      .filter((n): n is string => Boolean(n));
    calls.push({ source, tool: m[1]!, params });
  }
  return calls;
}

/** Entries here need a justification comment. Empty is the healthy state. */
const KNOWN_NON_TOOL_CALLS = new Set<string>([]);

export function findProseParamViolations(
  calls: ProseCall[],
  registry: Map<string, CapturedTool>
): string[] {
  const out: string[] = [];
  for (const call of calls) {
    if (KNOWN_NON_TOOL_CALLS.has(call.tool)) continue;
    const tool = registry.get(call.tool);
    if (!tool) {
      out.push(`${call.source}: ${call.tool}() is not a registered tool`);
      continue;
    }
    for (const p of call.params) {
      if (!tool.params.has(p)) {
        out.push(`${call.source}: ${call.tool}(${p}:) — no such parameter`);
      }
    }
  }
  return out.sort();
}

describe("P64 — prose tool calls match the real schemas", () => {
  const registry = captureRegistry();
  const allCalls = PROTOCOL_SOURCES.flatMap(({ label, read }) => {
    const text = read();
    return text === null ? [] : extractProseCalls(label, text);
  });

  it("every tool named in protocol prose exists and every named param is real", () => {
    expect(findProseParamViolations(allCalls, registry)).toEqual([]);
  });

  it("finds calls in the two protocol copies that must have them (coverage floor)", () => {
    // A silently-broken regex would make the assertion above vacuous. This
    // fails loudly instead of passing on an empty set.
    for (const label of ["MCP_INSTRUCTIONS", "plugin/skills/memory/SKILL.md"]) {
      const found = allCalls.filter((c) => c.source === label);
      expect(found.length, `${label}: expected at least 2 prose tool calls`).toBeGreaterThanOrEqual(
        2
      );
    }
  });

  it("teeth: the exact P64 defect is caught", () => {
    // `memory_remember(text: …)` is the original bug, verbatim. If this ever
    // stops failing, the guard has lost its teeth.
    const violations = findProseParamViolations(
      extractProseCalls("fixture", 'memory_remember(text: "...")'),
      registry
    );
    expect(violations).toEqual(["fixture: memory_remember(text:) — no such parameter"]);
  });

  it("teeth: a nonexistent tool is caught", () => {
    const violations = findProseParamViolations(
      extractProseCalls("fixture", "memory_teleport(query: 1)"),
      registry
    );
    expect(violations).toEqual(["fixture: memory_teleport() is not a registered tool"]);
  });

  it("does not invent parameters from ordinary prose", () => {
    // A false positive here would push someone to "fix" correct documentation.
    expect(extractProseCalls("fixture", "call memory_recall() first").at(0)?.params).toEqual([]);
    expect(extractProseCalls("fixture", "see memory_recall(query) below").at(0)?.params).toEqual(
      []
    );
  });
});
