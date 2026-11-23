import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

import type { StubOutcome } from "./output-types.js";

export const T0 = "2026-01-01T00:00:00.000Z";
export const T1 = "2026-01-01T00:01:00.000Z";

export const FIXTURE_IDS = {
  workspace: "00000000-0000-4000-8000-000000000001",
  fact: "00000000-0000-4000-8000-000000000002",
  entity: "00000000-0000-4000-8000-000000000003",
  session: "00000000-0000-4000-8000-000000000004",
  relation: "00000000-0000-4000-8000-000000000005",
} as const;

export const FIXTURE_FACT = {
  id: FIXTURE_IDS.fact,
  statement: "The user prefers deterministic contract fixtures.",
  kind: "preference",
  sensitivity: "internal",
  createdAt: T0,
  updatedAt: T1,
} as const;

export const FIXTURE_ENTITY = {
  id: FIXTURE_IDS.entity,
  name: "Contract Fixture",
  kind: "concept",
  createdAt: T0,
  updatedAt: T1,
} as const;

export function fixturePage<T>(items: readonly T[]) {
  return { items: [...items], nextCursor: null } as const;
}

export function resolves(value: unknown): StubOutcome {
  return { type: "resolve", value };
}

export function rejects(error: unknown): StubOutcome {
  return { type: "reject", error };
}

export function ok(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function localError(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

export function createRequestHandlerExtra(): RequestHandlerExtra<
  ServerRequest,
  ServerNotification
> {
  const sendRequest: RequestHandlerExtra<
    ServerRequest,
    ServerNotification
  >["sendRequest"] = async () => {
    throw new Error("Unexpected MCP server request in output contract scenario");
  };

  return {
    signal: new AbortController().signal,
    sessionId: "contract-session",
    requestId: "contract-request",
    sendNotification: async () => undefined,
    sendRequest,
  };
}
