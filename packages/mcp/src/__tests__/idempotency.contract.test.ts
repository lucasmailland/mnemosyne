/**
 * §24 / §34.9 — MCP idempotency BEHAVIOR contract.
 *
 * contract.test.ts proves the idempotencyKey is an optional string in each
 * tool's schema. This file proves the tool HANDLER actually forwards the key
 * to the client method — i.e. idempotency is *honored*, not merely *declared*.
 *
 * Each row invokes the tool handler with a fixed idempotencyKey and asserts
 * the stubbed client method saw that key as its trailing argument. The TS
 * client (packages/client-ts/src/client.ts) places idempotencyKey LAST, after
 * the optional AbortSignal — e.g. createFact(input, signal?, idempotencyKey?).
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerRemember } from "../tools/remember.js";
import { registerForget } from "../tools/forget.js";
import { registerSession } from "../tools/session.js";

const KEY = "idem-key-fixed-001";

function capture(
  toolName: string,
  reg: (s: McpServer, c: MnemosyneClient) => void,
  client: MnemosyneClient
): (args: Record<string, unknown>) => Promise<unknown> {
  const server = new McpServer({ name: "idem", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<unknown>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === toolName) handler = cb;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  reg(server, client);
  if (!handler) throw new Error(`tool ${toolName} not registered`);
  return handler;
}

function stub(partial: Record<string, unknown>): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

describe("§24/§34.9 — MCP tools honor Idempotency-Key (behavioral)", () => {
  it("memory_remember forwards idempotencyKey as remember's trailing arg", async () => {
    const remember = vi.fn(async () => ({
      id: "f-1",
      workspaceId: "ws",
      statement: "x",
      status: "active",
    }));
    const handler = capture("memory_remember", registerRemember, stub({ remember }));
    await handler({ statement: "x", idempotencyKey: KEY });
    expect(remember).toHaveBeenCalledOnce();
    const [args] = remember.mock.calls;
    if (!args) throw new Error("remember was not called");
    expect(args.at(-1)).toBe(KEY);
  });

  it("memory_forget forwards idempotencyKey as forgetFact's trailing arg", async () => {
    const forgetFact = vi.fn(async () => undefined);
    const handler = capture("memory_forget", registerForget, stub({ forgetFact }));
    await handler({ factId: "f-1", idempotencyKey: KEY });
    expect(forgetFact).toHaveBeenCalledOnce();
    const [args] = forgetFact.mock.calls;
    if (!args) throw new Error("forgetFact was not called");
    expect(args.at(-1)).toBe(KEY);
  });

  it("memory_forget forwards idempotencyKey as forgetPrimitive's trailing arg for a non-fact kind", async () => {
    // Requirement 2 (spec.md) — idempotencyKey must be honored for EVERY
    // memory_forget kind, not only kind:'fact'. This covers the generic
    // forgetPrimitive branch (kind !== 'fact', e.g. 'task').
    const forgetPrimitive = vi.fn(async () => ({ forgotten: true }));
    const handler = capture("memory_forget", registerForget, stub({ forgetPrimitive }));
    await handler({ kind: "task", primitiveId: "t-1", idempotencyKey: KEY });
    expect(forgetPrimitive).toHaveBeenCalledOnce();
    const [args] = forgetPrimitive.mock.calls;
    if (!args) throw new Error("forgetPrimitive was not called");
    expect(args.at(-1)).toBe(KEY);
  });

  it("memory_session(pin) forwards idempotencyKey to pinFact", async () => {
    const pinFact = vi.fn(async () => ({ id: "f-1", pinned: true }));
    const handler = capture("memory_session", registerSession, stub({ pinFact }));
    await handler({ action: "pin", factId: "f-1", idempotencyKey: KEY });
    expect(pinFact).toHaveBeenCalledOnce();
    const [args] = pinFact.mock.calls;
    if (!args) throw new Error("pinFact was not called");
    expect(args.at(-1)).toBe(KEY);
  });

  it("memory_remember omits idempotencyKey when not supplied (trailing arg undefined)", async () => {
    const remember = vi.fn(async () => ({
      id: "f-1",
      workspaceId: "ws",
      statement: "x",
      status: "active",
    }));
    const handler = capture("memory_remember", registerRemember, stub({ remember }));
    await handler({ statement: "x" });
    expect(remember).toHaveBeenCalledOnce();
    const [args] = remember.mock.calls;
    if (!args) throw new Error("remember was not called");
    expect(args.at(-1)).toBeUndefined();
  });
});
