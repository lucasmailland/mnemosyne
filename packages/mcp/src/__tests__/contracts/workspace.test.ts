/**
 * Contract test for `memory_workspace` (packages/mcp/src/tools/workspace.ts),
 * covering docs/archive/openspec/tool-promise-remediation/tools/memory_workspace.md.
 *
 * The audit's isolation scenario is what makes this tool worth a contract
 * test: it is the one tool whose actions cross the workspace boundary that
 * RLS exists to enforce. The MCP layer cannot verify isolation — that is a
 * server + RLS claim, proven in
 * `server/src/__tests__/integration/workspace-role-scopes.integration.test.ts`
 * against a real NOSUPERUSER role.
 *
 * What IS the MCP layer's responsibility, and what this file proves: that
 * each action reaches its own client method with the caller's ids intact.
 * A membership mutation (`set_role`, `remove`) landing on the wrong workspace
 * or the wrong user is an access-control incident, and it would look like a
 * successful call.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerWorkspace } from "../../tools/workspace.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(client: MnemosyneClient): {
  call: (args: Record<string, unknown>) => Promise<ToolResult>;
  description: string;
} {
  const server = new McpServer({ name: "workspace-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_workspace") {
        handler = cb as typeof handler;
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerWorkspace(server, client);
  if (!handler) throw new Error("memory_workspace was not registered");
  return { call: handler, description };
}

const stub = (p: Record<string, unknown>): MnemosyneClient => p as unknown as MnemosyneClient;

describe("memory_workspace — contract", () => {
  it("read actions reach their own methods with the given ids", async () => {
    const getWorkspaceById = vi.fn(async () => ({ id: "ws_1" }));
    const listWorkspaceMembers = vi.fn(async () => []);
    const getMe = vi.fn(async () => ({ workspaceId: "ws_1" }));
    const { call } = capture(stub({ getWorkspaceById, listWorkspaceMembers, getMe }));

    await call({ action: "describe", workspaceId: "ws_1" });
    expect(getWorkspaceById).toHaveBeenCalledWith("ws_1");

    await call({ action: "members", workspaceId: "ws_1" });
    expect(listWorkspaceMembers).toHaveBeenCalledWith("ws_1");
  });

  it("set_role carries BOTH the workspace and the user, in that order", async () => {
    const updateWorkspaceMemberRole = vi.fn(async () => ({ ok: true }));
    const { call } = capture(stub({ updateWorkspaceMemberRole }));

    await call({ action: "set_role", workspaceId: "ws_1", userId: "user_1", role: "write" });

    // Swapping these two ids would grant a role in the wrong workspace and
    // return success. There is no downstream check that would notice.
    expect(updateWorkspaceMemberRole).toHaveBeenCalledWith("ws_1", "user_1", "write");
  });

  it("remove targets exactly the given member of the given workspace", async () => {
    const removeWorkspaceMember = vi.fn(async () => ({ removed: true }));
    const { call } = capture(stub({ removeWorkspaceMember }));

    await call({ action: "remove", workspaceId: "ws_1", userId: "user_1" });

    expect(removeWorkspaceMember).toHaveBeenCalledWith("ws_1", "user_1");
  });

  it("surfaces a 403 as a readable tool error", async () => {
    // The role ceiling lives server-side; when it refuses, the agent must be
    // able to read why rather than see an unhandled rejection.
    const { call } = capture(
      stub({
        removeWorkspaceMember: vi.fn(async () => {
          throw new Error("403 requires owner or admin");
        }),
      })
    );

    const res = await call({ action: "remove", workspaceId: "ws_1", userId: "user_1" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("403");
  });
});
