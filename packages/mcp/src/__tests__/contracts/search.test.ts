/**
 * Contract tests for the `memory_search` MCP tool
 * (packages/mcp/src/tools/search.ts).
 *
 * `memory_search`'s documented promise (see
 * docs/archive/openspec/tool-promise-remediation/tools/memory_search.md):
 *
 *   1. Pure vector/semantic ranking when an embedder is available, unlike
 *      `memory_recall`'s mixed-weight cascade.
 *   2. When the server has no `MNEMO_LLM_API_KEY`, it falls back
 *      automatically to FTS (`ts_rank` over `text_lemmatized`) instead of
 *      erroring, and the results are still useful.
 *
 * MCP-1 fix (2026-07-29): `packages/server/src/routes/recall.ts` used to
 * silently drop `vectorWeight`/`mode` before they reached the ranking
 * pipeline. Now that routing is fixed, this tool deliberately does NOT
 * force `mode: "semantic"` / `vectorWeight: 1.0` — doing so would now
 * genuinely reach `recallCold()` and throw `semantic_search_unavailable`
 * whenever no embedder is configured (B5.9: strict semantic mode has no
 * silent fallback), breaking promise (2). Omitting both fields lets the
 * default `"auto"` mode run instead, which ranks identically to strict
 * `"semantic"` when an embedder IS available and degrades to FTS instead
 * of throwing when it isn't — see:
 *   - packages/core/src/cognitive/__tests__/search-mode-fts-fallback.contract.test.ts
 *   - packages/server/src/__tests__/integration/search-recall-vectorweight-noop.integration.test.ts
 *
 * These tests verify what THIS tool's own code does (request shape sent to
 * `client.recall`, and how the response is surfaced) using a mocked
 * `MnemosyneClient` — no network/DB.
 */
import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient, RecallInput, RecallResponse } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearch } from "../../tools/search.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function registerAndCapture(recallImpl: (input: RecallInput) => Promise<RecallResponse>): {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  recall: ReturnType<typeof vi.fn<(input: RecallInput) => Promise<RecallResponse>>>;
} {
  const recall = vi.fn(recallImpl);
  const client = { recall } as unknown as MnemosyneClient;

  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<ToolResult>
    ) => {
      if (toolName === "memory_search") handler = cb;
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );

  registerSearch(server, client);
  if (!handler) throw new Error("memory_search was not registered");
  return { handler, recall };
}

describe("memory_search — request shape sent to client.recall", () => {
  it("does NOT send mode or vectorWeight (MCP-1 fix: forcing 'semantic' now that routing works would throw instead of falling back to FTS)", async () => {
    const { handler, recall } = registerAndCapture(async () => ({
      hits: [
        {
          id: "f1",
          content: "hit",
          score: 0.9,
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: null,
        },
      ],
    }));

    await handler({ query: "user color preference", limit: 3 });

    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "user color preference",
        topK: 3,
      })
    );
    const callArgs = recall.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("mode");
    expect(callArgs).not.toHaveProperty("vectorWeight");
  });

  it("defaults topK to 5 when limit is omitted", async () => {
    const { handler, recall } = registerAndCapture(async () => ({ hits: [] }));
    await handler({ query: "q" });
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ topK: 5 }));
  });

  it("forwards scope/scopeRef/actorId only when provided", async () => {
    const { handler, recall } = registerAndCapture(async () => ({ hits: [] }));
    await handler({ query: "q", scope: "personal", scopeRef: "mnemosyne", actorId: "user-1" });
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "personal", scopeRef: "mnemosyne", actorId: "user-1" })
    );

    recall.mockClear();
    await handler({ query: "q2" });
    const callArgs = recall.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("scope");
    expect(callArgs).not.toHaveProperty("scopeRef");
    expect(callArgs).not.toHaveProperty("actorId");
  });
});

