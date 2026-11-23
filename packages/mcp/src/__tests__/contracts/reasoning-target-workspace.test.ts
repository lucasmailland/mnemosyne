/**
 * Contract test for `memory_reasoning`'s P57 slice 3a addition:
 * `targetWorkspaceId` forwarding to `client.createReasoning` on
 * `action:'create'` only (POST /reasoning). `action:'record'` maps to
 * `POST /reasoning/record`, which S2a deliberately did NOT extend with
 * `targetWorkspaceId` — so `record` is treated as a D5-guarded non-create op
 * here too, same as `get`/`list`/`patch`/`archive`/`resolve`/`feedback`.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerReasoning } from "../../tools/reasoning.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(client: MnemosyneClient): (args: Record<string, unknown>) => Promise<ToolResult> {
  const server = new McpServer({ name: "reasoning-target-workspace-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_reasoning") handler = cb as unknown as typeof handler;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerReasoning(server, client);
  if (!handler) throw new Error("memory_reasoning was not registered");
  return handler;
}

function stub(partial: Record<string, unknown>): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

const TARGET_WS = "55555555-5555-4555-8555-555555555555";

const CHAIN = [{ step: 0, reasoning: "because", conclusion: "therefore" }];

describe("memory_reasoning — targetWorkspaceId forwarding (P57 slice 3a)", () => {
  it("forwards targetWorkspaceId to client.createReasoning on action:'create'", async () => {
    const createReasoning = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "reas_1",
      workspaceId: TARGET_WS,
      question: "q",
      chain: CHAIN,
      conclusion: "c",
      status: "active" as const,
    }));
    const handler = capture(stub({ createReasoning }));

    await handler({
      action: "create",
      question: "q",
      chain: CHAIN,
      conclusion: "c",
      targetWorkspaceId: TARGET_WS,
    });

    expect(createReasoning).toHaveBeenCalledOnce();
    const input = createReasoning.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.targetWorkspaceId).toBe(TARGET_WS);
  });

  it("omits targetWorkspaceId from the forwarded body when not supplied on create", async () => {
    const createReasoning = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "reas_2",
      workspaceId: "ws_key",
      question: "q",
      chain: CHAIN,
      conclusion: "c",
      status: "active" as const,
    }));
    const handler = capture(stub({ createReasoning }));

    await handler({ action: "create", question: "q", chain: CHAIN, conclusion: "c" });

    const input = createReasoning.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("targetWorkspaceId" in input).toBe(false);
  });

  it("surfaces the server's resolved workspaceId back through structuredContent on a cross-workspace create", async () => {
    const createReasoning = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "reas_3",
      workspaceId: TARGET_WS,
      question: "q",
      chain: CHAIN,
      conclusion: "c",
      status: "active" as const,
    }));
    const handler = capture(stub({ createReasoning }));

    const out = await handler({
      action: "create",
      question: "q",
      chain: CHAIN,
      conclusion: "c",
      targetWorkspaceId: TARGET_WS,
    });

    expect(out.isError).toBeFalsy();
    expect(out.structuredContent?.workspaceId).toBe(TARGET_WS);
  });

  it("D5 guard: rejects targetWorkspaceId on action:'get' with isError and makes ZERO client calls", async () => {
    const createReasoning = vi.fn();
    const getReasoning = vi.fn();
    const handler = capture(stub({ createReasoning, getReasoning }));

    const out = await handler({ action: "get", id: "reas_1", targetWorkspaceId: TARGET_WS });

    expect(out.isError).toBe(true);
    expect(createReasoning).not.toHaveBeenCalled();
    expect(getReasoning).not.toHaveBeenCalled();
  });

  it("D5 guard: rejects targetWorkspaceId on action:'record' with isError and makes ZERO client calls (POST /reasoning/record has no targetWorkspaceId support)", async () => {
    const createReasoning = vi.fn();
    const recordReasoning = vi.fn();
    const handler = capture(stub({ createReasoning, recordReasoning }));

    const out = await handler({
      action: "record",
      question: "q",
      chain: CHAIN,
      conclusion: "c",
      targetWorkspaceId: TARGET_WS,
    });

    expect(out.isError).toBe(true);
    expect(createReasoning).not.toHaveBeenCalled();
    expect(recordReasoning).not.toHaveBeenCalled();
  });
});
