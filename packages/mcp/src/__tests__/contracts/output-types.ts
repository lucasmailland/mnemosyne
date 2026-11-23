import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

import type { EXPECTED_TOOL_NAMES } from "../tool-names.js";

export type ExpectedToolName = (typeof EXPECTED_TOOL_NAMES)[number];

export type CapturedToolHandler = (
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => CallToolResult | Promise<CallToolResult>;

export const OPEN_B6_OWNERS = [
  "B6.3",
  "B6.4",
  "B6.5",
  "B6.7",
  "B6.8",
  "B6.9",
  "B6.10",
  "B6.11",
  "B6.12",
  "B6.13",
  "B6.14",
  "B6.15",
  "B6.16",
  "B6.17",
  "B6.18",
  "B6.19",
  "B6.20",
  "B6.21",
  "B6.22",
  "B6.23",
  "B6.24",
  "B6.25",
  "B6.26",
  "B6.27",
  "B6.31",
  "B6.32",
  "B6.33",
  "B6.34",
  "B6.35",
] as const;

export type OpenB6Owner = (typeof OPEN_B6_OWNERS)[number];

export type ScenarioClassification =
  | { classification: "contract" }
  | {
      classification: "known_defect";
      owners: readonly [OpenB6Owner, ...OpenB6Owner[]];
    };

export type StubOutcome =
  | { type: "resolve"; value: unknown }
  | { type: "reject"; error: unknown };

export interface ExpectedClientCall {
  path: string;
  args: readonly unknown[];
}

export type OutputScenario = ScenarioClassification & {
  kind: "baseline" | "additional";
  tool: ExpectedToolName;
  variant: string;
  caseName?: string;
  args: Record<string, unknown>;
  stubs: Readonly<Record<string, readonly StubOutcome[]>>;
  expectedClientCalls: readonly ExpectedClientCall[];
  expected: CallToolResult;
  setup?: () => void;
  cleanup?: () => void | Promise<void>;
};

export function outputScenarioKey(
  scenario: Pick<OutputScenario, "tool" | "variant">,
): string {
  return `${scenario.tool.slice("memory_".length)}.${scenario.variant}`;
}
