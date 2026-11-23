import { expect } from "vitest";

import { FOUNDATION_OUTPUT_SCENARIOS } from "./output-foundations.js";
import { runOutputScenarios } from "./output-harness.js";
import { outputScenarioKey } from "./output-types.js";

const baselineKeys = FOUNDATION_OUTPUT_SCENARIOS.filter(({ kind }) => kind === "baseline").map(
  outputScenarioKey
);
const additionalScenarios = FOUNDATION_OUTPUT_SCENARIOS.filter(({ kind }) => kind === "additional");

expect(baselineKeys).toHaveLength(37); // P72 added memory_relocate
expect(new Set(baselineKeys).size).toBe(37); // P72 added memory_relocate
expect(additionalScenarios).toHaveLength(13);

runOutputScenarios("MCP foundation output contracts", FOUNDATION_OUTPUT_SCENARIOS);
