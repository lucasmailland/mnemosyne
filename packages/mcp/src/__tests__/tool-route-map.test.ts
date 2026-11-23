/**
 * B1.2 — MCP tool -> HTTP route map.
 *
 * Re-uses `registry.test.ts`'s proven trick: spy `server.registerTool` to
 * capture `(name, config, handler)` for all 35 `TOOL_REGISTRARS`, then drive
 * each captured `handler` directly with a REAL `MnemosyneClient` constructed
 * with `{ fetch: recordingFetch }`. Arguments are synthesized from each
 * tool's own `inputSchema` zod shape (see `helpers/synthesize-args.ts`),
 * bypassing the MCP SDK's own request-time validation — exactly what
 * `registry.test.ts` already does when invoking handlers directly.
 *
 * Branching tools (`action`/`op`/`kind`-discriminated: `memory_self_edit`'s
 * 7 actions, `memory_entity`'s `link_user`, etc.) are keyed by
 * `(tool, action)`, not just `tool` — a per-branch guard inside the tool's
 * own handler code (e.g. "`create` requires `name` and `kind`") isn't
 * expressible in a flat zod shape, so those branches carry a small,
 * explicit `extra` fixture in `TOOL_BRANCHES` supplying just enough to
 * reach the tool's real SDK call. This is what makes the inventory
 * self-maintaining for everything else: adding a new registrar to
 * `TOOL_REGISTRARS`, or a new field to an existing schema, needs no fixture
 * at all; only a genuinely new ACTION branch does.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient as MnemosyneClientType } from "@mnemo-ai/client-ts";
import { MnemosyneClient } from "@mnemo-ai/client-ts";
import { describe, expect, it } from "vitest";
import { registerAllTools } from "../registry.js";
import { EXPECTED_TOOL_NAMES } from "./tool-names.js";
import { synthesizeShape } from "./helpers/synthesize-args.js";

interface RecordedCall {
  method: string;
  path: string;
}

const FIXED_ISO = "2024-01-01T00:00:00.000Z";

/**
 * A handful of tools process the recorded call's JSON response locally
 * BEFORE reaching their own try/catch (e.g. `memory_compare` calls
 * `.toLowerCase()` on the fetched fact's `content` unconditionally). An
 * empty `{}` body would throw before the route is even fully attributed —
 * these tiny, narrowly-scoped stubs keep every branch reachable without
 * hand-rolling a full fake server.
 */
function stubBodyFor(pathname: string, method: string): unknown {
  if (pathname === "/me") return { tenantId: "tenant_1", userId: "user_1" };
  if (pathname === "/doctor") return { status: "ok", checks: [] };
  if (method === "GET" && /^\/facts\/[^/]+$/.test(pathname)) {
    return {
      id: "fact_1",
      workspaceId: "ws_1",
      content: "x",
      attribution: {},
      tags: [],
      pinned: false,
      validFrom: FIXED_ISO,
      validTo: null,
      createdAt: FIXED_ISO,
    };
  }
  if (pathname === "/facts/compare") {
    const fact = {
      id: "fact_1",
      workspaceId: "ws_1",
      content: "x",
      attribution: {},
      tags: [],
      pinned: false,
      validFrom: FIXED_ISO,
      validTo: null,
      createdAt: FIXED_ISO,
    };
    return {
      factA: fact,
      factB: fact,
      differences: [],
      suggestedVerb: "compatible",
      sameSubject: false,
    };
  }
  return {};
}

function makeRecordingFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" || input instanceof URL ? input : input.url;
    const url = new URL(String(raw));
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname });
    const body = stubBodyFor(url.pathname, init?.method ?? "GET");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

interface Branch {
  /** Field name the tool uses to select a branch. Defaults to `"action"`. */
  discriminator?: string;
  /** The branch's discriminator value, e.g. `"create"`. */
  value: string;
  /**
   * Extra fields needed to pass the branch's own handler-level guard (not
   * expressible in the flat zod shape) — merged on top of the general
   * zod-synthesized object.
   */
  extra?: Record<string, unknown>;
}

/**
 * Only tools whose `inputSchema` has an action/op/kind-style discriminator
 * AND at least one branch with fields the general synthesizer can't infer
 * (because they're only conditionally required, per handler-side `if`
 * guards, not the zod shape) need an entry here. Every other captured tool
 * gets exactly one invocation from general zod synthesis alone.
 */
