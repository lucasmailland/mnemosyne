/**
 * `memory_suggest_topic_key` (tool #35) — pure proxy to `POST
 * /topic-key/suggest`. This suite proves two things:
 *
 * 1. The tool itself forwards subject/body to `client.suggestTopicKey()`
 *    verbatim and surfaces the response, doing no local computation
 *    (spec.md capability 1).
 * 2. The `topicKey` it derives is accepted, with no schema error, by all 3
 *    downstream write shapes that actually consume a `topicKey`:
 *    fact-via-remember, decision-via-remember, and decision-via-decide
 *    (spec.md: "handles fact-via-remember/decision-via-remember/
 *    decision-via-decide shapes").
 */
import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSuggestTopicKey } from "../../tools/suggest_topic_key.js";
import { registerRemember } from "../../tools/remember.js";
import { registerDecide } from "../../tools/decide.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureHandler(
  register: (server: McpServer, client: MnemosyneClient) => void,
  toolName: string,
  client: MnemosyneClient
): Handler {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: Handler | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (args: Record<string, unknown>) => Promise<unknown>) => {
      if (name === toolName) handler = cb as unknown as Handler;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  register(server, client);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

describe("memory_suggest_topic_key — pure proxy, no local computation", () => {
  it("forwards subject/body to client.suggestTopicKey() and surfaces the response", async () => {
    const suggestTopicKey = vi.fn(async () => ({
      topicKey: "auth-strategy/use-jwt-rotation",
      levels: ["auth-strategy", "use-jwt-rotation"],
      source: "subject+body" as const,
    }));
    const handler = captureHandler(registerSuggestTopicKey, "memory_suggest_topic_key", {
      suggestTopicKey,
    } as unknown as MnemosyneClient);

    const out = await handler({ subject: "Auth Strategy", body: "Use JWT rotation" });

    expect(out.isError).not.toBe(true);
    expect(suggestTopicKey).toHaveBeenCalledOnce();
    expect(suggestTopicKey).toHaveBeenCalledWith({
      subject: "Auth Strategy",
      body: "Use JWT rotation",
    });
    expect(out.structuredContent).toMatchObject({ topicKey: "auth-strategy/use-jwt-rotation" });
  });

  it("omits subject/body from the client call when not supplied", async () => {
    const suggestTopicKey = vi.fn(async () => ({
      topicKey: "general",
      levels: ["general"],
      source: "fallback" as const,
    }));
    const handler = captureHandler(registerSuggestTopicKey, "memory_suggest_topic_key", {
      suggestTopicKey,
    } as unknown as MnemosyneClient);

    await handler({});

    expect(suggestTopicKey).toHaveBeenCalledOnce();
    expect(suggestTopicKey).toHaveBeenCalledWith({});
  });

  it("surfaces isError when the client call rejects", async () => {
    const suggestTopicKey = vi.fn(async () => {
      throw new Error("network down");
    });
    const handler = captureHandler(registerSuggestTopicKey, "memory_suggest_topic_key", {
      suggestTopicKey,
    } as unknown as MnemosyneClient);

    const out = await handler({ subject: "x" });

    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("network down");
  });
});

describe("memory_suggest_topic_key output feeds all 3 downstream write shapes", () => {
  const derivedTopicKey = "audit-log/event-sourcing";

  it("fact-via-remember: memory_remember(kind:'fact', topicKey) reaches client.remember with no schema error", async () => {
    const remember = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "f_1",
      kind: "fact",
      staged: false,
    }));
    const handler = captureHandler(registerRemember, "memory_remember", {
      remember,
    } as unknown as MnemosyneClient);

    const out = await handler({
      statement: "We store audit events via event sourcing",
      subject: "audit-log",
      topicKey: derivedTopicKey,
    });

    expect(out.isError).not.toBe(true);
    expect(remember).toHaveBeenCalledOnce();
    const [calledArgs] = remember.mock.calls[0]!;
    expect((calledArgs as { topicKey?: string }).topicKey).toBe(derivedTopicKey);
    expect((calledArgs as { kind?: string }).kind).toBe("fact");
  });

  it("decision-via-remember: memory_remember(kind:'decision', topicKey) reaches client.remember with no schema error", async () => {
    const remember = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "d_1",
      kind: "decision",
      staged: false,
    }));
    const handler = captureHandler(registerRemember, "memory_remember", {
      remember,
    } as unknown as MnemosyneClient);

    const out = await handler({
      statement: "We will use event sourcing for the audit log",
      subject: "Audit log architecture",
      kind: "decision",
      topicKey: derivedTopicKey,
    });

    expect(out.isError).not.toBe(true);
    expect(remember).toHaveBeenCalledOnce();
    const [calledArgs] = remember.mock.calls[0]!;
    expect((calledArgs as { topicKey?: string }).topicKey).toBe(derivedTopicKey);
    expect((calledArgs as { kind?: string }).kind).toBe("decision");
  });

  it("decision-via-decide: memory_decide(topicKey) reaches client.createDecision with no schema error", async () => {
    const createDecision = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "d_2",
      kind: "decision",
    }));
    const handler = captureHandler(registerDecide, "memory_decide", {
      createDecision,
    } as unknown as MnemosyneClient);

    const out = await handler({
      kind: "architecture",
      title: "Use event sourcing for the audit log",
      body: "Event sourcing gives us a full replayable history of every mutation.",
      topicKey: derivedTopicKey,
    });

    expect(out.isError).not.toBe(true);
    expect(createDecision).toHaveBeenCalledOnce();
    const [calledArgs] = createDecision.mock.calls[0]!;
    expect((calledArgs as { topicKey?: string }).topicKey).toBe(derivedTopicKey);
  });
});
