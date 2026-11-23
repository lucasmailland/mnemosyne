/**
 * Contract test for `memory_event`'s P57 slice 3a addition:
 * `targetWorkspaceId` forwarding to `client.createEvent` on `action:'create'`
 * only, the D5 guard rejecting it on any other action with ZERO HTTP calls,
 * and that the server's resolved `workspaceId` round-trips through the
 * tool's result content untouched.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerEvent } from "../../tools/event.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(client: MnemosyneClient): (args: Record<string, unknown>) => Promise<ToolResult> {
  const server = new McpServer({ name: "event-target-workspace-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_event") handler = cb as unknown as typeof handler;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerEvent(server, client);
  if (!handler) throw new Error("memory_event was not registered");
  return handler;
}

function stub(partial: Record<string, unknown>): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

const TARGET_WS = "44444444-4444-4444-8444-444444444444";

const CREATE_ARGS = {
  action: "create",
  type: "system",
  name: "deploy",
  description: "deploy concretado",
  occurredAt: "2026-08-11T00:00:00.000Z",
  source: "ci",
};

describe("memory_event — targetWorkspaceId forwarding (P57 slice 3a)", () => {
  it("forwards targetWorkspaceId to client.createEvent on action:'create'", async () => {
    const createEvent = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "evt_1",
      workspaceId: TARGET_WS,
      ...CREATE_ARGS,
    }));
    const handler = capture(stub({ createEvent }));

    await handler({ ...CREATE_ARGS, targetWorkspaceId: TARGET_WS });

    expect(createEvent).toHaveBeenCalledOnce();
    const input = createEvent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.targetWorkspaceId).toBe(TARGET_WS);
  });

  it("omits targetWorkspaceId from the forwarded body when not supplied on create", async () => {
    const createEvent = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "evt_2",
      workspaceId: "ws_key",
      ...CREATE_ARGS,
    }));
    const handler = capture(stub({ createEvent }));

    await handler(CREATE_ARGS);

    const input = createEvent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("targetWorkspaceId" in input).toBe(false);
  });

  it("surfaces the server's resolved workspaceId back through structuredContent on a cross-workspace create", async () => {
    const createEvent = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "evt_3",
      workspaceId: TARGET_WS,
      ...CREATE_ARGS,
    }));
    const handler = capture(stub({ createEvent }));

    const out = await handler({ ...CREATE_ARGS, targetWorkspaceId: TARGET_WS });

    expect(out.isError).toBeFalsy();
    expect(out.structuredContent?.workspaceId).toBe(TARGET_WS);
  });

  it("D5 guard: rejects targetWorkspaceId on action:'get' with isError and makes ZERO client calls", async () => {
    const createEvent = vi.fn();
    const getEvent = vi.fn();
    const handler = capture(stub({ createEvent, getEvent }));

    const out = await handler({ action: "get", id: "evt_1", targetWorkspaceId: TARGET_WS });

    expect(out.isError).toBe(true);
    expect(createEvent).not.toHaveBeenCalled();
    expect(getEvent).not.toHaveBeenCalled();
  });

  it("D5 guard: rejects targetWorkspaceId on action:'annotate' with isError and makes ZERO client calls", async () => {
    const createEvent = vi.fn();
    const annotateEvent = vi.fn();
    const handler = capture(stub({ createEvent, annotateEvent }));

    const out = await handler({
      action: "annotate",
      id: "evt_1",
      author: "a",
      content: "c",
      targetWorkspaceId: TARGET_WS,
    });

    expect(out.isError).toBe(true);
    expect(createEvent).not.toHaveBeenCalled();
    expect(annotateEvent).not.toHaveBeenCalled();
  });
});
