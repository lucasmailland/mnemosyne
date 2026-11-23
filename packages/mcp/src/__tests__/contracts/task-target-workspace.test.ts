/**
 * Contract test for `memory_task`'s P57 slice 3a addition:
 * `targetWorkspaceId` forwarding to `client.createTask` on `action:'create'`
 * only, the D5 guard rejecting it on any other action with ZERO HTTP calls,
 * and that the server's resolved `workspaceId` round-trips through the
 * tool's result content untouched.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerTask } from "../../tools/task.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(client: MnemosyneClient): (args: Record<string, unknown>) => Promise<ToolResult> {
  const server = new McpServer({ name: "task-target-workspace-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_task") handler = cb as unknown as typeof handler;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerTask(server, client);
  if (!handler) throw new Error("memory_task was not registered");
  return handler;
}

function stub(partial: Record<string, unknown>): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

const TARGET_WS = "33333333-3333-4333-8333-333333333333";

describe("memory_task — targetWorkspaceId forwarding (P57 slice 3a)", () => {
  it("forwards targetWorkspaceId to client.createTask on action:'create'", async () => {
    const createTask = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "task_1",
      workspaceId: TARGET_WS,
      title: "t",
      assignedTo: "agent:x",
      status: "pending" as const,
    }));
    const handler = capture(stub({ createTask }));

    await handler({
      action: "create",
      title: "t",
      assignedTo: "agent:x",
      targetWorkspaceId: TARGET_WS,
    });

    expect(createTask).toHaveBeenCalledOnce();
    const input = createTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.targetWorkspaceId).toBe(TARGET_WS);
  });

  it("omits targetWorkspaceId from the forwarded body when not supplied on create", async () => {
    const createTask = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "task_2",
      workspaceId: "ws_key",
      title: "t",
      assignedTo: "agent:x",
      status: "pending" as const,
    }));
    const handler = capture(stub({ createTask }));

    await handler({ action: "create", title: "t", assignedTo: "agent:x" });

    const input = createTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("targetWorkspaceId" in input).toBe(false);
  });

  it("surfaces the server's resolved workspaceId back through structuredContent on a cross-workspace create", async () => {
    const createTask = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "task_3",
      workspaceId: TARGET_WS,
      title: "t",
      assignedTo: "agent:x",
      status: "pending" as const,
    }));
    const handler = capture(stub({ createTask }));

    const out = await handler({
      action: "create",
      title: "t",
      assignedTo: "agent:x",
      targetWorkspaceId: TARGET_WS,
    });

    expect(out.isError).toBeFalsy();
    expect(out.structuredContent?.workspaceId).toBe(TARGET_WS);
  });

  it("D5 guard: rejects targetWorkspaceId on action:'get' with isError and makes ZERO client calls", async () => {
    const createTask = vi.fn();
    const getTask = vi.fn();
    const handler = capture(stub({ createTask, getTask }));

    const out = await handler({ action: "get", id: "task_1", targetWorkspaceId: TARGET_WS });

    expect(out.isError).toBe(true);
    expect(createTask).not.toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();
  });

  it("D5 guard: rejects targetWorkspaceId on action:'patch' with isError and makes ZERO client calls", async () => {
    const createTask = vi.fn();
    const patchTask = vi.fn();
    const handler = capture(stub({ createTask, patchTask }));

    const out = await handler({ action: "patch", id: "task_1", targetWorkspaceId: TARGET_WS });

    expect(out.isError).toBe(true);
    expect(createTask).not.toHaveBeenCalled();
    expect(patchTask).not.toHaveBeenCalled();
  });
});
