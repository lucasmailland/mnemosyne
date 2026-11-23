/**
 * Verification follow-ups: AGENTSIM-6 (decision body reachable with just an id,
 * truncated hits say how to fetch the rest) and AGENTSIM-5 (topic key from
 * subject + attribute, never from the value).
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { registerFact } from "../../tools/fact.js";
import { registerSuggestTopicKey } from "../../tools/suggest_topic_key.js";
import { registerRemember } from "../../tools/remember.js";
import { renderMemoryHits } from "../../tools/render-memory.js";
import { registerAllTools } from "../../registry.js";
import type { z } from "zod";

const NON_FACT_KINDS = [
  "strategy",
  "workflow",
  "skill",
  "episode",
  "task",
  "event",
  "reasoning",
  "entity",
] as const;

/** Tool name → declared params (and its `kind` validator), under one profile. */
function registeredParams(
  profile: "core" | "full"
): Map<string, { params: string[]; kind?: z.ZodType }> {
  const server = new McpServer({ name: "profile", version: "0" });
  const tools = new Map<string, { params: string[]; kind?: z.ZodType }>();
  const original = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(((n: string, def: any, cb: any) => {
    const schema = (def.inputSchema ?? {}) as Record<string, z.ZodType>;
    tools.set(n, { params: Object.keys(schema), kind: schema.kind });
    return original(n, def, cb);
  }) as never);
  registerAllTools(server, {} as MnemosyneClient, undefined, profile);
  return tools;
}

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function capture(
  name: string,
  register: (s: McpServer, c: MnemosyneClient) => void,
  client: Record<string, unknown>
): { handler: Handler; schema: Record<string, unknown> } {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: Handler | undefined;
  let schema: Record<string, unknown> = {};
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(((n: string, def: any, cb: any) => {
    if (n === name) {
      handler = cb;
      schema = def.inputSchema;
    }
    return orig(n, def, cb);
  }) as never);
  register(server, client as unknown as MnemosyneClient);
  if (!handler) throw new Error("not registered");
  return { handler, schema };
}

const notFound = () => Object.assign(new Error("not found"), { status: 404 });