const TOOL_BRANCHES: Record<string, Branch[]> = {
  memory_entity: [
    { value: "create", extra: { name: "x", kind: "person" } },
    { value: "get", extra: { id: "entity_1" } },
    { value: "list" },
    { value: "update", extra: { id: "entity_1" } },
    { value: "linked_facts", extra: { id: "entity_1" } },
    { value: "link_user", extra: { id: "entity_1", userId: "user_1" } },
    { value: "unlink_user", extra: { id: "entity_1" } },
  ],
  memory_forget: [
    { discriminator: "kind", value: "fact", extra: { factId: "fact_1" } },
    { discriminator: "kind", value: "task", extra: { primitiveId: "task_1" } },
  ],
  memory_hyperedge: [
    { value: "create", extra: { memberIds: ["fact_1", "fact_2", "fact_3"] } },
    { value: "get", extra: { id: "hyperedge_1" } },
    { value: "list" },
    { value: "patch", extra: { id: "hyperedge_1" } },
    { value: "archive", extra: { id: "hyperedge_1" } },
  ],
  memory_reasoning: [
    {
      value: "create",
      extra: { question: "x", chain: [{ step: 0, reasoning: "x" }], conclusion: "x" },
    },
    { value: "get", extra: { id: "reasoning_1" } },
    { value: "list" },
    { value: "patch", extra: { id: "reasoning_1" } },
    { value: "archive", extra: { id: "reasoning_1" } },
    { value: "resolve", extra: { query: "x" } },
    {
      value: "record",
      extra: { question: "x", chain: [{ step: 0, reasoning: "x" }], conclusion: "x" },
    },
    { value: "feedback", extra: { reasoningId: "reasoning_1", outcome: "success" } },
  ],
  memory_task: [
    { value: "create", extra: { title: "x", assignedTo: "agent_1" } },
    { value: "get", extra: { id: "task_1" } },
    { value: "list" },
    { value: "patch", extra: { id: "task_1" } },
    { value: "archive", extra: { id: "task_1" } },
    { value: "delegate", extra: { id: "task_1", assignedTo: "agent_1" } },
    { value: "complete", extra: { id: "task_1" } },
  ],
  memory_event: [
    {
      value: "create",
      extra: {
        type: "system",
        name: "x",
        description: "x",
        occurredAt: "2024-01-01T00:00:00Z",
        source: "x",
      },
    },
    { value: "get", extra: { id: "event_1" } },
    { value: "list" },
    { value: "archive", extra: { id: "event_1" } },
    { value: "annotate", extra: { id: "event_1", author: "x", content: "x" } },
    { value: "sensitivity", extra: { id: "event_1", sensitivity: "internal" } },
  ],
  memory_remind_when: [
    { value: "create", extra: { content: "x", condition: "x" } },
    { value: "list" },
    { value: "dismiss", extra: { id: "reminder_1" } },
  ],
  memory_workflow: [
    { value: "create", extra: { name: "x", steps: [{ order: 0, action: "x" }] } },
    { value: "get", extra: { id: "workflow_1" } },
    { value: "list" },
  ],
  memory_session: [
    { value: "start" },
    { value: "turn", extra: { sessionId: "session_1", content: "x" } },
    { value: "pin_turn", extra: { sessionId: "session_1", turnId: "turn_1" } },
    { value: "pin", extra: { factId: "fact_1" } },
    { value: "scratch", extra: { sessionId: "session_1", content: "x" } },
    { value: "collapse", extra: { sessionId: "session_1" } },
    { value: "discard", extra: { sessionId: "session_1" } },
    { value: "feedback", extra: { sessionId: "session_1", rating: "up" } },
    { value: "get", extra: { sessionId: "session_1" } },
    { value: "list" },
  ],
  memory_relate: [
    {
      value: "create",
      extra: {
        sourceKind: "fact",
        from: "fact_1",
        targetKind: "fact",
        to: "fact_2",
        verb: "related",
      },
    },
    { value: "list" },
    { value: "history", extra: { sourceKind: "fact", from: "fact_1" } },
  ],
  memory_compose: [
    { value: "list" },
    { value: "create", extra: { name: "x", conditionDsl: {}, actionDsl: {} } },
    { value: "get", extra: { ruleId: "rule_1" } },
    { value: "patch", extra: { ruleId: "rule_1" } },
    { value: "dry_run", extra: { ruleId: "rule_1" } },
  ],
  memory_judge: [
    { value: "list" },
    { value: "resolve", extra: { relationId: "relation_1", resolution: "keep_both" } },
  ],
  memory_purge: [{ value: "fact", extra: { factId: "fact_1" } }, { value: "closed", extra: { confirm: true } }],
  memory_workspace: [
    { value: "list" },
    { value: "describe", extra: { workspaceId: "ws_1" } },
    { value: "members", extra: { workspaceId: "ws_1" } },
    { value: "current" },
    { value: "create", extra: { name: "x", tenantId: "tenant_1" } },
    { value: "invite", extra: { workspaceId: "ws_1", userId: "user_1" } },
    { value: "set_role", extra: { workspaceId: "ws_1", userId: "user_1", role: "read" } },
    { value: "remove", extra: { workspaceId: "ws_1", userId: "user_1" } },
  ],
  memory_strategy: [
    { discriminator: "op", value: "create", extra: { trigger: "x", action: "x" } },
    { discriminator: "op", value: "get", extra: { id: "strategy_1" } },
    { discriminator: "op", value: "list" },
    { discriminator: "op", value: "patch", extra: { id: "strategy_1" } },
    { discriminator: "op", value: "archive", extra: { id: "strategy_1" } },
    { discriminator: "op", value: "store", extra: { trigger: "x", action: "x" } },
    { discriminator: "op", value: "recall" },
    { discriminator: "op", value: "rate", extra: { id: "strategy_1", outcome: "success" } },
  ],
  memory_self_edit: [
    { value: "append", extra: { target: "profile", reason: "x" } },
    { value: "replace", extra: { target: "profile", reason: "x" } },
    { value: "strengthen", extra: { target: "profile", reason: "x" } },
    { value: "weaken", extra: { target: "profile", reason: "x" } },
    { value: "forget", extra: { target: "profile", reason: "x" } },
    { value: "reflect", extra: { target: "profile", reason: "x" } },
    { value: "link", extra: { target: "profile", reason: "x" } },
  ],
  memory_skill: [
    { value: "create", extra: { name: "x", promptTemplate: "x" } },
    { value: "get", extra: { id: "skill_1" } },
    { value: "list" },
    { value: "forget", extra: { id: "skill_1" } },
  ],
};

