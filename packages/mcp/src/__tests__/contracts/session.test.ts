/**
 * Contract test for `memory_session` (packages/mcp/src/tools/session.ts).
 *
 * Covers the `get`/`list` actions added to close an orphan-route gap found
 * during a promise-fidelity audit (2026-07-31): `GET /session/:id` and
 * `GET /session/list` were implemented server-side but unreachable from any
 * client — client-ts had no `getSession`/`listSessions` method, so no
 * CLI/MCP surface could exist even though the routes worked.
 */
import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSession } from "../../tools/session.js";
import { registeredDescription } from "./registered-description.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function registerAndCapture(client: MnemosyneClient): {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  description: string;
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      if (toolName === "memory_session") {
        handler = cb as unknown as (args: Record<string, unknown>) => Promise<ToolResult>;
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerSession(server, client);
  if (!handler) throw new Error("memory_session was not registered");
  return { handler, description: registeredDescription("memory_session") };
}

describe("memory_session — description discloses `get`/`list`", () => {
  it("mentions all 10 actions including get and list", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).toMatch(/\bget\b/);
    expect(description).toMatch(/\blist\b/);
  });
});

describe("memory_session action:'get'", () => {
  it("calls client.getSession with sessionId", async () => {
    const getSession = vi.fn(async () => ({
      id: "sess_1",
      agentId: null,
      status: "active",
      createdAt: "2026-07-31T00:00:00.000Z",
      label: null,
      lastRecallAt: null,
    }));
    const { handler } = registerAndCapture({ getSession } as unknown as MnemosyneClient);
    const out = await handler({ action: "get", sessionId: "sess_1" });
    expect(getSession).toHaveBeenCalledWith("sess_1");
    expect(out.structuredContent).toMatchObject({ id: "sess_1", status: "active" });
  });

  it("rejects when `sessionId` is missing", async () => {
    const { handler } = registerAndCapture({} as MnemosyneClient);
    const out = await handler({ action: "get" });
    expect(out.isError).toBe(true);
  });
});

describe("memory_session action:'list'", () => {
  it("calls client.listSessions with no arguments", async () => {
    const listSessions = vi.fn(async () => ({ sessions: [] }));
    const { handler } = registerAndCapture({ listSessions } as unknown as MnemosyneClient);
    const out = await handler({ action: "list" });
    expect(listSessions).toHaveBeenCalledWith();
    expect(out.structuredContent).toEqual({ sessions: [] });
  });
});
