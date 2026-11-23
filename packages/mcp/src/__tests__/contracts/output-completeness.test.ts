import { describe, expect, it } from "vitest";

import { ADMIN_OUTPUT_SCENARIOS } from "./output-admin.js";
import { COGNITIVE_OUTPUT_SCENARIOS } from "./output-cognitive.js";
import { FOUNDATION_OUTPUT_SCENARIOS } from "./output-foundations.js";
import { PRIMITIVE_OUTPUT_SCENARIOS } from "./output-primitives.js";
import { outputScenarioKey } from "./output-types.js";
import { EXPECTED_OUTPUT_VARIANTS } from "./output-variants.js";
import { EXPECTED_TOOL_NAMES } from "../tool-names.js";

describe("MCP output scenario completeness", () => {
  it("contains every expected baseline variant exactly once", () => {
    const scenarios = [
      ...FOUNDATION_OUTPUT_SCENARIOS,
      ...PRIMITIVE_OUTPUT_SCENARIOS,
      ...COGNITIVE_OUTPUT_SCENARIOS,
      ...ADMIN_OUTPUT_SCENARIOS,
    ];
    const actualBaselineKeys = scenarios
      .filter(({ kind }) => kind === "baseline")
      .map(outputScenarioKey);
    const actualKeySet = new Set(actualBaselineKeys);
    const expectedKeySet = new Set<string>(EXPECTED_OUTPUT_VARIANTS);
    const missingKeys = EXPECTED_OUTPUT_VARIANTS.filter((key) => !actualKeySet.has(key));
    const unexpectedKeys = actualBaselineKeys.filter((key) => !expectedKeySet.has(key));

    expect(EXPECTED_OUTPUT_VARIANTS).toHaveLength(107); // P72 added memory_relocate
    expect(expectedKeySet.size).toBe(107); // P72
    expect(actualBaselineKeys).toHaveLength(107); // P72 added memory_relocate
    expect(new Set(actualBaselineKeys).size).toBe(107); // P72
    expect([...actualBaselineKeys].sort()).toEqual([...EXPECTED_OUTPUT_VARIANTS].sort());
    expect(missingKeys, "missing baseline output variants").toEqual([]);
    expect(unexpectedKeys, "unexpected baseline output variants").toEqual([]);
  });

  it("gives every registered tool at least one baseline output", () => {
    const scenarios = [
      ...FOUNDATION_OUTPUT_SCENARIOS,
      ...PRIMITIVE_OUTPUT_SCENARIOS,
      ...COGNITIVE_OUTPUT_SCENARIOS,
      ...ADMIN_OUTPUT_SCENARIOS,
    ];
    const toolsWithBaseline = new Set(
      scenarios.filter(({ kind }) => kind === "baseline").map(({ tool }) => tool)
    );

    expect(EXPECTED_TOOL_NAMES).toHaveLength(37); // P72 added memory_relocate
    for (const tool of EXPECTED_TOOL_NAMES) {
      expect(toolsWithBaseline, `${tool} has no baseline output scenario`).toContain(tool);
    }
  });
});
