/**
 * Unit tests for the memory_remind_when MCP tool.
 *
 * Tests cover the `status` filter added to `action:"list"` (spec.md
 * Requirement 3 of docs/archive/openspec/tool-promise-remediation): before this fix, a
 * triggered reminder's `content` was permanently unreachable through this
 * tool — `list` always defaulted to `status:"pending"` server-side with no
 * way to override it, even though the server already supported
 * `status:"triggered"`/`"all"` and the row (with full content) was never
 * deleted.
 */

import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRemindWhen } from "../tools/remind_when.js";

function makeClientStub(
  partial: Partial<Pick<MnemosyneClient, "listReminders" | "dismissReminder" | "createReminder">>
): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

function registerAndCapture(client: MnemosyneClient): {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      if (toolName === "memory_remind_when") handler = cb;
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerRemindWhen(server, client);
  if (!handler) throw new Error("memory_remind_when was not registered");
  return { handler };
}

describe("memory_remind_when action='list' status filter", () => {
  it("defaults to no explicit status (server default 'pending') when status is omitted", async () => {
    const listReminders = vi.fn().mockResolvedValue({ reminders: [] });
    const { handler } = registerAndCapture(makeClientStub({ listReminders }));

    await handler({ action: "list" });

    expect(listReminders).toHaveBeenCalledWith({});
  });

  it("passes status:'triggered' through to the client so triggered reminders (with content) become visible", async () => {
    const triggeredReminder = {
      id: "rem-1",
      content: "The full content of a reminder that already fired",
      condition: "when user mentions Acme",
      triggerAt: null,
      status: "triggered",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const listReminders = vi.fn().mockResolvedValue({ reminders: [triggeredReminder] });
    const { handler } = registerAndCapture(makeClientStub({ listReminders }));

    const result = (await handler({ action: "list", status: "triggered" })) as {
      structuredContent: { reminders: Array<{ content: string }> };
    };

    expect(listReminders).toHaveBeenCalledWith({ status: "triggered" });
    expect(result.structuredContent.reminders).toHaveLength(1);
    expect(result.structuredContent.reminders[0]!.content).toBe(
      "The full content of a reminder that already fired"
    );
  });

  it("passes status:'all' through to the client", async () => {
    const listReminders = vi.fn().mockResolvedValue({ reminders: [] });
    const { handler } = registerAndCapture(makeClientStub({ listReminders }));

    await handler({ action: "list", status: "all", limit: 50 });

    expect(listReminders).toHaveBeenCalledWith({ status: "all", limit: 50 });
  });
});

describe("memory_remind_when triggerAt keeps zod 4.4's ISO date-time set", () => {
  async function create(triggerAt: string) {
    const createReminder = vi.fn().mockResolvedValue({ id: "rem-1", status: "pending" });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerRemindWhen(server, makeClientStub({ createReminder }));
    const client = new Client({ name: "c", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({
      name: "memory_remind_when",
      arguments: { action: "create", content: "ship it", triggerAt },
    });
    await client.close();
    return { result, createReminder };
  }

  it.each(["2026-08-01T09:00Z", "2026-08-01T09:00:00Z", "2026-08-01T09:00:00.000Z"])(
    "accepts %s and forwards it unchanged",
    async (triggerAt) => {
      const { result, createReminder } = await create(triggerAt);
      expect(result.isError).toBeFalsy();
      expect(createReminder.mock.calls[0]?.[0]).toMatchObject({ triggerAt });
    }
  );

  it("rejects a value that is not a date-time", async () => {
    const { result, createReminder } = await create("tomorrow at nine");
    expect(result.isError).toBe(true);
    expect(createReminder).not.toHaveBeenCalled();
  });
});