interface CapturedTool {
  config: { inputSchema?: Record<string, unknown> };
  handler: (...args: unknown[]) => unknown;
}

describe("MCP tool -> route map (B1.2)", () => {
  it("registers exactly the 37 expected tools, each reaching its declared route(s)", async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const client: MnemosyneClientType = new MnemosyneClient({
      url: "http://localhost:9999",
      apiKey: "mns_live_toolroutemaptestkey0001",
      fetch: fetchImpl,
    });

    const server = new McpServer({ name: "tool-route-map-test", version: "0.0.0" });
    const captured = new Map<string, CapturedTool>();
    const original = server.registerTool.bind(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool = (name: string, config: any, handler: any) => {
      captured.set(name, { config, handler });
      return original(name, config, handler);
    };

    registerAllTools(server, client);

    expect(new Set(captured.keys()).size).toBe(37); // P72 added memory_relocate
    // (was 36 after P67 added memory_fact)
    expect([...captured.keys()].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());

    const routeMap: Record<string, RecordedCall[]> = {};
    const noCallRecorded: string[] = [];

    for (const [name, tool] of captured) {
      const branches = TOOL_BRANCHES[name] ?? [null];
      for (const branch of branches) {
        const base = synthesizeShape((tool.config.inputSchema ?? {}) as never);
        const args =
          branch === null
            ? base
            : { ...base, [branch.discriminator ?? "action"]: branch.value, ...branch.extra };
        calls.length = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await tool.handler(args, {} as any);
        const key = branch === null ? name : `${name}:${branch.value}`;
        if (calls.length === 0) noCallRecorded.push(key);
        routeMap[key] = [...calls];
      }
    }

    // Every captured tool/branch is expected to reach at least one real
    // HTTP call — a silent entry means either a synthesis gap (a required
    // field the general synthesizer couldn't infer) or a handler-level
    // guard this file's TOOL_BRANCHES fixture doesn't yet satisfy.
    expect(noCallRecorded).toEqual([]);

    const sortedKeys = Object.keys(routeMap).sort();
    const sorted: Record<string, RecordedCall[]> = {};
    for (const key of sortedKeys) sorted[key] = routeMap[key]!;

    await expect(JSON.stringify(sorted, null, 2) + "\n").toMatchFileSnapshot(
      "./tool-routes.snapshot.json"
    );
  });
});
