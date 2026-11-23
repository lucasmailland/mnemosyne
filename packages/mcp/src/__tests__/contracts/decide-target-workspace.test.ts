/**
 * Contract test for `memory_decide`'s P57 slice 3a addition:
 * `targetWorkspaceId` forwarding to `client.createDecision`, and that the
 * server's resolved `workspaceId` (which may differ from the caller's key
 * workspace on a cross-workspace write) round-trips through the tool's
 * result content untouched.
 *
 * `memory_decide` has no `action` field (it is always a create), so there is
 * no D5 "non-create op" guard to test here — see decide.ts vs. the
 * multi-action tools (entity/task/event/reasoning) in the sibling
 * `*-target-workspace.test.ts` files.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerDecide } from "../../tools/decide.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(client: MnemosyneClient): (args: Record<string, unknown>) => Promise<ToolResult> {
  const server = new McpServer({ name: "decide-target-workspace-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_decide") handler = cb as unknown as typeof handler;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerDecide(server, client);
  if (!handler) throw new Error("memory_decide was not registered");
  return handler;
}

function stub(partial: Record<string, unknown>): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

const TARGET_WS = "11111111-1111-4111-8111-111111111111";

describe("memory_decide — targetWorkspaceId forwarding (P57 slice 3a)", () => {
  it("forwards targetWorkspaceId to client.createDecision when supplied", async () => {
    const createDecision = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "mdec_1",
      workspaceId: TARGET_WS,
      kind: "decision" as const,
      title: "t",
      body: "b",
      revisionCount: 1,
      status: "active" as const,
    }));
    const handler = capture(stub({ createDecision }));

    await handler({ kind: "decision", title: "t", body: "b", targetWorkspaceId: TARGET_WS });

    expect(createDecision).toHaveBeenCalledOnce();
    const input = createDecision.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.targetWorkspaceId).toBe(TARGET_WS);
  });

  it("omits targetWorkspaceId entirely from the forwarded input when not supplied", async () => {
    const createDecision = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "mdec_2",
      workspaceId: "ws_key",
      kind: "decision" as const,
      title: "t",
      body: "b",
      revisionCount: 1,
      status: "active" as const,
    }));
    const handler = capture(stub({ createDecision }));

    await handler({ kind: "decision", title: "t", body: "b" });

    const input = createDecision.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("targetWorkspaceId" in input).toBe(false);
  });

  it("surfaces the server's resolved workspaceId (cross-workspace) back through structuredContent, not swallowed", async () => {
    const createDecision = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "mdec_3",
      workspaceId: TARGET_WS,
      kind: "decision" as const,
      title: "t",
      body: "b",
      revisionCount: 1,
      status: "active" as const,
    }));
    const handler = capture(stub({ createDecision }));

    const out = await handler({
      kind: "decision",
      title: "t",
      body: "b",
      targetWorkspaceId: TARGET_WS,
    });

    expect(out.isError).toBeFalsy();
    expect(out.structuredContent?.workspaceId).toBe(TARGET_WS);
    const parsed = JSON.parse(out.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(parsed.workspaceId).toBe(TARGET_WS);
  });
});
