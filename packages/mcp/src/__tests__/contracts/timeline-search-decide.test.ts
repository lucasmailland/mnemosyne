/**
 * Contract tests for `memory_timeline`, `memory_search` and `memory_decide`
 * (tool-promise-remediation phases 3–16), covering
 * `docs/archive/openspec/tool-promise-remediation/tools/memory_{timeline,search,decide}.md`.
 *
 * Grouped because all three are thin forwarders whose promise lives entirely in
 * WHAT REACHES THE SERVER — a default that silently changes, a field that gets
 * dropped on the way, a range that is quietly clamped instead of refused. One
 * file per tool would be three near-identical harnesses.
 *
 * What each one is really being asked:
 *
 * `memory_timeline` — the audit asks whether the limit CLAMPS or REJECTS. The
 * description says "valores fuera de rango son rechazados, no recortados", and
 * the difference matters to a caller: a clamped 500 returns 100 rows that look
 * like the whole answer, while a rejected 500 tells you to ask again. Also
 * whether the documented default of 20 is real, since the server has its own
 * default and an omitted field would silently inherit it.
 *
 * `memory_search` — the audit's scenarios are about ranking, which is a
 * server-side claim. What IS checkable here, and is the part with a history, is
 * that the tool does NOT force `mode`/`vectorWeight`. That omission is
 * deliberate and load-bearing: strict `"semantic"` THROWS when no embedder is
 * available, which would break the FTS-fallback promise the description makes.
 * A well-meaning "let's be explicit" edit adding `mode: "semantic"` would turn
 * a documented graceful degradation into an error, and nothing else would
 * catch it.
 *
 * `memory_decide` — every documented field must round-trip, and the optional
 * ones must be OMITTED rather than sent as `undefined` when absent.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerTimeline } from "../../tools/timeline.js";
import { registerSearch } from "../../tools/search.js";
import { registerDecide } from "../../tools/decide.js";
import { registeredDescription } from "./registered-description.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type Handler = (a: Record<string, unknown>) => Promise<ToolResult>;

function capture(
  register: (s: McpServer, c: MnemosyneClient) => void,
  toolName: string,
  client: Record<string, unknown>
): { call: Handler; description: string; schema: Record<string, unknown> } {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  let handler: Handler | undefined;
  let description = "";
  let schema: Record<string, unknown> = {};
  const orig = server.registerTool.bind(server);
  vi.spyOn(server.registerTool as never, "call" as never);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, config: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === toolName) {
        handler = cb as Handler;
        description = (config as { description?: string }).description ?? "";
        schema = ((config as { inputSchema?: Record<string, unknown> }).inputSchema ??
          {}) as Record<string, unknown>;
      }
      return orig(name, config as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  register(server, client as unknown as MnemosyneClient);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return { call: handler, description: registeredDescription(toolName), schema };
}

describe("memory_timeline — contract", () => {
  it("sends the documented default of 20 when limit is omitted", async () => {
    // Not `undefined`: the server has its own default, and letting it apply
    // would make the description's "Default 20" a claim about someone else's
    // code that could drift without this tool changing at all.
    const timeline = vi.fn<(q: Record<string, unknown>) => Promise<unknown>>(async () => ({
      events: [],
    }));
    const { call } = capture(registerTimeline, "memory_timeline", { timeline });

    await call({});

    expect(timeline).toHaveBeenCalledWith({ limit: 20 });
  });

  it("forwards an explicit limit unchanged", async () => {
    const timeline = vi.fn<(q: Record<string, unknown>) => Promise<unknown>>(async () => ({
      events: [],
    }));
    const { call } = capture(registerTimeline, "memory_timeline", { timeline });

    await call({ limit: 100 });

    expect(timeline).toHaveBeenCalledWith({ limit: 100 });
  });

  it("REJECTS an out-of-range limit at the schema, rather than clamping it", () => {
    // The audit's question, and the description's explicit promise: "valores
    // fuera de rango son rechazados, no recortados". A clamped 500 comes back
    // as 100 rows that look like the entire answer; a rejected 500 tells the
    // caller to ask a different question. Asserted on the schema because that
    // is where the refusal happens — before the handler ever runs.
    const { schema } = capture(registerTimeline, "memory_timeline", { timeline: vi.fn() });
    const limit = schema.limit as { safeParse: (v: unknown) => { success: boolean } };

    expect(limit.safeParse(500).success).toBe(false);
    expect(limit.safeParse(0).success).toBe(false);
    expect(limit.safeParse(100).success).toBe(true);
    expect(limit.safeParse(1).success).toBe(true);
    expect(limit.safeParse(20.5).success).toBe(false);
  });

  it("maps sinceIso onto the server's `since`, and omits it entirely when absent", async () => {
    const timeline = vi.fn<(q: Record<string, unknown>) => Promise<unknown>>(async () => ({
      events: [],
    }));
    const { call } = capture(registerTimeline, "memory_timeline", { timeline });

    await call({ sinceIso: "2026-01-01T00:00:00.000Z" });
    expect(timeline).toHaveBeenCalledWith({ limit: 20, since: "2026-01-01T00:00:00.000Z" });

    timeline.mockClear();
    await call({});
    expect("since" in timeline.mock.calls[0]![0]!).toBe(false);
  });

  it("lists the event kinds the server really emits", async () => {
    // The old (never served) registrar text said `kind` is never 'created'.
    // That stopped being true with B3: GET /timeline emits a real `created`
    // event, and an unpin reads as `updated` (`unpinned` is never emitted).
    const { description } = capture(registerTimeline, "memory_timeline", { timeline: vi.fn() });
    for (const kind of ["created", "updated", "pinned", "closed", "decision_created"])
      expect(description).toContain(kind);
    expect(description).toContain("an unpin reads as updated");
    expect(description).not.toContain("unpinned");
  });
});

describe("memory_search — contract", () => {
  it("does NOT force mode or vectorWeight", async () => {
    // The load-bearing omission. Strict `"semantic"` THROWS when no embedder
    // is configured; the description promises an automatic FTS fallback. An
    // edit adding `mode: "semantic"` "for clarity" would convert a documented
    // graceful degradation into a hard error on exactly the deployments that
    // need the fallback — and every existing test would still pass.
    const recall = vi.fn<(q: Record<string, unknown>) => Promise<unknown>>(async () => ({
      memories: [],
    }));
    const { call } = capture(registerSearch, "memory_search", { recall });

    await call({ query: "cache strategy" });

    const sent = recall.mock.calls[0]![0] as Record<string, unknown>;
    expect("mode" in sent).toBe(false);
    expect("vectorWeight" in sent).toBe(false);
  });

  it("forwards the query and applies the documented default limit", async () => {
    const recall = vi.fn<(q: Record<string, unknown>) => Promise<unknown>>(async () => ({
      memories: [],
    }));
    const { call } = capture(registerSearch, "memory_search", { recall });

    await call({ query: "cache strategy" });

    const sent = recall.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.query).toBe("cache strategy");
    // `topK`, not `limit` — the MCP-facing name and the wire name differ here,
    // which is exactly the kind of rename that loses a default in transit. The
    // documented "Default 5" is applied by the tool rather than inherited from
    // the server, whose own `topK` default is 10: omitting it would silently
    // hand the caller twice what the description promises.
    expect(sent.topK).toBe(5);
    expect("limit" in sent).toBe(false);
  });

  it("rejects an empty query before calling the server", async () => {
    const { schema } = capture(registerSearch, "memory_search", { recall: vi.fn() });
    const query = schema.query as { safeParse: (v: unknown) => { success: boolean } };

    expect(query.safeParse("").success).toBe(false);
    expect(query.safeParse("x").success).toBe(true);
  });

  it("forwards scope filters only when given", async () => {
    const recall = vi.fn<(q: Record<string, unknown>) => Promise<unknown>>(async () => ({
      memories: [],
    }));
    const { call } = capture(registerSearch, "memory_search", { recall });

    await call({ query: "x", scope: "personal", scopeRef: "mnemosyne" });
    let sent = recall.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.scope).toBe("personal");
    expect(sent.scopeRef).toBe("mnemosyne");

    recall.mockClear();
    await call({ query: "x" });
    sent = recall.mock.calls[0]![0] as Record<string, unknown>;
    // Present-but-undefined can serialize to null and be read as an explicit
    // "no scope" filter rather than "no filter".
    expect("scope" in sent).toBe(false);
    expect("scopeRef" in sent).toBe(false);
  });

  it("discloses that the score is not raw cosine, and that FTS may be what ran", async () => {
    const { description } = capture(registerSearch, "memory_search", { recall: vi.fn() });
    expect(description).toMatch(/not raw cosine/i);
    expect(registeredDescription("memory_search", "es-419")).toMatch(/no es (el )?coseno/i);
    expect(description).toContain("debug.searchMode");
  });
});

describe("memory_decide — contract", () => {
  const FULL = {
    kind: "architecture",
    title: "Use Valkey for the cache",
    body: "Redis changed its licence; Valkey is the drop-in fork.",
    topicKey: "infra/cache",
    conversationId: "conv_1",
    scopeRef: "mnemosyne",
    sensitivity: "internal",
  };

  it("round-trips every documented field", async () => {
    const createDecision = vi.fn<
      (i: Record<string, unknown>, s?: unknown, k?: string) => Promise<unknown>
    >(async () => ({ id: "dec_1" }));
    const { call } = capture(registerDecide, "memory_decide", { createDecision });

    await call({ ...FULL, idempotencyKey: "idem_1" });

    expect(createDecision).toHaveBeenCalledWith(FULL, undefined, "idem_1");
  });

  it("omits every optional field that was not supplied", async () => {
    // The audit's round-trip scenario has a second half: a field the caller
    // did not set must not arrive as `undefined`. `topicKey: undefined` on the
    // wire is not the same as no topicKey — the first can defeat the very
    // upsert the field exists for.
    const createDecision = vi.fn<
      (i: Record<string, unknown>, s?: unknown, k?: string) => Promise<unknown>
    >(async () => ({ id: "dec_1" }));
    const { call } = capture(registerDecide, "memory_decide", { createDecision });

    await call({ kind: "decision", title: "t", body: "b" });

    const sent = createDecision.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toEqual({ kind: "decision", title: "t", body: "b" });
    for (const k of ["topicKey", "conversationId", "scopeRef", "sensitivity"]) {
      expect(k in sent, `${k} leaked as undefined`).toBe(false);
    }
  });

  it("carries topicKey through, which is what makes the call idempotent", async () => {
    // `mergeDecisionByTopicKey` is keyed on it server-side. Dropping it here
    // turns a correction into a duplicate, silently.
    const createDecision = vi.fn<
      (i: Record<string, unknown>, s?: unknown, k?: string) => Promise<unknown>
    >(async () => ({ id: "dec_1" }));
    const { call } = capture(registerDecide, "memory_decide", { createDecision });

    await call({ kind: "decision", title: "t", body: "b", topicKey: "infra/cache" });

    expect((createDecision.mock.calls[0]![0] as Record<string, unknown>).topicKey).toBe(
      "infra/cache"
    );
  });

  it("forwards targetWorkspaceId for a cross-workspace write", async () => {
    const createDecision = vi.fn<
      (i: Record<string, unknown>, s?: unknown, k?: string) => Promise<unknown>
    >(async () => ({ id: "dec_1" }));
    const { call } = capture(registerDecide, "memory_decide", { createDecision });

    await call({
      kind: "decision",
      title: "t",
      body: "b",
      targetWorkspaceId: "00000000-0000-4000-8000-000000000001",
    });

    expect((createDecision.mock.calls[0]![0] as Record<string, unknown>).targetWorkspaceId).toBe(
      "00000000-0000-4000-8000-000000000001"
    );
  });

  it("surfaces a client failure as a tool error", async () => {
    const { call } = capture(registerDecide, "memory_decide", {
      createDecision: vi.fn(async () => {
        throw new Error("403 insufficient scope");
      }),
    });

    const res = await call({ kind: "decision", title: "t", body: "b" });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("403 insufficient scope");
  });
});
