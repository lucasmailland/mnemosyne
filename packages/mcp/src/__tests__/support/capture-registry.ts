import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { registerAllTools } from "../../registry.js";

/**
 * P64 task 11.1 (D8) — capture the live tool registry: name → declared input
 * parameter names.
 *
 * Every guard that compares *something else* against the tool surface needs the
 * same thing: the real registry, not a hand-maintained list. A hand-maintained
 * list is the very drift these guards exist to catch, so building one here
 * would make the guards agree with a copy instead of with the code.
 *
 * `registerAllTools` is called against a real `McpServer` with a spy on
 * `registerTool`, which is how `registry.test.ts` already does it — same
 * mechanism, extracted so `hook-tool-list` and `protocol-prose-params` share
 * one source of truth.
 */
export interface CapturedTool {
  name: string;
  /** Declared parameter names, from the tool's `inputSchema` shape. */
  params: Set<string>;
}

export function captureRegistry(): Map<string, CapturedTool> {
  const server = new McpServer({ name: "capture-registry", version: "0.0.0" });
  const captured = new Map<string, CapturedTool>();

  const original = server.registerTool.bind(server);
  const spy = (name: string, config: unknown, handler: unknown): unknown => {
    // `inputSchema` is a plain object of Zod validators keyed by parameter
    // name (the MCP SDK's shape form), so its keys ARE the parameter names.
    const schema = (config as { inputSchema?: Record<string, unknown> })?.inputSchema ?? {};
    captured.set(name, { name, params: new Set(Object.keys(schema)) });
    return (original as unknown as (...a: unknown[]) => unknown)(name, config, handler);
  };
  (server as unknown as { registerTool: unknown }).registerTool = spy;

  // The client is never called: registration only reads the config objects.
  registerAllTools(server, {} as MnemosyneClient);

  if (captured.size === 0) {
    // A capture that silently returns nothing would make every consumer vacuous
    // — the exact "guard that protects nothing" shape these tests exist against.
    throw new Error("captureRegistry: registerAllTools registered no tools");
  }
  return captured;
}
