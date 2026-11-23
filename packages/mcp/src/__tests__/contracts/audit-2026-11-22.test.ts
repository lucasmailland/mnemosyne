/**
 * Audit 2026-11-22 — the tool surface tells the truth (APP-022, APP-063),
 * slow and failed calls say what happened (APP-014, APP-023), and every tool
 * declares what it does to the world (annotations).
 */
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MnemosyneAPIError,
  MnemosyneTimeoutError,
  type MnemosyneClient,
} from "@mnemo-ai/client-ts";
import { registerAllTools } from "../../registry.js";
import { formatMcpError } from "../../tools/errors.js";
import { EXPECTED_TOOL_NAMES } from "../tool-names.js";

type Result = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Registered = {
  config: { inputSchema?: Record<string, z.ZodType>; annotations?: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<Result>;
};

function registerWith(client: Record<string, unknown> = {}): Map<string, Registered> {
  const server = new McpServer({ name: "audit", version: "0.0.0" });
  const tools = new Map<string, Registered>();
  const original = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation((name, config, cb) => {
    tools.set(name, { config: config as Registered["config"], handler: cb as never });
    return original(name, config, cb);
  });
  registerAllTools(server, client as unknown as MnemosyneClient);
  return tools;
}

const tool = (name: string, client: Record<string, unknown> = {}) =>
  registerWith(client).get(name)!;
const field = (name: string, key: string) => tool(name).config.inputSchema![key]!;

describe("APP-022a: list limits match the server's 200 cap", () => {
  it.each([
    "memory_task",
    "memory_event",
    "memory_reasoning",
    "memory_strategy",
    "memory_hyperedge",
  ])("%s accepts limit 200 and refuses 201", (name) => {
    const limit = field(name, "limit");
    expect(limit.safeParse(200).success).toBe(true);
    expect(limit.safeParse(201).success).toBe(false);
    expect(limit.description ?? "").not.toContain("500");
  });
});

describe("APP-022b: kinds is the ten primitive kinds", () => {
  it.each(["memory_recall", "memory_search"])(
    "%s validates kinds and states the defaults",
    (name) => {
      const kinds = field(name, "kinds");
      expect(kinds.safeParse(["entity", "task", "event", "reasoning", "fact"]).success).toBe(true);
      expect(kinds.safeParse(["facts"]).success).toBe(false);
      expect(kinds.description).toMatch(/task.*event.*reasoning/);
      expect(kinds.description).toMatch(/episode/);
    }
  );
});

describe("APP-022c/d: sensitivity and scopeRef only where the server stores them", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["memory_task", { action: "patch", id: "t1", sensitivity: "restricted" }, "patchTask"],
    ["memory_strategy", { op: "patch", id: "s1", sensitivity: "restricted" }, "patchStrategy"],
    ["memory_strategy", { op: "patch", id: "s1", scopeRef: "proj" }, "patchStrategy"],
    ["memory_workflow", { action: "update", id: "w1", sensitivity: "public" }, "updateWorkflow"],
    ["memory_workflow", { action: "update", id: "w1", scopeRef: "proj" }, "updateWorkflow"],
    ["memory_entity", { action: "update", id: "e1", sensitivity: "restricted" }, "updateEntity"],
    [
      "memory_reasoning",
      { action: "patch", id: "r1", sensitivity: "restricted" },
      "patchReasoning",
    ],
  ];
  it.each(cases)("%s %j is refused, never silently dropped", async (name, args, method) => {
    const call = vi.fn(async () => ({ id: "x" }));
    const res = await tool(name, { [method]: call }).handler(args);
    expect(res.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toMatch(/sensitivity|scopeRef/);
  });

  it("still forwards them on create, and scopeRef as a list filter", async () => {
    const createTask = vi.fn(async (_body: Record<string, unknown>) => ({ id: "t1" }));
    await tool("memory_task", { createTask }).handler({
      action: "create",
      title: "x",
      assignedTo: "agent",
      sensitivity: "restricted",
    });
    expect(createTask.mock.calls[0]![0]).toMatchObject({ sensitivity: "restricted" });

    const listStrategies = vi.fn(async () => ({ items: [] }));
    const res = await tool("memory_strategy", { listStrategies }).handler({
      op: "list",
      scopeRef: "proj",
    });
    expect(res.isError).toBeUndefined();
    expect(listStrategies).toHaveBeenCalledWith(expect.objectContaining({ scopeRef: "proj" }));

    const createReasoning = vi.fn(async (_body: Record<string, unknown>) => ({ id: "r1" }));
    await tool("memory_reasoning", { createReasoning }).handler({
      action: "create",
      question: "q",
      chain: [{ step: 1, reasoning: "r" }],
      conclusion: "c",
      sensitivity: "restricted",
    });
    expect(createReasoning.mock.calls[0]![0]).toMatchObject({ sensitivity: "restricted" });
  });

  // APP-013: /reasoning/record stores the tier now (server 17088ebe); refusing
  // it would make record the one write path that cannot classify a chain.
  it("memory_reasoning record forwards sensitivity", async () => {
    const recordReasoning = vi.fn(async (_body: Record<string, unknown>) => ({ id: "r1" }));
    const res = await tool("memory_reasoning", { recordReasoning }).handler({
      action: "record",
      question: "q",
      chain: [{ step: 1, reasoning: "r" }],
      conclusion: "c",
      sensitivity: "restricted",
    });
    expect(res.isError).toBeUndefined();
    expect(recordReasoning.mock.calls[0]![0]).toMatchObject({ sensitivity: "restricted" });
    expect(field("memory_reasoning", "sensitivity").description).toMatch(/record/);
    expect(field("memory_reasoning", "sensitivity").description).not.toMatch(
      /record and patch refuse/
    );
  });

  it.each([
    ["memory_task", "sensitivity"],
    ["memory_strategy", "sensitivity"],
    ["memory_strategy", "scopeRef"],
    ["memory_workflow", "sensitivity"],
    ["memory_entity", "sensitivity"],
    ["memory_reasoning", "sensitivity"],
  ])("%s.%s says it applies on create", (name, key) => {
    expect(field(name, key).description).toMatch(/create/);
  });
});