describe("memory_fact with just an id (AGENTSIM-6)", () => {
  it("uses the decision endpoint for a decision-prefixed id", async () => {
    const getFact = vi.fn();
    const getDecision = vi.fn(async () => ({ id: "mdec_1", content: "full body" }));
    const { handler } = capture("memory_fact", registerFact, { getFact, getDecision });
    const res = await handler({ factId: "mdec_1" });
    expect(res.isError).toBeUndefined();
    expect(getFact).not.toHaveBeenCalled();
    expect(getDecision).toHaveBeenCalledWith("mdec_1", undefined, { includeClosed: true });
  });

  // APP-019 residual: a closed decision is requested the way a closed fact is.
  it("asks for closed decisions too, by kind and on the fallback", async () => {
    const getDecision = vi.fn(async () => ({ id: "d", content: "body" }));
    const getFact = vi.fn(async () => {
      throw notFound();
    });
    const { handler } = capture("memory_fact", registerFact, { getFact, getDecision });
    await handler({ factId: "x_1", kind: "decision" });
    await handler({ factId: "x_2" });
    expect(getDecision.mock.calls).toEqual([
      ["x_1", undefined, { includeClosed: true }],
      ["x_2", undefined, { includeClosed: true }],
    ]);
  });

  // APP-019a: recall (asOf, status superseded) returns closed facts, and the
  // server answers 404 for one unless includeClosed is sent.
  it("opens a closed fact and says it is closed", async () => {
    const getFact = vi.fn(async () => ({
      id: "mfact_old",
      content: "deploys go through Fly.io",
      status: "superseded",
      validTo: "2026-03-01T00:00:00.000Z",
    }));
    const { handler } = capture("memory_fact", registerFact, { getFact, getDecision: vi.fn() });
    const res = await handler({ factId: "mfact_old" });
    expect(getFact).toHaveBeenCalledWith("mfact_old", undefined, { includeClosed: true });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("deploys go through Fly.io");
    expect(res.content[0]!.text).toMatch(/CLOSED/);
    expect(res.content[0]!.text).toContain("superseded");
    expect(res.content[0]!.text).toContain("2026-03-01T00:00:00.000Z");
  });

  it("says nothing about closure for a current fact", async () => {
    const getFact = vi.fn(async () => ({
      id: "mfact_1",
      content: "x",
      status: "active",
      validTo: null,
    }));
    const { handler } = capture("memory_fact", registerFact, { getFact, getDecision: vi.fn() });
    const res = await handler({ factId: "mfact_1" });
    expect(res.content[0]!.text).not.toMatch(/CLOSED/);
  });

  it("falls back to the decision endpoint on a fact 404 for an unknown prefix", async () => {
    const getFact = vi.fn(async () => {
      throw notFound();
    });
    const getDecision = vi.fn(async () => ({ id: "x_9", content: "full body" }));
    const { handler } = capture("memory_fact", registerFact, { getFact, getDecision });
    const res = await handler({ factId: "x_9" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("full body");
  });

  it("reports the original 404 when neither endpoint has the id", async () => {
    const getFact = vi.fn(async () => {
      throw notFound();
    });
    const getDecision = vi.fn(async () => {
      throw notFound();
    });
    const { handler } = capture("memory_fact", registerFact, { getFact, getDecision });
    const res = await handler({ factId: "x_9" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("status=404");
  });

  it("does not fall back when kind is explicit", async () => {
    const getFact = vi.fn(async () => {
      throw notFound();
    });
    const getDecision = vi.fn();
    const { handler } = capture("memory_fact", registerFact, { getFact, getDecision });
    const res = await handler({ factId: "x_9", kind: "fact" });
    expect(res.isError).toBe(true);
    expect(getDecision).not.toHaveBeenCalled();
  });

  it("does not mask non-404 errors with a decision lookup", async () => {
    const getFact = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { status: 500 });
    });
    const getDecision = vi.fn();
    const { handler } = capture("memory_fact", registerFact, { getFact, getDecision });
    const res = await handler({ factId: "x_9" });
    expect(res.isError).toBe(true);
    expect(getDecision).not.toHaveBeenCalled();
  });
});

describe("truncated hits say how to fetch the body (AGENTSIM-6)", () => {
  it("adds the exact call, with the hit's kind", () => {
    const text = renderMemoryHits(
      [
        { id: "mdec_1", kind: "decision", content: "abc", truncated: true },
        { id: "mfact_2", kind: "fact", content: "abc", truncated: true },
        { id: "mfact_3", kind: "fact", content: "short" },
      ],
      { compact: true }
    );
    expect(text).toContain('memory_fact({"factId":"mdec_1","kind":"decision"})');
    expect(text).toContain('memory_fact({"factId":"mfact_2","kind":"fact"})');
    expect(text.match(/memory_fact\(/g)).toHaveLength(2);
  });

  // APP-019b (round 2): compact recall cuts every kind at 300 chars, and the
  // default `core` profile serves none of memory_strategy/workflow/skill/...
  // Every hint names memory_fact, which is in core and opens any kind by id.
  it.each(NON_FACT_KINDS)("points a truncated %s at memory_fact with its kind", (kind) => {
    const text = renderMemoryHits([{ id: "x1", kind, content: "abc", truncated: true }], {
      compact: true,
    });
    expect(text).toContain(`memory_fact({"factId":"x1","kind":"${kind}"})`);
  });

  it.each(["core", "full"] as const)(
    "under the %s profile every hint names a served tool and parameters it declares",
    (profile) => {
      const declared = registeredParams(profile);
      for (const kind of ["fact", "decision", ...NON_FACT_KINDS]) {
        const text = renderMemoryHits([{ id: "x1", kind, content: "abc", truncated: true }], {
          compact: true,
        });
        const [, tool, args] = /via (memory_[a-z_]+)\((\{.*\})\)\)/.exec(text)!;
        expect(declared.has(tool!), `${kind} → ${tool}`).toBe(true);
        const call = JSON.parse(args!) as Record<string, unknown>;
        for (const param of Object.keys(call)) expect(declared.get(tool!)!.params).toContain(param);
        expect(declared.get(tool!)!.kind?.safeParse(call.kind).success, kind).toBe(true);
      }
    }
  );

  it("a kind no tool opens by id is sent back to recall in full", () => {
    const text = renderMemoryHits(
      [{ id: "h_1", kind: "hyperedge", content: "abc", truncated: true }],
      {
        compact: true,
      }
    );
    expect(text).toContain('projection: "full"');
    expect(text).not.toMatch(/memory_fact\(/);
  });
});

describe("memory_fact opens every recallable kind by id (APP-019b round 2)", () => {
  const GETTERS: Record<(typeof NON_FACT_KINDS)[number], string> = {
    strategy: "getStrategy",
    workflow: "getWorkflow",
    skill: "getSkill",
    episode: "getEpisode",
    task: "getTask",
    event: "getEvent",
    reasoning: "getReasoning",
    entity: "getEntity",
  };

  it.each(NON_FACT_KINDS)("kind %s reads through its own endpoint", async (kind) => {
    const getter = vi.fn(async () => ({ id: "x1", body: `full ${kind} body` }));
    const getFact = vi.fn();
    const { handler } = capture("memory_fact", registerFact, { getFact, [GETTERS[kind]]: getter });
    const res = await handler({ factId: "x1", kind });
    expect(res.isError).toBeUndefined();
    expect(getter).toHaveBeenCalledWith("x1");
    expect(getFact).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toContain(`full ${kind} body`);
  });

  it("a task's lifecycle status is not read as closure; a closed validity is", async () => {
    const getTask = vi.fn(async () => ({ id: "t1", status: "completed", validTo: null }));
    const getStrategy = vi.fn(async () => ({
      id: "s1",
      status: "archived",
      validTo: "2026-03-01T00:00:00.000Z",
    }));
    const { handler } = capture("memory_fact", registerFact, { getTask, getStrategy });
    expect((await handler({ factId: "t1", kind: "task" })).content[0]!.text).not.toMatch(/CLOSED/);
    expect((await handler({ factId: "s1", kind: "strategy" })).content[0]!.text).toMatch(/CLOSED/);
  });
});

describe("memory_suggest_topic_key attribute (AGENTSIM-5)", () => {
  it("forwards attribute and omits it when absent", async () => {
    const suggestTopicKey = vi.fn(async () => ({ topicKey: "k", levels: [], source: "x" }));
    const { handler, schema } = capture("memory_suggest_topic_key", registerSuggestTopicKey, {
      suggestTopicKey,
    });
    expect(schema).toHaveProperty("attribute");
    await handler({ subject: "payments-api", attribute: "deploy method" });
    expect(suggestTopicKey).toHaveBeenLastCalledWith({
      subject: "payments-api",
      attribute: "deploy method",
    });
    await handler({ subject: "payments-api", body: "x" });
    expect(
      (suggestTopicKey.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]![0]
    ).not.toHaveProperty("attribute");
  });

  it("gives the old and new value of one attribute the same key (derivation mirrors the server contract)", async () => {
    // The server ignores `body` when `attribute` is set; the MCP must not
    // smuggle the value in any other way. Same subject+attribute => same call.
    const calls: Array<Record<string, unknown>> = [];
    const suggestTopicKey = vi.fn(async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        topicKey: `${input.subject}/${input.attribute}`,
        levels: [],
        source: "subject+attribute",
      };
    });
    const { handler } = capture("memory_suggest_topic_key", registerSuggestTopicKey, {
      suggestTopicKey,
    });
    const a = await handler({
      subject: "payments-api",
      attribute: "deploy-method",
      body: "Fly.io",
    });
    const b = await handler({
      subject: "payments-api",
      attribute: "deploy-method",
      body: "ArgoCD",
    });
    expect(a.content[0]!.text).toBe(b.content[0]!.text);
  });
});

describe("memory_remember has no attribute input", () => {
  it("is unchanged: the server fact route does not accept attribute", () => {
    const { schema } = capture("memory_remember", registerRemember, {});
    expect(schema).not.toHaveProperty("attribute");
  });
});
