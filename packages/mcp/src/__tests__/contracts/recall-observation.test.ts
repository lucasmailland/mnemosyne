import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { registerRecall } from "../../tools/recall.js";
import { registerRemember } from "../../tools/remember.js";
import { MCP_VERSION } from "../../version.js";

type Handler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

function setup(client: Record<string, unknown>, tool: "memory_recall" | "memory_remember") {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: Handler | undefined;
  const original = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation((name, schema, cb) => {
    if (name === tool) handler = cb as unknown as Handler;
    return original(name, schema, cb);
  });
  const c = client as unknown as MnemosyneClient;
  if (tool === "memory_recall") registerRecall(server, c);
  else registerRemember(server, c);
  return handler!;
}

// Metadata travels through `client.withObservation(...)` (a per-call clone that
// sends headers). It used to be an extra positional arg, which the real SDK
// silently dropped, so these assertions now target the factory instead.
function observable<T extends Record<string, unknown>>(methods: T) {
  const client: Record<string, unknown> = { ...methods };
  const withObservation = vi.fn((_o: Record<string, unknown>) => client);
  client.withObservation = withObservation;
  return { client, withObservation };
}

describe("MCP recall/remember observation metadata", () => {
  it("recall sends tool metadata, optional requestId, and ignores a caller actor", async () => {
    const recall = vi.fn(async (..._a: unknown[]) => ({ hits: [], requestId: "srv-1" }));
    const { client, withObservation } = observable({ recall });
    const handler = setup(client, "memory_recall");
    await handler({ query: "q", requestId: "retry-1", sessionId: "s1", actor: "evil" });
    await handler({ query: "q" });
    const [input] = recall.mock.calls[0] as [Record<string, unknown>];
    expect(withObservation.mock.calls[0]![0]).toEqual({
      requestId: "retry-1",
      caller: "mcp:memory_recall",
      clientVersion: MCP_VERSION,
    });
    expect(input).toMatchObject({ sessionId: "s1" });
    expect(JSON.stringify(recall.mock.calls[0])).not.toContain("evil");
    expect(JSON.stringify(withObservation.mock.calls)).not.toContain("evil");
    // A generated id is fixed per call (so retries share it) and differs per call.
    const generated = withObservation.mock.calls[1]![0].requestId as string;
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("recall returns the request id actually sent, as the real server only echoes it in a header", async () => {
    const hit = { id: "f1", content: "x", score: 1 };
    // Like the real /recall body: no requestId field at all.
    const recall = vi
      .fn()
      .mockResolvedValueOnce({ hits: [], nothingRelevant: true })
      .mockResolvedValueOnce({ hits: [hit], warnings: [{ code: "w" }] });
    const { client, withObservation } = observable({ recall });
    const handler = setup(client, "memory_recall");
    const empty = await handler({ query: "q" });
    const mixed = await handler({ query: "q", requestId: "retry-1" });
    const sent = withObservation.mock.calls.map((c) => c[0].requestId as string);
    expect(sent[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(empty.structuredContent).toMatchObject({ requestId: sent[0], memories: [] });
    expect(mixed.structuredContent).toMatchObject({
      requestId: "retry-1",
      warnings: [{ code: "w" }],
    });
  });

  it("remember sends writer metadata, keeps subtype/session and returned warnings", async () => {
    const warnings = [{ code: "subtype_substituted", requested: "bogus" }];
    const remember = vi.fn(async (..._a: unknown[]) => ({ id: "f1", warnings }));
    const { client, withObservation } = observable({ remember });
    const handler = setup(client, "memory_remember");
    const res = await handler({
      statement: "s",
      subtype: "bogus",
      sessionId: "s1",
      actorId: "evil",
      idempotencyKey: "k",
    });
    const [input, , key] = remember.mock.calls[0] as [Record<string, unknown>, unknown, string];
    expect(withObservation.mock.calls[0]![0]).toEqual({
      caller: "mcp:memory_remember",
      clientVersion: MCP_VERSION,
    });
    expect(key).toBe("k");
    expect(input).toMatchObject({ subtype: "bogus", sessionId: "s1" });
    expect(JSON.stringify(remember.mock.calls[0])).not.toContain("evil");
    expect(JSON.stringify(withObservation.mock.calls)).not.toContain("evil");
    expect(res.structuredContent).toMatchObject({ warnings });
  });
});
