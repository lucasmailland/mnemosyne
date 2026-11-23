import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { describe, expect, it, vi } from "vitest";

import { registerAllTools } from "../../registry.js";
import { createRequestHandlerExtra } from "./output-fixtures.js";
import {
  OPEN_B6_OWNERS,
  outputScenarioKey,
  type CapturedToolHandler,
  type ExpectedClientCall,
  type ExpectedToolName,
  type OutputScenario,
  type StubOutcome,
} from "./output-types.js";

export interface RecordedClientCall extends ExpectedClientCall {
  invocationOrder: number;
}

export interface RecordingClient {
  client: MnemosyneClient;
  calls: readonly RecordedClientCall[];
  unusedStubPaths: () => string[];
}

type CapturedRegistration = readonly [name: string, config: object, callback: CapturedToolHandler];

export function captureHandler(
  tool: ExpectedToolName,
  client: MnemosyneClient
): CapturedToolHandler {
  const server = new McpServer({ name: "mcp-output-contracts", version: "1.0.0" });
  const registerToolSpy = vi.spyOn(server, "registerTool");

  try {
    registerAllTools(server, client);
    const registrations = registerToolSpy.mock.calls as unknown as readonly CapturedRegistration[];
    const registration = registrations.find(([name]) => name === tool);
    const callback = registration?.[2];
    if (typeof callback !== "function") {
      throw new Error(`No registered handler captured for ${tool}`);
    }
    return callback;
  } finally {
    registerToolSpy.mockRestore();
  }
}

export function createRecordingClient(
  stubs: Readonly<Record<string, readonly StubOutcome[]>>
): RecordingClient {
  const calls: RecordedClientCall[] = [];
  const queues = new Map(Object.entries(stubs).map(([path, outcomes]) => [path, [...outcomes]]));

  const createPathProxy = (path: string): unknown => {
    const callable = async (...args: unknown[]): Promise<unknown> => {
      calls.push({ path, args, invocationOrder: calls.length + 1 });
      const outcome = queues.get(path)?.shift();
      if (outcome === undefined) {
        throw new Error(`No stub configured for ${path}`);
      }
      if (outcome.type === "reject") throw outcome.error;
      return outcome.value;
    };

    return new Proxy(callable, {
      get(_target, property) {
        if (property === "then") return undefined;
        if (typeof property !== "string") return undefined;
        // `withObservation`/`withTimeout` are synchronous clone factories (no HTTP call): hand
        // back the same recording client so the tool's calls are recorded at
        // their usual paths. Observation metadata is asserted in
        // recall-observation.test.ts.
        if (path === "" && (property === "withObservation" || property === "withTimeout"))
          return () => root;
        const childPath = path === "" ? property : `${path}.${property}`;
        return createPathProxy(childPath);
      },
    });
  };

  const root = createPathProxy("");
  return {
    client: root as MnemosyneClient,
    calls,
    unusedStubPaths: () =>
      [...queues.entries()]
        .filter(([, outcomes]) => outcomes.length > 0)
        .map(([path]) => path)
        .sort(),
  };
}

function jsonText(result: CallToolResult): unknown | typeof NO_JSON {
  const firstContent = result.content[0];
  if (firstContent?.type !== "text") return NO_JSON;
  try {
    return JSON.parse(firstContent.text) as unknown;
  } catch {
    return NO_JSON;
  }
}

const NO_JSON = Symbol("no-json");

export function runOutputScenarios(familyName: string, scenarios: readonly OutputScenario[]): void {
  describe(familyName, () => {
    for (const scenario of scenarios) {
      const key = outputScenarioKey(scenario);
      const testName = scenario.caseName ? `${key}: ${scenario.caseName}` : key;

      it(testName, async () => {
        const recorder = createRecordingClient(scenario.stubs);

        try {
          scenario.setup?.();
          const handler = captureHandler(scenario.tool, recorder.client);
          const result = await handler(scenario.args, createRequestHandlerExtra());

          expect(result).toEqual(scenario.expected);
          expect(recorder.calls.map(({ path, args }) => ({ path, args }))).toEqual(
            scenario.expectedClientCalls
          );
          expect(recorder.calls.map(({ invocationOrder }) => invocationOrder)).toEqual(
            recorder.calls.map((_, index) => index + 1)
          );
          expect(recorder.unusedStubPaths()).toEqual([]);

          if (scenario.classification === "known_defect") {
            for (const owner of scenario.owners) {
              expect(OPEN_B6_OWNERS).toContain(owner);
            }
          }

          if (result.structuredContent !== undefined && result.isError !== true) {
            const parsedText = jsonText(result);
            if (parsedText !== NO_JSON) {
              expect(parsedText).toEqual(result.structuredContent);
            }
          }
        } finally {
          await scenario.cleanup?.();
        }
      });
    }
  });
}