describe("memory_search — FTS-fallback disclosure (Scenario 2 of the tool-promise audit)", () => {
  it("surfaces debug.searchMode:'fts' to the caller and labels the text summary as a keyword fallback, instead of silently presenting FTS results as semantic ones", async () => {
    const { handler } = registerAndCapture(async () => ({
      hits: [
        {
          id: "f1",
          content: "fts hit",
          score: 0.42,
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: null,
        },
      ],
      debug: { embedded: false, searchMode: "fts" },
    }));

    const result = await handler({ query: "no embedder configured query" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/FTS keyword fallback/i);
    expect(result.structuredContent?.debug).toEqual({ embedded: false, searchMode: "fts" });
  });

  it("does NOT error when the server falls back to FTS — it returns usable hits (proves the fallback claim end-to-end from the tool's perspective)", async () => {
    const { handler } = registerAndCapture(async () => ({
      hits: [
        {
          id: "f1",
          content: "keyword-ranked result one",
          score: 0.55,
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: null,
        },
        {
          id: "f2",
          content: "keyword-ranked result two",
          score: 0.31,
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: null,
        },
      ],
      debug: { embedded: false, searchMode: "fts" },
    }));

    const result = await handler({ query: "q" });

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent?.memories as unknown[]).length).toBe(2);
  });

  it("when the server DID run vector search, debug.searchMode is surfaced as-is (not forced to 'semantic') — the caller can tell 'auto' from a real 'semantic' run", async () => {
    const { handler } = registerAndCapture(async () => ({
      hits: [
        {
          id: "f1",
          content: "vector hit",
          score: 0.91,
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: null,
        },
      ],
      // "auto", not "semantic" — this tool deliberately omits mode/vectorWeight
      // (see MCP-1 fix note in the file header), so "auto" is the real,
      // intended value the server reports here, not a routing-bug artifact.
      // This test pins that whatever the server reports is passed through
      // unmodified.
      debug: { embedded: true, searchMode: "auto" },
    }));

    const result = await handler({ query: "q" });

    expect(result.content[0]?.text).toContain("Found 1 semantic memories.");
    expect(result.content[0]?.text).toContain("vector hit");
    expect(result.structuredContent?.debug).toEqual({ embedded: true, searchMode: "auto" });
  });
});

describe("memory_search — hitFreshness projection (topicKey-suggest-and-hit-freshness slice c)", () => {
  it("includes hitFreshness in the memories projection when the server provides it", async () => {
    const { handler } = registerAndCapture(async () => ({
      hits: [
        {
          id: "f1",
          content: "hit",
          score: 0.9,
          validFrom: "2026-07-30T00:00:00.000Z",
          validTo: null,
          hitFreshness: "recent",
        },
      ],
    }));

    const result = await handler({ query: "q" });
    const memories = result.structuredContent?.memories as Array<Record<string, unknown>>;

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ id: "f1", hitFreshness: "recent" });
  });

  it("passes through undefined (not a string 'undefined') when the server omits hitFreshness", async () => {
    const { handler } = registerAndCapture(async () => ({
      hits: [
        {
          id: "f1",
          content: "hit",
          score: 0.9,
          validFrom: "2026-07-30T00:00:00.000Z",
          validTo: null,
        },
      ],
    }));

    const result = await handler({ query: "q" });
    const memories = result.structuredContent?.memories as Array<Record<string, unknown>>;

    expect(memories).toHaveLength(1);
    expect(memories[0]!.hitFreshness).toBeUndefined();
  });
});

describe("memory_search — error path", () => {
  it("returns isError:true with a descriptive message when client.recall throws", async () => {
    const { handler } = registerAndCapture(async () => {
      throw new Error("upstream unreachable");
    });

    const result = await handler({ query: "q" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("memory_search failed");
    expect(result.content[0]?.text).toContain("upstream unreachable");
  });
});

describe("memory_search — CaMeL labeling", () => {
  it("always labels structuredContent as untrusted_external_content", async () => {
    const { handler } = registerAndCapture(async () => ({ hits: [] }));
    const result = await handler({ query: "q" });
    expect(result.structuredContent?._mnemo_label).toBe("untrusted_external_content");
    expect(result.structuredContent?._mnemo_version).toBe("3.0");
  });
});
