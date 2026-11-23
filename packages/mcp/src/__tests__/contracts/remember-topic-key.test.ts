/**
 * `memory_remember`'s `topicKey` parameter (topicKey pass-through fix,
 * slice a) — proves the MCP tool schema now accepts `topicKey` at all
 * (it previously wasn't in `inputSchema`, packages/mcp/src/tools/remember.ts:29-99)
 * and forwards it verbatim to `client.remember(...)`, which is what reaches
 * `mergeFactByTopicKey`/`mergeDecisionByTopicKey` on the server side
 * (covered end-to-end at the core level by
 * packages/core/src/cognitive/__tests__/fact-topic-key-upsert.test.ts and
 * decision-topic-key-upsert.test.ts, and at the wire level by
 * packages/server/src/__tests__/remember-topic-key-echo.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRemember } from "../../tools/remember.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function registerAndCapture(client: MnemosyneClient): {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      if (toolName === "memory_remember") {
        handler = cb as unknown as (args: Record<string, unknown>) => Promise<ToolResult>;
      }
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerRemember(server, client);
  if (!handler) throw new Error("memory_remember was not registered");
  return { handler };
}

describe("memory_remember — topicKey pass-through to client.remember", () => {
  it("forwards topicKey for kind: 'fact'", async () => {
    const remember = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "f_1",
      kind: "fact",
      staged: false,
    }));
    const { handler } = registerAndCapture({ remember } as unknown as MnemosyneClient);

    const out = await handler({
      statement: "Deploy target is us-east-1",
      subject: "deploy-region",
      topicKey: "deploy-region",
    });

    expect(out.isError).not.toBe(true);
    expect(remember).toHaveBeenCalledOnce();
    const [calledArgs] = remember.mock.calls[0]!;
    expect((calledArgs as { topicKey?: string }).topicKey).toBe("deploy-region");
  });

  it("forwards topicKey for kind: 'decision'", async () => {
    const remember = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "d_1",
      kind: "decision",
      staged: false,
    }));
    const { handler } = registerAndCapture({ remember } as unknown as MnemosyneClient);

    const out = await handler({
      statement: "We will use event sourcing for the audit log",
      subject: "Audit log architecture",
      kind: "decision",
      topicKey: "audit-log-architecture",
    });

    expect(out.isError).not.toBe(true);
    expect(remember).toHaveBeenCalledOnce();
    const [calledArgs] = remember.mock.calls[0]!;
    expect((calledArgs as { topicKey?: string }).topicKey).toBe("audit-log-architecture");
    expect((calledArgs as { kind?: string }).kind).toBe("decision");
  });

  it("omits topicKey from the client call when not supplied", async () => {
    const remember = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "f_1",
      kind: "fact",
      staged: false,
    }));
    const { handler } = registerAndCapture({ remember } as unknown as MnemosyneClient);

    await handler({ statement: "no topic key here" });

    expect(remember).toHaveBeenCalledOnce();
    const [calledArgs] = remember.mock.calls[0]!;
    expect(calledArgs).not.toHaveProperty("topicKey");
  });
});
