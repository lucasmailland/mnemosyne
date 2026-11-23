import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOL_COUNT, registerAllTools } from "../registry.js";
import { EXPECTED_TOOL_NAMES } from "./tool-names.js";

// Cast a partial stub into MnemosyneClient for tests
function makeClientStub(partial: unknown): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

// Spy on registerTool to capture the handler (3rd arg).
// server.registerTool() returns a RegisteredTool, NOT the handler —
// we must intercept the call to get the handler.
function registerAndCapture(
  name: string,
  fn: (server: McpServer) => void
): { handler: (args: Record<string, unknown>) => Promise<unknown> } {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      if (toolName === name) handler = cb;
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  fn(server);
  if (!handler) throw new Error(`tool ${name} was not registered`);
  return { handler };
}

// ---------------------------------------------------------------------------
// B1: memory_task
// ---------------------------------------------------------------------------
import { registerTask } from "../tools/task.js";

describe("memory_task", () => {
  it("create action calls client.createTask", async () => {
    const created = { id: "t-1", title: "Ship Wave B" };
    const client = makeClientStub({
      createTask: vi.fn(async () => created),
    });
    const { handler } = registerAndCapture("memory_task", (s) => registerTask(s, client));
    const out = await handler({ action: "create", title: "Ship Wave B", assignedTo: "agent-1" });
    expect(
      (client as unknown as { createTask: ReturnType<typeof vi.fn> }).createTask
    ).toHaveBeenCalledOnce();
    expect((out as { structuredContent: { id: string } }).structuredContent).toMatchObject({
      id: "t-1",
    });
  });

  it("list action calls client.listTasks with filters", async () => {
    const client = makeClientStub({
      listTasks: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 25, hasMore: false })),
    });
    const { handler } = registerAndCapture("memory_task", (s) => registerTask(s, client));
    await handler({ action: "list", status: "pending", limit: 25 });
    expect(
      (client as unknown as { listTasks: ReturnType<typeof vi.fn> }).listTasks
    ).toHaveBeenCalledWith({
      status: "pending",
      limit: 25,
    });
  });
});

// ---------------------------------------------------------------------------
// B2: memory_event
// ---------------------------------------------------------------------------
import { registerEvent } from "../tools/event.js";

