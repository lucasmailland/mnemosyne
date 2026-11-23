import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { describe, expect, it, vi } from "vitest";
import { registerWorkspace } from "../workspace.js";

describe("memory_workspace MCP tool", () => {
  it("registers memory_workspace tool with action schema", async () => {
    const server = new McpServer({ name: "workspace-test", version: "1.0.0" });
    let toolHandler:
      | ((args: {
          action: "list" | "members" | "current";
          workspaceId?: string;
        }) => Promise<unknown>)
      | undefined;

    const original = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, handler) => {
      if (name === "memory_workspace") toolHandler = handler as typeof toolHandler;
      return original(name, config, handler);
    });

    const client = {
      listMyWorkspaces: vi.fn(async () => [{ workspaceId: "ws-1", workspaceName: "App 1" }]),
      listWorkspaceMembers: vi.fn(async (wsId: string) => [
        { userId: "u-1", role: "admin", joinedAt: null },
      ]),
      getMe: vi.fn(async () => ({ workspaceId: "ws-1", keyPrefix: "mk_live", plan: "pro" })),
      listWorkspacesForCurrentTenant: vi.fn(async () => []),
    } as unknown as MnemosyneClient;

    registerWorkspace(server, client);
    expect(toolHandler).toBeDefined();

    // Test action="list"
    const listRes = (await toolHandler!({ action: "list" })) as {
      structuredContent: { workspaces: unknown[] };
    };
    expect(client.listMyWorkspaces).toHaveBeenCalled();
    expect(listRes.structuredContent.workspaces).toHaveLength(1);

    // Test action="members"
    const membersRes = (await toolHandler!({ action: "members", workspaceId: "ws-1" })) as {
      structuredContent: { members: unknown[] };
    };
    expect(client.listWorkspaceMembers).toHaveBeenCalledWith("ws-1");
    expect(membersRes.structuredContent.members).toHaveLength(1);

    // Test action="current"
    const currentRes = (await toolHandler!({ action: "current" })) as {
      structuredContent: { workspaceId: string };
    };
    expect(client.getMe).toHaveBeenCalled();
    expect(currentRes.structuredContent.workspaceId).toBe("ws-1");
  });

  it("returns isError when action='members' is missing workspaceId", async () => {
    const server = new McpServer({ name: "workspace-test", version: "1.0.0" });
    let toolHandler:
      | ((args: {
          action: "list" | "members" | "current";
          workspaceId?: string;
        }) => Promise<unknown>)
      | undefined;

    vi.spyOn(server, "registerTool").mockImplementation(((
      name: string,
      _config: unknown,
      handler: unknown
    ) => {
      if (name === "memory_workspace") toolHandler = handler as typeof toolHandler;
      return server;
    }) as never);

    registerWorkspace(server, {} as MnemosyneClient);

    const res = (await toolHandler!({ action: "members" })) as { isError: boolean };
    expect(res.isError).toBe(true);
  });
});

type WorkspaceArgs = {
  action: "list" | "describe" | "members" | "current" | "create" | "invite" | "set_role" | "remove";
  workspaceId?: string;
  userId?: string;
  role?: "owner" | "admin" | "write" | "read";
  name?: string;
  slug?: string;
  visibility?: "private" | "public";
  ownerUserId?: string;
  tenantId?: string;
};

function captureHandler(client: MnemosyneClient): (args: WorkspaceArgs) => Promise<{
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
}> {
  const server = new McpServer({ name: "workspace-test", version: "1.0.0" });
  let toolHandler: ((args: WorkspaceArgs) => Promise<unknown>) | undefined;
  vi.spyOn(server, "registerTool").mockImplementation(((
    name: string,
    _config: unknown,
    handler: unknown
  ) => {
    if (name === "memory_workspace") toolHandler = handler as typeof toolHandler;
    return server;
  }) as never);
  registerWorkspace(server, client);
  return toolHandler as never;
}