describe("APP-063: per-action required fields are stated", () => {
  it("memory_task names assignedTo for create", () => {
    expect(field("memory_task", "action").description).toMatch(/create[^.;]*assignedTo/);
  });
  it("memory_event names description and source for create", () => {
    const text = field("memory_event", "action").description!;
    expect(text).toMatch(/create[^|]*description/);
    expect(text).toMatch(/create[^|]*source/);
  });
});

describe("APP-014: collapse gets its own long budget", () => {
  it.each([
    ["memory_episode_end", { sessionId: "s1" }],
    ["memory_session", { action: "collapse", sessionId: "s1" }],
  ])("%s collapses through a 120 s client", async (name, args) => {
    const collapseSession = vi.fn(async () => ({
      accepted: true,
      sessionId: "s1",
      status: "completed",
    }));
    const slow = { collapseSession };
    const withTimeout = vi.fn(() => slow);
    const res = await tool(name, { withTimeout, collapseSession: vi.fn() }).handler(args);
    expect(res.isError).toBeFalsy();
    expect(withTimeout).toHaveBeenCalledWith(120_000);
    expect(collapseSession).toHaveBeenCalledTimes(1);
  });
});

describe("APP-023: an uncertain write says so", () => {
  it("tells the caller a timed-out write may have applied", () => {
    const err = Object.assign(new MnemosyneTimeoutError(15_000), { outcomeUnknown: true });
    const text = formatMcpError("memory_remember", err).content[0]!.text;
    expect(text).toContain("15000ms");
    expect(text).toMatch(/may have been applied/);
  });
  it("says it for a 5xx write too, and not for a read", () => {
    const write = Object.assign(new MnemosyneAPIError({ status: 502, message: "bad gateway" }), {
      outcomeUnknown: true,
    });
    expect(formatMcpError("memory_task", write).content[0]!.text).toMatch(/may have been applied/);
    const read = new MnemosyneAPIError({ status: 502, message: "bad gateway" });
    expect(formatMcpError("memory_recall", read).content[0]!.text).not.toMatch(
      /may have been applied/
    );
  });
});

