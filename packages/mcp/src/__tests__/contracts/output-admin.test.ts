import { expect } from "vitest";

import { ADMIN_OUTPUT_SCENARIOS } from "./output-admin.js";
import { runOutputScenarios } from "./output-harness.js";
import { outputScenarioKey } from "./output-types.js";

const baselineKeys = ADMIN_OUTPUT_SCENARIOS.filter(({ kind }) => kind === "baseline").map(
  outputScenarioKey
);
const additionalScenarios = ADMIN_OUTPUT_SCENARIOS.filter(({ kind }) => kind === "additional");

expect(baselineKeys).toHaveLength(23);
expect(new Set(baselineKeys).size).toBe(23);
expect(baselineKeys.filter((key) => key.startsWith("workflow."))).toHaveLength(3);
expect(baselineKeys.filter((key) => key.startsWith("skill."))).toHaveLength(4);
expect(baselineKeys.filter((key) => key.startsWith("doctor."))).toHaveLength(1);
expect(baselineKeys.filter((key) => key.startsWith("update."))).toHaveLength(1);
expect(baselineKeys.filter((key) => key.startsWith("judge."))).toHaveLength(2);
expect(baselineKeys.filter((key) => key.startsWith("stats."))).toHaveLength(1);
expect(baselineKeys.filter((key) => key.startsWith("compare."))).toHaveLength(1);
expect(baselineKeys.filter((key) => key.startsWith("purge."))).toHaveLength(2);
expect(baselineKeys.filter((key) => key.startsWith("context."))).toHaveLength(1);
expect(baselineKeys.filter((key) => key.startsWith("workspace."))).toHaveLength(6);
expect(baselineKeys.filter((key) => key.startsWith("suggest_topic_key."))).toHaveLength(1);
expect(additionalScenarios).toHaveLength(6);

runOutputScenarios("MCP admin output contracts", ADMIN_OUTPUT_SCENARIOS);