describe("memory_workspace — M1 new actions", () => {
  it("action='describe' calls getWorkspaceById and requires workspaceId", async () => {
    const client = {
      getWorkspaceById: vi.fn(async (id: string) => ({
        id,
        name: "W",
        slug: null,
        tenantId: "t1",
        visibility: "private",
        createdAt: null,
      })),
    } as unknown as MnemosyneClient;
    const handler = captureHandler(client);

    const res = await handler({ action: "describe", workspaceId: "ws1" });
    expect(client.getWorkspaceById).toHaveBeenCalledWith("ws1");
    expect(res.structuredContent?.workspace).toMatchObject({ id: "ws1" });

    const missing = await handler({ action: "describe" });
    expect(missing.isError).toBe(true);
  });

  it("action='create' resolves tenantId from getMe when omitted, and passes it through when given", async () => {
    const client = {
      createWorkspace: vi.fn(async (tenantId: string, input: { name: string }) => ({
        id: "ws_new",
        name: input.name,
        slug: null,
        tenantId,
        visibility: "private",
        createdAt: null,
      })),
      getMe: vi.fn(async () => ({ tenantId: "t_from_me" })),
    } as unknown as MnemosyneClient;
    const handler = captureHandler(client);

    const withTenant = await handler({ action: "create", name: "A", tenantId: "t_explicit" });
    expect(client.createWorkspace).toHaveBeenCalledWith("t_explicit", { name: "A" });
    expect(client.getMe).not.toHaveBeenCalled();
    expect(withTenant.structuredContent?.workspace).toMatchObject({ tenantId: "t_explicit" });

    const withoutTenant = await handler({ action: "create", name: "B" });
    expect(client.getMe).toHaveBeenCalled();
    expect(client.createWorkspace).toHaveBeenCalledWith("t_from_me", { name: "B" });
    expect(withoutTenant.structuredContent?.workspace).toMatchObject({ tenantId: "t_from_me" });

    const missingName = await handler({ action: "create" });
    expect(missingName.isError).toBe(true);
  });

  it("action='create' errors cleanly when no tenantId is given and the key has no tenant binding", async () => {
    const client = {
      getMe: vi.fn(async () => ({ tenantId: null })),
    } as unknown as MnemosyneClient;
    const handler = captureHandler(client);

    const res = await handler({ action: "create", name: "A" });
    expect(res.isError).toBe(true);
  });

  it("action='invite' requires workspaceId + userId, defaults role via client", async () => {
    const client = {
      inviteWorkspaceMember: vi.fn(async () => ({ ok: true })),
    } as unknown as MnemosyneClient;
    const handler = captureHandler(client);

    const res = await handler({
      action: "invite",
      workspaceId: "ws1",
      userId: "u1",
      role: "write",
    });
    expect(client.inviteWorkspaceMember).toHaveBeenCalledWith("ws1", {
      userId: "u1",
      role: "write",
    });
    expect(res.structuredContent).toEqual({ ok: true });

    expect((await handler({ action: "invite", userId: "u1" })).isError).toBe(true);
    expect((await handler({ action: "invite", workspaceId: "ws1" })).isError).toBe(true);
  });

  it("action='set_role' requires workspaceId + userId + role", async () => {
    const client = {
      updateWorkspaceMemberRole: vi.fn(async () => ({ ok: true })),
    } as unknown as MnemosyneClient;
    const handler = captureHandler(client);

    const res = await handler({
      action: "set_role",
      workspaceId: "ws1",
      userId: "u1",
      role: "admin",
    });
    expect(client.updateWorkspaceMemberRole).toHaveBeenCalledWith("ws1", "u1", "admin");
    expect(res.structuredContent).toEqual({ ok: true });

    expect((await handler({ action: "set_role", workspaceId: "ws1", userId: "u1" })).isError).toBe(
      true
    );
  });

  it("action='remove' requires workspaceId + userId", async () => {
    const client = {
      removeWorkspaceMember: vi.fn(async () => ({ ok: true })),
    } as unknown as MnemosyneClient;
    const handler = captureHandler(client);

    const res = await handler({ action: "remove", workspaceId: "ws1", userId: "u1" });
    expect(client.removeWorkspaceMember).toHaveBeenCalledWith("ws1", "u1");
    expect(res.structuredContent).toEqual({ ok: true });

    expect((await handler({ action: "remove", workspaceId: "ws1" })).isError).toBe(true);
  });

  it("a thrown client error (e.g. 403 from the server's role narrowing) surfaces as isError, not a crash", async () => {
    const client = {
      inviteWorkspaceMember: vi.fn(async () => {
        throw new Error("403 insufficient scope");
      }),
    } as unknown as MnemosyneClient;
    const handler = captureHandler(client);

    const res = await handler({ action: "invite", workspaceId: "ws1", userId: "u1" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("403");
  });
});
