import { expect } from "vitest";

import { COGNITIVE_OUTPUT_SCENARIOS } from "./output-cognitive.js";
import { runOutputScenarios } from "./output-harness.js";
import { outputScenarioKey } from "./output-types.js";

const baselineKeys = COGNITIVE_OUTPUT_SCENARIOS.filter(({ kind }) => kind === "baseline").map(
  outputScenarioKey
);
const additionalScenarios = COGNITIVE_OUTPUT_SCENARIOS.filter(({ kind }) => kind === "additional");

expect(baselineKeys).toHaveLength(19);
expect(new Set(baselineKeys).size).toBe(19);
expect(baselineKeys.filter((key) => key.startsWith("self_edit."))).toHaveLength(7);
expect(baselineKeys.filter((key) => key.startsWith("hyperedge."))).toHaveLength(5);
expect(baselineKeys.filter((key) => key.startsWith("introspect."))).toHaveLength(1);
expect(baselineKeys.filter((key) => key.startsWith("anticipate."))).toHaveLength(1);
expect(baselineKeys.filter((key) => key.startsWith("compose."))).toHaveLength(5);
expect(additionalScenarios).toHaveLength(18);

runOutputScenarios("MCP cognitive output contracts", COGNITIVE_OUTPUT_SCENARIOS);