describe("APP-014: memory_episode_end reports failed and pending honestly", () => {
  const slowClient = (status: string) => {
    const slow = {
      collapseSession: vi.fn(async () => ({ accepted: true, sessionId: "s1", status })),
    };
    return { withTimeout: () => slow };
  };
  it("a failed extraction is an error", async () => {
    const res = await tool("memory_episode_end", slowClient("failed")).handler({ sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("status: failed");
    expect(res.content[0]!.text).not.toMatch(/skipped|ended and collapsed/);
    expect(res.structuredContent).toMatchObject({ sessionId: "s1", status: "failed" });
  });
  it("collapse_pending has its own message pointing at memory_session get", async () => {
    const res = await tool("memory_episode_end", slowClient("collapse_pending")).handler({
      sessionId: "s1",
    });
    expect(res.isError).toBe(false);
    expect(res.content[0]!.text).toContain("collapse_pending");
    expect(res.content[0]!.text).toContain("memory_session");
    expect(res.content[0]!.text).not.toMatch(/did NOT extract/);
  });
});

describe("annotations on every tool", () => {
  it("all 37 declare the four hints", () => {
    const tools = registerWith();
    expect([...tools.keys()]).toEqual(EXPECTED_TOOL_NAMES);
    for (const [name, { config }] of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof config.annotations?.[hint], `${name}.${hint}`).toBe("boolean");
      }
    }
  });
  it("multi-action tools carry their most dangerous action", () => {
    const tools = registerWith();
    for (const name of [
      "memory_task",
      "memory_session",
      "memory_workspace",
      "memory_self_edit",
      "memory_judge",
    ]) {
      expect(tools.get(name)!.config.annotations, name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
    expect(tools.get("memory_fact")!.config.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe("APP-062: a repeated forget succeeds and says so", () => {
  const notFound = () => new MnemosyneAPIError({ status: 404, message: "not found" });

  it("reports the server's alreadyForgotten for a non-fact kind", async () => {
    const forgetPrimitive = vi.fn(async () => ({ forgotten: true, alreadyForgotten: true }));
    const res = await tool("memory_forget", { forgetPrimitive }).handler({
      kind: "strategy",
      primitiveId: "s1",
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({
      id: "s1",
      forgotten: true,
      alreadyForgotten: true,
    });
    expect(res.content[0]!.text).toMatch(/already forgotten/i);
  });

  it("a fact closed before this call is already forgotten, not a 404", async () => {
    const forgetFact = vi.fn(async () => {
      throw notFound();
    });
    const getFact = vi.fn(async () => ({ id: "f1", validTo: "2026-11-22T00:00:00.000Z" }));
    const res = await tool("memory_forget", { forgetFact, getFact }).handler({ factId: "f1" });
    expect(getFact).toHaveBeenCalledWith("f1", undefined, { includeClosed: true });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({
      id: "f1",
      forgotten: true,
      alreadyForgotten: true,
    });
    expect(res.content[0]!.text).toMatch(/already forgotten/i);
  });

  it("a fact that does not exist (or is hidden) is still a 404", async () => {
    const forgetFact = vi.fn(async () => {
      throw notFound();
    });
    const getFact = vi.fn(async () => {
      throw notFound();
    });
    const res = await tool("memory_forget", { forgetFact, getFact }).handler({ factId: "f1" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("404");
  });

  it("a first forget says nothing about a repeat", async () => {
    const forgetFact = vi.fn(async () => undefined);
    const res = await tool("memory_forget", { forgetFact }).handler({ factId: "f1" });
    expect(res.structuredContent).not.toHaveProperty("alreadyForgotten");
    expect(res.content[0]!.text).not.toMatch(/already/i);
  });

  it("stays annotated idempotent", () => {
    expect(tool("memory_forget").config.annotations).toMatchObject({ idempotentHint: true });
  });
});

describe("memory_purge closed needs confirm", () => {
  it("refuses a bulk purge without confirm: true", async () => {
    const purgeClosedFacts = vi.fn(async () => ({ deleted: 3 }));
    const res = await tool("memory_purge", { purgeClosedFacts }).handler({ action: "closed" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("confirm");
    expect(purgeClosedFacts).not.toHaveBeenCalled();
  });
  it("runs it with confirm: true", async () => {
    const purgeClosedFacts = vi.fn(async () => ({ deleted: 3 }));
    const res = await tool("memory_purge", { purgeClosedFacts }).handler({
      action: "closed",
      confirm: true,
    });
    expect(res.isError).toBeUndefined();
    expect(purgeClosedFacts).toHaveBeenCalledTimes(1);
  });
});

describe("memory_doctor 403 names the missing scope", () => {
  it("says the key lacks memory:admin", async () => {
    const doctor = vi.fn(async () => {
      throw new MnemosyneAPIError({ status: 403, message: "forbidden" });
    });
    const res = await tool("memory_doctor", { doctor }).handler({});
    expect(res.content[0]!.text).toContain("memory:admin");
  });
  it("its description mentions memory:admin", () => {
    const server = new McpServer({ name: "d", version: "0" });
    const descriptions = new Map<string, string>();
    const original = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, cb) => {
      descriptions.set(name, (config as { description?: string }).description ?? "");
      return original(name, config, cb);
    });
    registerAllTools(server, {} as MnemosyneClient);
    expect(descriptions.get("memory_doctor")).toContain("memory:admin");
  });
});

describe("APP-018: a session turn takes no turnId or metadata", () => {
  it.each([{ turnId: "t-1" }, { metadata: { k: "v" } }])(
    "turn with %j is refused before anything is sent",
    async (extra) => {
      const appendTurn = vi.fn(async () => undefined);
      const res = await tool("memory_session", { appendTurn }).handler({
        action: "turn",
        sessionId: "s1",
        content: "hello",
        ...extra,
      });
      expect(res.isError).toBe(true);
      expect(appendTurn).not.toHaveBeenCalled();
      expect(res.content[0]!.text).toMatch(/turnId|metadata/);
    }
  );

  it("a plain turn still goes through", async () => {
    const appendTurn = vi.fn(async () => undefined);
    const res = await tool("memory_session", { appendTurn }).handler({
      action: "turn",
      sessionId: "s1",
      content: "hello",
    });
    expect(res.isError).toBeUndefined();
    expect(appendTurn).toHaveBeenCalledWith("s1", { role: "user", content: "hello" });
  });
});
