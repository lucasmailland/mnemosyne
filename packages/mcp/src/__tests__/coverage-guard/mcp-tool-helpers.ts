/**
 * B4.2 — shared helper for exercising `memory_*` MCP tools via the real
 * stdio client (design.md "B4. Coverage fill-in", spec.md Requirement 13).
 *
 * `surface.mcp` is the real `@modelcontextprotocol/sdk` `Client`, connected
 * to the actual built `dist/index.js` MCP server as a child process (see
 * `../harness/live-surface.ts`). `callTool` is a thin, typed wrapper around
 * `surface.mcp.callTool(...)` so every B4.2 test file doesn't have to
 * re-declare the same result shape / timeout options.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCP_TIMEOUT_MS } from "../contracts/stdio-tools.js";

export interface McpToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

/** Calls a registered `memory_*` tool through the real MCP stdio client. */
export async function callTool(
  mcp: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<McpToolResult> {
  return (await mcp.callTool({ name, arguments: args }, undefined, {
    timeout: MCP_TIMEOUT_MS,
    maxTotalTimeout: MCP_TIMEOUT_MS,
  })) as McpToolResult;
}

/** Calls a tool and throws with the full error payload if it reports `isError`. */
export async function callToolOk(
  mcp: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<McpToolResult> {
  const result = await callTool(mcp, name, args);
  if (result.isError) {
    throw new Error(`${name} unexpectedly failed: ${JSON.stringify(result.content)}`);
  }
  return result;
}
