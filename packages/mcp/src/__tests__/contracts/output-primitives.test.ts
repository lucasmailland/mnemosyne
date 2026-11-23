import { expect } from "vitest";

import { runOutputScenarios } from "./output-harness.js";
import { PRIMITIVE_OUTPUT_SCENARIOS } from "./output-primitives.js";
import { outputScenarioKey } from "./output-types.js";

const baselineKeys = PRIMITIVE_OUTPUT_SCENARIOS.filter(({ kind }) => kind === "baseline").map(
  outputScenarioKey
);
const additionalScenarios = PRIMITIVE_OUTPUT_SCENARIOS.filter(({ kind }) => kind === "additional");

expect(baselineKeys).toHaveLength(28);
expect(new Set(baselineKeys).size).toBe(28);
expect(baselineKeys.filter((key) => key.startsWith("task."))).toHaveLength(7);
expect(baselineKeys.filter((key) => key.startsWith("event."))).toHaveLength(5);
expect(baselineKeys.filter((key) => key.startsWith("reasoning."))).toHaveLength(8);
expect(baselineKeys.filter((key) => key.startsWith("strategy."))).toHaveLength(8);
expect(additionalScenarios).toHaveLength(32);

runOutputScenarios("MCP primitive output contracts", PRIMITIVE_OUTPUT_SCENARIOS);