describe("memory_event", () => {
  it("create action calls client.createEvent", async () => {
    const client = makeClientStub({
      createEvent: vi.fn(async () => ({ id: "e-1" })),
    });
    const { handler } = registerAndCapture("memory_event", (s) => registerEvent(s, client));
    await handler({
      action: "create",
      type: "user",
      name: "shipped-b2",
      description: "ok",
      occurredAt: "2026-06-14T00:00:00.000Z",
      source: "test",
    });
    expect(
      (client as unknown as { createEvent: ReturnType<typeof vi.fn> }).createEvent
    ).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// B3: memory_reasoning
// ---------------------------------------------------------------------------
import { registerReasoning } from "../tools/reasoning.js";

describe("memory_reasoning", () => {
  it("create action calls client.createReasoning", async () => {
    const client = makeClientStub({
      createReasoning: vi.fn(async () => ({ id: "r-1" })),
    });
    const { handler } = registerAndCapture("memory_reasoning", (s) => registerReasoning(s, client));
    await handler({
      action: "create",
      question: "Why ship B3?",
      chain: [{ step: 1, reasoning: "Tools matter" }],
      conclusion: "Ship it",
    });
    expect(
      (client as unknown as { createReasoning: ReturnType<typeof vi.fn> }).createReasoning
    ).toHaveBeenCalledOnce();
  });

  it("resolve action calls client.resolveReasoning", async () => {
    const client = makeClientStub({
      resolveReasoning: vi.fn(async () => ({
        action: "hit",
        reasoning_id: "r-9",
        suggested_model: "haiku",
      })),
    });
    const { handler } = registerAndCapture("memory_reasoning", (s) => registerReasoning(s, client));
    const out = await handler({ action: "resolve", query: "Why X?" });
    expect(
      (client as unknown as { resolveReasoning: ReturnType<typeof vi.fn> }).resolveReasoning
    ).toHaveBeenCalledOnce();
    expect((out as { structuredContent: { action: string } }).structuredContent).toMatchObject({
      action: "hit",
    });
  });

  it("resolve without query returns isError", async () => {
    const client = makeClientStub({});
    const { handler } = registerAndCapture("memory_reasoning", (s) => registerReasoning(s, client));
    const out = await handler({ action: "resolve" });
    expect((out as { isError: boolean }).isError).toBe(true);
  });

  it("record action calls client.recordReasoning", async () => {
    const client = makeClientStub({
      recordReasoning: vi.fn(async () => ({ id: "r-2" })),
    });
    const { handler } = registerAndCapture("memory_reasoning", (s) => registerReasoning(s, client));
    await handler({
      action: "record",
      question: "Q",
      chain: [{ step: 1, reasoning: "r" }],
      conclusion: "c",
      outcome: "success",
    });
    expect(
      (client as unknown as { recordReasoning: ReturnType<typeof vi.fn> }).recordReasoning
    ).toHaveBeenCalledOnce();
  });

  it("feedback action calls client.reasoningFeedback", async () => {
    const client = makeClientStub({
      reasoningFeedback: vi.fn(async () => ({ id: "r-2" })),
    });
    const { handler } = registerAndCapture("memory_reasoning", (s) => registerReasoning(s, client));
    await handler({ action: "feedback", reasoningId: "r-2", outcome: "success" });
    expect(
      (client as unknown as { reasoningFeedback: ReturnType<typeof vi.fn> }).reasoningFeedback
    ).toHaveBeenCalledWith({ reasoning_id: "r-2", outcome: "success" });
  });
});

// ---------------------------------------------------------------------------
// B4: memory_strategy
// ---------------------------------------------------------------------------
import { registerStrategy } from "../tools/strategy.js";

describe("memory_strategy", () => {
  it("create op calls client.createStrategy", async () => {
    const client = makeClientStub({
      createStrategy: vi.fn(async () => ({ id: "strat-1", trigger: "X", action: "Y" })),
    });
    const { handler } = registerAndCapture("memory_strategy", (s) => registerStrategy(s, client));
    await handler({ op: "create", trigger: "X fails", action: "Retry with Y" });
    expect(
      (client as unknown as { createStrategy: ReturnType<typeof vi.fn> }).createStrategy
    ).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// B5: memory_self_edit
// ---------------------------------------------------------------------------
import { registerSelfEdit } from "../tools/self_edit.js";
import { MnemosyneAPIError } from "@mnemo-ai/client-ts";
import { registerSession } from "../tools/session.js";
import { registerConsolidate } from "../tools/consolidate.js";
import { registerUpdate } from "../tools/update.js";
import { registerJudge } from "../tools/judge.js";

describe("memory_self_edit", () => {
  // Updated tests to match current self_edit.ts interface (client.selfEdit()).
  // The old interface (getFact + patchFact) was replaced by a single selfEdit call
  // that wraps the SelfEditPolicy evaluation on the server side.
  it("calls client.selfEdit with action, target, content, and reason", async () => {
    const selfEditResult = {
      applied: true,
      action: "replace",
      target: "f-1",
      targetKind: "fact",
      replacementId: "f-2",
    };
    const client = makeClientStub({
      selfEdit: vi.fn(async () => selfEditResult),
    });
    const { handler } = registerAndCapture("memory_self_edit", (s) => registerSelfEdit(s, client));
    const out = await handler({
      action: "replace",
      target: "f-1",
      content: "Corrected statement",
      reason: "wrong",
    });
    const selfEditMock = (client as unknown as { selfEdit: ReturnType<typeof vi.fn> }).selfEdit;
    expect(selfEditMock).toHaveBeenCalledOnce();
    const [body] = selfEditMock.mock.calls[0] as [
      { action: string; target: string; content: string; reason: string },
    ];
    expect(body.action).toBe("replace");
    expect(body.target).toBe("f-1");
    expect(body.reason).toBe("wrong");
    expect((out as { structuredContent: unknown }).structuredContent).toEqual(selfEditResult);
    expect(
      (out as { structuredContent: { replacementId: string } }).structuredContent.replacementId
    ).toBe("f-2");
  });

  it("returns isError on client.selfEdit failure", async () => {
    const client = makeClientStub({
      selfEdit: vi.fn(async () => {
        throw new MnemosyneAPIError({ status: 404, message: "not found" });
      }),
    });
    const { handler } = registerAndCapture("memory_self_edit", (s) => registerSelfEdit(s, client));
    const result = await handler({
      action: "replace",
      target: "missing",
      content: "x",
      reason: "y",
    });
    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { content: { text: string }[] }).content[0]?.text).toContain(
      "memory_self_edit failed"
    );
    expect((result as { content: { text: string }[] }).content[0]?.text).toContain("not found");
  });

  // WP-5 (PRIM-6): a self-edit budget belongs to the session a request names;
  // without one the edit draws from the credential's sessionless budget (5/24 h).
  it("forwards sessionId so the edit draws from that session's budget", async () => {
    const client = makeClientStub({ selfEdit: vi.fn(async () => ({ applied: true })) });
    const { handler } = registerAndCapture("memory_self_edit", (s) => registerSelfEdit(s, client));
    await handler({
      action: "append",
      target: "f-1",
      content: "more",
      reason: "r",
      sessionId: "sess-9",
    });
    const selfEditMock = (client as unknown as { selfEdit: ReturnType<typeof vi.fn> }).selfEdit;
    const [body] = selfEditMock.mock.calls[0] as [{ sessionId?: string }];
    expect(body.sessionId).toBe("sess-9");
  });

  it("sends no sessionId when none is given", async () => {
    const client = makeClientStub({ selfEdit: vi.fn(async () => ({ applied: true })) });
    const { handler } = registerAndCapture("memory_self_edit", (s) => registerSelfEdit(s, client));
    await handler({ action: "strengthen", target: "f-1", reason: "r" });
    const selfEditMock = (client as unknown as { selfEdit: ReturnType<typeof vi.fn> }).selfEdit;
    const [body] = selfEditMock.mock.calls[0] as [Record<string, unknown>];
    expect("sessionId" in body).toBe(false);
  });
});

describe("memory_consolidate", () => {
  it("reports no merge-eligible clusters when inspected candidates produce no outcomes", async () => {
    const client = makeClientStub({
      triggerConsolidation: vi.fn(async () => ({
        mode: "fast" as const,
        dryRun: false as const,
        candidatesProcessed: 4,
        mergedPairs: 0,
        skippedPairs: 0,
        errors: 0,
        tookMs: 3,
      })),
    });
    const { handler } = registerAndCapture("memory_consolidate", (s) =>
      registerConsolidate(s, client)
    );

    const result = (await handler({ mode: "fast", dryRun: false })) as {
      content: Array<{ type: "text"; text: string }>;
    };

    expect(result.content[0]?.text).toContain(
      "No merge-eligible clusters were found among the inspected candidates in this bounded pass."
    );
    expect(result.content[0]?.text).not.toContain(
      "No eligible candidates were found in the current bounded pass."
    );
  });

  it("describes an empty fast pass without claiming the graph is already compact", async () => {
    const client = makeClientStub({
      triggerConsolidation: vi.fn(async () => ({
        mode: "fast" as const,
        dryRun: false as const,
        candidatesProcessed: 0,
        mergedPairs: 0,
        skippedPairs: 0,
        errors: 0,
        tookMs: 3,
      })),
    });
    const { handler } = registerAndCapture("memory_consolidate", (s) =>
      registerConsolidate(s, client)
    );

    const result = (await handler({ mode: "fast", dryRun: false })) as {
      content: Array<{ type: "text"; text: string }>;
    };

    expect(result.content[0]?.text).toContain(
      "No eligible candidates were found in the current bounded pass."
    );
    expect(result.content[0]?.text).not.toContain("the graph is already compact");
  });

  it("surfaces API status and code without misleading installation advice", async () => {
    const client = makeClientStub({
      triggerConsolidation: vi.fn(async () => {
        throw new MnemosyneAPIError({
          status: 422,
          code: "dry_run_not_supported",
          message: "Consolidation dry-run is not supported yet; no changes were made.",
        });
      }),
    });
    const { handler } = registerAndCapture("memory_consolidate", (s) =>
      registerConsolidate(s, client)
    );

    const result = (await handler({ mode: "fast", dryRun: true })) as {
      isError: boolean;
      content: Array<{ type: "text"; text: string }>;
      structuredContent?: unknown;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("HTTP 422");
    expect(result.content[0]?.text).toContain("dry_run_not_supported");
    expect(result.content[0]?.text).not.toContain("Ensure @mnemo-ai/consolidation is installed");
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("recommends installing consolidation only when that service is unavailable", async () => {
    const client = makeClientStub({
      triggerConsolidation: vi.fn(async () => {
        throw new MnemosyneAPIError({
          status: 503,
          code: "consolidation_unavailable",
          message: "Consolidation service is unavailable.",
        });
      }),
    });
    const { handler } = registerAndCapture("memory_consolidate", (s) =>
      registerConsolidate(s, client)
    );

    const result = (await handler({})) as {
      content: Array<{ type: "text"; text: string }>;
    };

    expect(result.content[0]?.text).toContain("HTTP 503");
    expect(result.content[0]?.text).toContain("consolidation_unavailable");
    expect(result.content[0]?.text).toContain("Ensure @mnemo-ai/consolidation is installed");
  });

  it("recommends wiring postgres only when storage is unavailable", async () => {
    const client = makeClientStub({
      triggerConsolidation: vi.fn(async () => {
        throw new MnemosyneAPIError({
          status: 503,
          code: "storage_unavailable",
          message: "Storage service is unavailable.",
        });
      }),
    });
    const { handler } = registerAndCapture("memory_consolidate", (s) =>
      registerConsolidate(s, client)
    );

    const result = (await handler({})) as {
      content: Array<{ type: "text"; text: string }>;
    };

    expect(result.content[0]?.text).toContain("HTTP 503");
    expect(result.content[0]?.text).toContain("storage_unavailable");
    expect(result.content[0]?.text).toContain("@mnemo-ai/adapter-postgres");
    expect(result.content[0]?.text).not.toContain("Ensure @mnemo-ai/consolidation is installed");
  });

  it("does not add installation guidance for other 503 errors", async () => {
    const client = makeClientStub({
      triggerConsolidation: vi.fn(async () => {
        throw new MnemosyneAPIError({
          status: 503,
          code: "maintenance",
          message: "Server maintenance is in progress.",
        });
      }),
    });
    const { handler } = registerAndCapture("memory_consolidate", (s) =>
      registerConsolidate(s, client)
    );

    const result = (await handler({})) as {
      content: Array<{ type: "text"; text: string }>;
    };

    expect(result.content[0]?.text).toContain("HTTP 503");
    expect(result.content[0]?.text).toContain("maintenance");
    expect(result.content[0]?.text).not.toContain("installed");
    expect(result.content[0]?.text).not.toContain("@mnemo-ai/adapter-postgres");
  });
});

// ---------------------------------------------------------------------------
// D1: memory_hyperedge
// ---------------------------------------------------------------------------
import { registerHyperedge } from "../tools/hyperedge.js";

describe("memory_hyperedge", () => {
  it("create with < 3 memberIds returns isError", async () => {
    const client = makeClientStub({
      createHyperedge: vi.fn(),
    });
    const { handler } = registerAndCapture("memory_hyperedge", (s) => registerHyperedge(s, client));
    const out = await handler({ action: "create", memberIds: ["a", "b"] });
    expect((out as { isError: boolean }).isError).toBe(true);
  });

  it("create with 3 memberIds calls client.createHyperedge", async () => {
    const client = makeClientStub({
      createHyperedge: vi.fn(async () => ({
        id: "h-1",
        workspaceId: "ws-1",
        memberIds: ["m1", "m2", "m3"],
        activationCount: 0,
        worth: 0.5,
        validFrom: "2026-06-15T00:00:00.000Z",
        validTo: null,
        createdAt: "2026-06-15T00:00:00.000Z",
      })),
    });
    const { handler } = registerAndCapture("memory_hyperedge", (s) => registerHyperedge(s, client));
    const out = await handler({ action: "create", memberIds: ["m1", "m2", "m3"] });
    expect(
      (client as unknown as { createHyperedge: ReturnType<typeof vi.fn> }).createHyperedge
    ).toHaveBeenCalledOnce();
    expect((out as { structuredContent: { id: string } }).structuredContent).toMatchObject({
      id: "h-1",
    });
  });

  it("list action calls client.listHyperedges with filters", async () => {
    const client = makeClientStub({
      listHyperedges: vi.fn(async () => ({
        items: [],
        total: 0,
        offset: 0,
        limit: 25,
        hasMore: false,
      })),
    });
    const { handler } = registerAndCapture("memory_hyperedge", (s) => registerHyperedge(s, client));
    await handler({ action: "list", memberIdFilter: "m1", limit: 25 });
    expect(
      (client as unknown as { listHyperedges: ReturnType<typeof vi.fn> }).listHyperedges
    ).toHaveBeenCalledWith({ memberId: "m1", limit: 25 });
  });

  it("get without id returns isError", async () => {
    const client = makeClientStub({});
    const { handler } = registerAndCapture("memory_hyperedge", (s) => registerHyperedge(s, client));
    const out = await handler({ action: "get" });
    expect((out as { isError: boolean }).isError).toBe(true);
  });

  it("archive calls client.archiveHyperedge and returns archived:true", async () => {
    const client = makeClientStub({
      archiveHyperedge: vi.fn(async () => undefined),
    });
    const { handler } = registerAndCapture("memory_hyperedge", (s) => registerHyperedge(s, client));
    const out = await handler({ action: "archive", id: "h-1" });
    expect(
      (client as unknown as { archiveHyperedge: ReturnType<typeof vi.fn> }).archiveHyperedge
    ).toHaveBeenCalledWith("h-1");
    expect((out as { structuredContent: { archived: boolean } }).structuredContent).toMatchObject({
      archived: true,
    });
  });
});

// ---------------------------------------------------------------------------
// memory_session — §24 unified session-control tool (P1-4)
// ---------------------------------------------------------------------------
import { registerSession as registerSessionTool } from "../tools/session.js";

describe("memory_session", () => {
  it("pin action calls client.pinFact", async () => {
    const client = makeClientStub({ pinFact: vi.fn(async () => ({ id: "f-1", pinned: true })) });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    const out = await handler({ action: "pin", factId: "f-1" });
    expect(
      (client as unknown as { pinFact: ReturnType<typeof vi.fn> }).pinFact
    ).toHaveBeenCalledWith("f-1", undefined, undefined);
    expect((out as { structuredContent: { id: string } }).structuredContent).toMatchObject({
      id: "f-1",
    });
  });

  it("pin with unpin:true calls client.unpinFact", async () => {
    const client = makeClientStub({ unpinFact: vi.fn(async () => ({ id: "f-2", pinned: false })) });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    await handler({ action: "pin", factId: "f-2", unpin: true });
    expect(
      (client as unknown as { unpinFact: ReturnType<typeof vi.fn> }).unpinFact
    ).toHaveBeenCalledOnce();
  });

  it("pin without factId returns isError", async () => {
    const client = makeClientStub({ pinFact: vi.fn() });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    const out = await handler({ action: "pin" });
    expect((out as { isError: boolean }).isError).toBe(true);
    expect(
      (client as unknown as { pinFact: ReturnType<typeof vi.fn> }).pinFact
    ).not.toHaveBeenCalled();
  });

  it("collapse action calls client.collapseSession with auto strategy by default", async () => {
    const client = makeClientStub({
      collapseSession: vi.fn(async () => ({ accepted: true, sessionId: "s-1" })),
      withTimeout: () => client,
    });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    await handler({ action: "collapse", sessionId: "s-1" });
    expect(
      (client as unknown as { collapseSession: ReturnType<typeof vi.fn> }).collapseSession
    ).toHaveBeenCalledWith("s-1", { strategy: "auto" }, undefined, undefined);
  });

  it("collapse with a hint switches to the explicit strategy", async () => {
    const client = makeClientStub({
      collapseSession: vi.fn(async () => ({ accepted: true, sessionId: "s-1" })),
      withTimeout: () => client,
    });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    await handler({ action: "collapse", sessionId: "s-1", collapseHint: "prioritise decisions" });
    const call = (client as unknown as { collapseSession: ReturnType<typeof vi.fn> })
      .collapseSession.mock.calls[0] as [string, { strategy: string }];
    expect(call[1].strategy).toBe("explicit");
  });

  it("collapse without sessionId returns isError", async () => {
    const client = makeClientStub({ collapseSession: vi.fn() });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    const out = await handler({ action: "collapse" });
    expect((out as { isError: boolean }).isError).toBe(true);
  });

  it("scratch calls client.updateSessionScratch with note:content and returns scratched:true", async () => {
    const client = makeClientStub({ updateSessionScratch: vi.fn(async () => undefined) });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    const out = await handler({ action: "scratch", sessionId: "s-1", content: "remember this" });
    const scratchMock = (client as unknown as { updateSessionScratch: ReturnType<typeof vi.fn> })
      .updateSessionScratch;
    expect(scratchMock).toHaveBeenCalledOnce();
    const [id, scratched] = scratchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe("s-1");
    expect(scratched).toMatchObject({ note: "remember this" });
    expect(
      (out as { structuredContent: { scratched: boolean; sessionId: string } }).structuredContent
    ).toMatchObject({ scratched: true, sessionId: "s-1" });
  });

  it("scratch without sessionId or content returns isError", async () => {
    const client = makeClientStub({ updateSessionScratch: vi.fn() });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    const out = await handler({ action: "scratch" });
    expect((out as { isError: boolean }).isError).toBe(true);
    expect(
      (client as unknown as { updateSessionScratch: ReturnType<typeof vi.fn> }).updateSessionScratch
    ).not.toHaveBeenCalled();
  });

  it("discard calls client.discardSession and returns discarded:true", async () => {
    const client = makeClientStub({ discardSession: vi.fn(async () => undefined) });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    const out = await handler({ action: "discard", sessionId: "s-1" });
    expect(
      (client as unknown as { discardSession: ReturnType<typeof vi.fn> }).discardSession
    ).toHaveBeenCalledWith("s-1");
    expect(
      (out as { structuredContent: { discarded: boolean; sessionId: string } }).structuredContent
    ).toMatchObject({ discarded: true, sessionId: "s-1" });
  });

  it("discard without sessionId returns isError", async () => {
    const client = makeClientStub({ discardSession: vi.fn() });
    const { handler } = registerAndCapture("memory_session", (s) => registerSessionTool(s, client));
    const out = await handler({ action: "discard" });
    expect((out as { isError: boolean }).isError).toBe(true);
    expect(
      (client as unknown as { discardSession: ReturnType<typeof vi.fn> }).discardSession
    ).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// memory_task — §24 domain verbs delegate + complete (P1-4)
// ---------------------------------------------------------------------------
describe("memory_task §24 verbs", () => {
  it("complete maps to patchTask status=completed and threads outcome/lessons", async () => {
    const client = makeClientStub({
      patchTask: vi.fn(async () => ({ id: "t-1", status: "completed" })),
    });
    const { handler } = registerAndCapture("memory_task", (s) => registerTask(s, client));
    await handler({
      action: "complete",
      id: "t-1",
      outcome: "shipped",
      lessonsLearned: "test earlier",
    });
    expect(
      (client as unknown as { patchTask: ReturnType<typeof vi.fn> }).patchTask
    ).toHaveBeenCalledWith("t-1", {
      status: "completed",
      outcome: "shipped",
      lessonsLearned: "test earlier",
    });
  });

  it("complete without id returns isError", async () => {
    const client = makeClientStub({ patchTask: vi.fn() });
    const { handler } = registerAndCapture("memory_task", (s) => registerTask(s, client));
    const out = await handler({ action: "complete" });
    expect((out as { isError: boolean }).isError).toBe(true);
    expect(
      (client as unknown as { patchTask: ReturnType<typeof vi.fn> }).patchTask
    ).not.toHaveBeenCalled();
  });

  it("delegate maps to delegateTask with assignedTo", async () => {
    const client = makeClientStub({
      delegateTask: vi.fn(async () => ({ id: "t-1", status: "delegated", assignedTo: "agent-2" })),
    });
    const { handler } = registerAndCapture("memory_task", (s) => registerTask(s, client));
    await handler({ action: "delegate", id: "t-1", assignedTo: "agent-2" });
    expect(
      (client as unknown as { delegateTask: ReturnType<typeof vi.fn> }).delegateTask
    ).toHaveBeenCalledWith("t-1", { assignedTo: "agent-2" });
  });

  it("delegate without assignedTo returns isError", async () => {
    const client = makeClientStub({ delegateTask: vi.fn() });
    const { handler } = registerAndCapture("memory_task", (s) => registerTask(s, client));
    const out = await handler({ action: "delegate", id: "t-1" });
    expect((out as { isError: boolean }).isError).toBe(true);
    expect(
      (client as unknown as { delegateTask: ReturnType<typeof vi.fn> }).delegateTask
    ).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// memory_strategy — §24 domain verbs store + recall + rate (P1-4)
// ---------------------------------------------------------------------------
describe("memory_strategy §24 verbs", () => {
  it("store op calls client.createStrategy (alias of create)", async () => {
    const client = makeClientStub({
      createStrategy: vi.fn(async () => ({ id: "strat-1", trigger: "X", action: "Y" })),
    });
    const { handler } = registerAndCapture("memory_strategy", (s) => registerStrategy(s, client));
    await handler({ op: "store", trigger: "X fails", action: "Retry with Y" });
    expect(
      (client as unknown as { createStrategy: ReturnType<typeof vi.fn> }).createStrategy
    ).toHaveBeenCalledOnce();
  });

  it("recall op calls client.listStrategies defaulting to status=active", async () => {
    const client = makeClientStub({
      listStrategies: vi.fn(async () => ({
        items: [],
        total: 0,
        offset: 0,
        limit: 25,
        hasMore: false,
      })),
    });
    const { handler } = registerAndCapture("memory_strategy", (s) => registerStrategy(s, client));
    await handler({ op: "recall", limit: 25 });
    expect(
      (client as unknown as { listStrategies: ReturnType<typeof vi.fn> }).listStrategies
    ).toHaveBeenCalledWith({ status: "active", limit: 25 });
  });

  it("recall respects an explicit statusFilter over the active default", async () => {
    const client = makeClientStub({
      listStrategies: vi.fn(async () => ({
        items: [],
        total: 0,
        offset: 0,
        limit: 25,
        hasMore: false,
      })),
    });
    const { handler } = registerAndCapture("memory_strategy", (s) => registerStrategy(s, client));
    await handler({ op: "recall", statusFilter: "superseded" });
    expect(
      (client as unknown as { listStrategies: ReturnType<typeof vi.fn> }).listStrategies
    ).toHaveBeenCalledWith({ status: "superseded" });
  });

  it("rate op calls client.rateStrategy and returns the updated strategy", async () => {
    const ratedStrategy = { id: "strat-1", successCount: 4, failureCount: 1, worth: 6 / 9 };
    const client = makeClientStub({ rateStrategy: vi.fn(async () => ratedStrategy) });
    const { handler } = registerAndCapture("memory_strategy", (s) => registerStrategy(s, client));
    const out = await handler({ op: "rate", id: "strat-1", outcome: "success" });
    expect((out as { isError?: boolean }).isError).toBeFalsy();
    expect(
      (client as unknown as { rateStrategy: ReturnType<typeof vi.fn> }).rateStrategy
    ).toHaveBeenCalledWith("strat-1", "success");
  });

  it("rate without outcome returns isError", async () => {
    const client = makeClientStub({});
    const { handler } = registerAndCapture("memory_strategy", (s) => registerStrategy(s, client));
    const out = await handler({ op: "rate", id: "strat-1" });
    expect((out as { isError: boolean }).isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P4-A: memory_update
// ---------------------------------------------------------------------------
describe("memory_update", () => {
  it("calls client.selfEdit with action replace, target factId, and content statement", async () => {
    const selfEditResult = {
      applied: true,
      action: "replace",
      target: "f-1",
      targetKind: "fact",
      replacementId: "f-2",
    };
    const client = makeClientStub({
      selfEdit: vi.fn(async () => selfEditResult),
    });
    const { handler } = registerAndCapture("memory_update", (s) => registerUpdate(s, client));
    const out = await handler({ factId: "f-1", statement: "Corrected statement" });
    const selfEditMock = (client as unknown as { selfEdit: ReturnType<typeof vi.fn> }).selfEdit;
    expect(selfEditMock).toHaveBeenCalledOnce();
    const [body] = selfEditMock.mock.calls[0] as [
      { action: string; target: string; content: string; reason: string },
    ];
    expect(body.action).toBe("replace");
    expect(body.target).toBe("f-1");
    expect(body.content).toBe("Corrected statement");
    expect(body.reason).toBe("Updated via memory_update");
    expect((out as { structuredContent: unknown }).structuredContent).toEqual(selfEditResult);
    expect(
      (out as { structuredContent: { replacementId: string } }).structuredContent.replacementId
    ).toBe("f-2");
  });

  it("passes an explicit reason to client.selfEdit when provided", async () => {
    const client = makeClientStub({
      selfEdit: vi.fn(async () => ({ applied: true })),
    });
    const { handler } = registerAndCapture("memory_update", (s) => registerUpdate(s, client));
    await handler({ factId: "f-2", statement: "Updated", reason: "typo fix" });
    const selfEditMock = (client as unknown as { selfEdit: ReturnType<typeof vi.fn> }).selfEdit;
    const [body] = selfEditMock.mock.calls[0] as [{ reason: string }];
    expect(body.reason).toBe("typo fix");
  });

  it("forwards sessionId to client.selfEdit (WP-5 per-session budget)", async () => {
    const client = makeClientStub({ selfEdit: vi.fn(async () => ({ applied: true })) });
    const { handler } = registerAndCapture("memory_update", (s) => registerUpdate(s, client));
    await handler({ factId: "f-3", statement: "Fixed", sessionId: "sess-4" });
    const selfEditMock = (client as unknown as { selfEdit: ReturnType<typeof vi.fn> }).selfEdit;
    const [body] = selfEditMock.mock.calls[0] as [{ sessionId?: string }];
    expect(body.sessionId).toBe("sess-4");
  });
});

// ---------------------------------------------------------------------------
// Unified tool registry
// ---------------------------------------------------------------------------
describe("MCP server tool count", () => {
  it("registers the exact ordered tool contract", () => {
    const server = new McpServer({ name: "test-count", version: "0.0.0" });
    const names: string[] = [];
    const orig = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation(
      (name: string, schema: unknown, cb: unknown) => {
        names.push(name);
        return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
      }
    );

    const stub = makeClientStub({});
    registerAllTools(server, stub);

    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    expect(names).toHaveLength(MCP_TOOL_COUNT);
  });
});

// ---------------------------------------------------------------------------
// P4-D: memory_judge
// ---------------------------------------------------------------------------

describe("memory_judge", () => {
  it("is registered when registerJudge is called", () => {
    const server = new McpServer({ name: "test-judge-reg", version: "0.0.0" });
    let registered = false;
    const orig = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation(
      (toolName: string, schema: unknown, cb: unknown) => {
        if (toolName === "memory_judge") registered = true;
        return orig(
          toolName,
          schema as Parameters<typeof orig>[1],
          cb as Parameters<typeof orig>[2]
        );
      }
    );
    registerJudge(server, makeClientStub({}));
    expect(registered).toBe(true);
  });

  it("action='list' calls client.judge and returns structured content", async () => {
    const fakePairs = {
      pairs: [
        {
          relationId: "rel-1",
          confidence: 0.9,
          factA: {
            id: "f-a",
            subject: "diet",
            statement: "user is vegan",
            worth: 1,
            validFrom: "2026-01-01T00:00:00.000Z",
            validTo: null,
          },
          factB: {
            id: "f-b",
            subject: "diet",
            statement: "user eats meat daily",
            worth: 1,
            validFrom: "2026-01-02T00:00:00.000Z",
            validTo: null,
          },
        },
      ],
    };
    const client = makeClientStub({ judge: vi.fn(async () => fakePairs) });
    const { handler } = registerAndCapture("memory_judge", (s) => registerJudge(s, client));
    const out = await handler({ action: "list" });
    expect((client as unknown as { judge: ReturnType<typeof vi.fn> }).judge).toHaveBeenCalledOnce();
    expect((out as { structuredContent: typeof fakePairs }).structuredContent).toEqual(fakePairs);
  });

  it("action='list' passes limit to client.judge", async () => {
    const client = makeClientStub({ judge: vi.fn(async () => ({ pairs: [] })) });
    const { handler } = registerAndCapture("memory_judge", (s) => registerJudge(s, client));
    await handler({ action: "list", limit: 10 });
    const judgeMock = (client as unknown as { judge: ReturnType<typeof vi.fn> }).judge;
    expect(judgeMock).toHaveBeenCalledOnce();
    const [opts] = judgeMock.mock.calls[0] as [{ limit: number }];
    expect(opts).toEqual({ limit: 10 });
  });

  it("action='resolve' without relationId returns isError", async () => {
    const client = makeClientStub({});
    const { handler } = registerAndCapture("memory_judge", (s) => registerJudge(s, client));
    const out = await handler({ action: "resolve" });
    expect((out as { isError: boolean }).isError).toBe(true);
  });

  it("action='resolve' without resolution returns isError", async () => {
    const client = makeClientStub({});
    const { handler } = registerAndCapture("memory_judge", (s) => registerJudge(s, client));
    const out = await handler({ action: "resolve", relationId: "rel-1" });
    expect((out as { isError: boolean }).isError).toBe(true);
  });

  it("action='resolve' + resolution='merge' without mergedStatement returns isError", async () => {
    const client = makeClientStub({});
    const { handler } = registerAndCapture("memory_judge", (s) => registerJudge(s, client));
    const out = await handler({ action: "resolve", relationId: "rel-1", resolution: "merge" });
    expect((out as { isError: boolean }).isError).toBe(true);
  });

  it("action='resolve' + resolution='supersede_a' calls client.resolveConflict", async () => {
    const resolveResult = {
      resolved: true,
      action: "supersede_a",
      relationId: "rel-1",
      mergedFactId: null,
    };
    const client = makeClientStub({ resolveConflict: vi.fn(async () => resolveResult) });
    const { handler } = registerAndCapture("memory_judge", (s) => registerJudge(s, client));
    const out = await handler({
      action: "resolve",
      relationId: "rel-1",
      resolution: "supersede_a",
    });
    const resolveMock = (client as unknown as { resolveConflict: ReturnType<typeof vi.fn> })
      .resolveConflict;
    expect(resolveMock).toHaveBeenCalledOnce();
    const [id, body] = resolveMock.mock.calls[0] as [string, { action: string }];
    expect(id).toBe("rel-1");
    expect(body).toEqual({ action: "supersede_a" });
    expect((out as { structuredContent: typeof resolveResult }).structuredContent).toEqual(
      resolveResult
    );
  });

  it("action='resolve' + resolution='merge' + mergedStatement calls client.resolveConflict", async () => {
    const resolveResult = {
      resolved: true,
      action: "merge",
      relationId: "rel-1",
      mergedFactId: "f-merged",
    };
    const client = makeClientStub({ resolveConflict: vi.fn(async () => resolveResult) });
    const { handler } = registerAndCapture("memory_judge", (s) => registerJudge(s, client));
    const out = await handler({
      action: "resolve",
      relationId: "rel-1",
      resolution: "merge",
      mergedStatement: "user follows a plant-based diet",
    });
    const resolveMock = (client as unknown as { resolveConflict: ReturnType<typeof vi.fn> })
      .resolveConflict;
    expect(resolveMock).toHaveBeenCalledOnce();
    const [id, body] = resolveMock.mock.calls[0] as [
      string,
      { action: string; mergedStatement: string },
    ];
    expect(id).toBe("rel-1");
    expect(body).toEqual({ action: "merge", mergedStatement: "user follows a plant-based diet" });
    expect((out as { structuredContent: typeof resolveResult }).structuredContent).toEqual(
      resolveResult
    );
  });
});

// ---------------------------------------------------------------------------
// P5-B: memory_stats
// ---------------------------------------------------------------------------
import { registerStats } from "../tools/stats.js";

describe("memory_stats", () => {
  it("calls client.getStats and returns the result", async () => {
    const statsResult = {
      workspaceId: "ws-1",
      generatedAt: "2026-06-24T00:00:00.000Z",
      facts: { live: 42, closed: 5, pinned: 3, archived: 1, withZeroHits: 7 },
      decisions: { active: 4 },
      relations: { conflicts: 0 },
      embeddings: { indexed: 40, pending: 2 },
      recall: { hitRate30d: 0.85, lastRecallAt: "2026-06-23T18:00:00.000Z" },
      lastWriteAt: "2026-06-24T00:00:00.000Z",
    };
    const client = makeClientStub({ getStats: vi.fn(async () => statsResult) });
    const { handler } = registerAndCapture("memory_stats", (s) => registerStats(s, client));
    const out = await handler({});
    expect(
      (client as unknown as { getStats: ReturnType<typeof vi.fn> }).getStats
    ).toHaveBeenCalledOnce();
    expect((out as { structuredContent: typeof statsResult }).structuredContent).toMatchObject({
      workspaceId: "ws-1",
      facts: { live: 42, pinned: 3 },
      embeddings: { indexed: 40, pending: 2 },
    });
  });
});
