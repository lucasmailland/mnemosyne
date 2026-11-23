// packages/mcp/src/__tests__/contracts/timeline.test.ts
//
// Contract tests for `memory_timeline` (tool-promise-remediation audit —
// see docs/archive/openspec/tool-promise-remediation/tools/memory_timeline.md).
//
// The promise: "Devuelve los hechos más recientes (created/updated/
// archived) del workspace ... Default 20, max 100."
//
// This file proves, at the MCP tool layer:
//   1. `limit` defaults to 20 when omitted, and an explicit value is
//      forwarded unchanged to `client.timeline()`.
//   2. `sinceIso` is mapped onto the client's `since` param and omitted
//      entirely (not sent as `undefined`) when the caller doesn't supply it.
//   3. The "max 100" promise is enforced by the tool's own zod schema
//      REJECTING out-of-range input, surfaced by the MCP SDK's dispatch
//      loop (`server/mcp.js`, `validateToolInput` + its catch block) as a
//      normal `isError: true` CallToolResult — NOT by silently clamping an
//      over-large `limit` down to 100, and NOT as a rejected client
//      promise either (the SDK wraps the zod `McpError` into a tool-result
//      error before it ever reaches the transport). Both the schema
//      unit-level view and a full stdio round-trip through a real MCP
//      server subprocess (mirroring `recall.stdio.test.ts`) confirm this: a
//      `limit: 500` call never reaches `client.timeline()` at all (0 HTTP
//      requests), so it can never return more than 100 events — but it
//      does so by failing the call outright, not by returning a valid
//      100-row page. Recorded in `docs/STATUS.md` as an implementation
//      detail, not a broken promise (the requirement — "never return more
//      than 100" — is satisfied).
//
// The DB-level ordering claim (recency across created/updated/archived,
// not just createdAt) is verified separately against a REAL Postgres
// instance in
// `packages/server/src/__tests__/integration/timeline-nonsuperuser.integration.test.ts`,
// per this repo's rule that DB-level claims must be checked against real
// Postgres under a NOSUPERUSER role, not mocks.
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTimeline } from "../../tools/timeline.js";
import type { TimelineResponse } from "@mnemo-ai/client-ts";
import {
  createStdioCleanup,
  MCP_ENTRY,
  MCP_TIMEOUT_MS,
  stdioEnvironment,
  TEST_TIMEOUT_MS,
} from "./stdio-tools.js";

/** Capture the registered handler and its declared zod input schema. */
function captureTool() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>;
  let schema: Record<string, unknown>;
  const server = {
    registerTool(_name: string, def: { inputSchema: unknown }, fn: typeof handler) {
      schema = def.inputSchema as Record<string, unknown>;
      handler = fn;
    },
  } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  const timeline = vi.fn();
  const client = { timeline } as unknown as import("@mnemo-ai/client-ts").MnemosyneClient;
  registerTimeline(server, client);
  return { handler: handler!, schema: schema!, timeline };
}

describe("memory_timeline — zod schema: 'max 100' is enforced by rejection, not clamping", () => {
  it("accepts the documented range 1..100, including both boundaries", () => {
    const { schema } = captureTool();
    const limit = schema.limit as { parse: (v: unknown) => unknown };
    expect(() => limit.parse(1)).not.toThrow();
    expect(() => limit.parse(20)).not.toThrow();
    expect(() => limit.parse(100)).not.toThrow();
  });

  it("rejects limit: 500 outright — it does NOT clamp to 100", () => {
    const { schema } = captureTool();
    const limit = schema.limit as { parse: (v: unknown) => unknown };
    expect(() => limit.parse(500)).toThrow();
  });

  it("rejects limit: 101 (one above the ceiling)", () => {
    const { schema } = captureTool();
    const limit = schema.limit as { parse: (v: unknown) => unknown };
    expect(() => limit.parse(101)).toThrow();
  });

  it("rejects limit: 0 (below the floor)", () => {
    const { schema } = captureTool();
    const limit = schema.limit as { parse: (v: unknown) => unknown };
    expect(() => limit.parse(0)).toThrow();
  });

  it("limit is optional (omitting it must not throw)", () => {
    const { schema } = captureTool();
    const limit = schema.limit as { parse: (v: unknown) => unknown };
    expect(() => limit.parse(undefined)).not.toThrow();
  });
});

describe("memory_timeline — handler: default limit and param passthrough", () => {
  it("defaults limit to 20 when omitted (Scenario: Default limit is 20)", async () => {
    const { handler, timeline } = captureTool();
    const response: TimelineResponse = { events: [], nextCursor: null };
    timeline.mockResolvedValue(response);

    await handler({});

    expect(timeline).toHaveBeenCalledTimes(1);
    expect(timeline).toHaveBeenCalledWith({ limit: 20 });
  });

  it("forwards an explicit in-range limit unchanged", async () => {
    const { handler, timeline } = captureTool();
    timeline.mockResolvedValue({ events: [], nextCursor: null });

    await handler({ limit: 50 });

    expect(timeline).toHaveBeenCalledWith({ limit: 50 });
  });

  it("maps sinceIso onto the client's `since` param", async () => {
    const { handler, timeline } = captureTool();
    timeline.mockResolvedValue({ events: [], nextCursor: null });

    await handler({ sinceIso: "2026-01-01T00:00:00.000Z" });

    expect(timeline).toHaveBeenCalledWith({
      limit: 20,
      since: "2026-01-01T00:00:00.000Z",
    });
  });

  it("omits `since` entirely (not `since: undefined`) when sinceIso is not given", async () => {
    const { handler, timeline } = captureTool();
    timeline.mockResolvedValue({ events: [], nextCursor: null });

    await handler({});

    const callArgs = timeline.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("since" in callArgs).toBe(false);
  });

  it("returns the client's events verbatim as structuredContent", async () => {
    const { handler, timeline } = captureTool();
    const response: TimelineResponse = {
      events: [
        { id: "ev1", at: "2026-07-27T00:00:00.000Z", kind: "updated", factId: "f1", summary: "x" },
      ],
      nextCursor: null,
    };
    timeline.mockResolvedValue(response);

    const result = (await handler({})) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: TimelineResponse;
    };

    expect(result.structuredContent).toEqual(response);
    expect(JSON.parse(result.content[0]!.text)).toEqual(response);
  });
});

describe("memory_timeline — error handling", () => {
  it("returns isError when the client call fails", async () => {
    const { handler, timeline } = captureTool();
    timeline.mockRejectedValue(new Error("network down"));

    const result = (await handler({})) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("network down");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Full stdio round-trip through a REAL running MCP server subprocess. This
// is what actually happens when a calling agent invokes the tool — it goes
// through the SDK's `validateToolInput` (real zod `safeParseAsync` against
// the registered schema) BEFORE the handler above ever runs. The unit tests
// above prove the schema itself rejects out-of-range values; this section
// proves that rejection actually happens on the real protocol path (a
// McpError, not a silently-clamped 200) and that in-range calls really do
// forward `limit`/`since` onto `GET /timeline`.
// ─────────────────────────────────────────────────────────────────────────
interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
}

let client: Client | undefined;
let transport: StdioClientTransport | undefined;
let closeFixture: (() => Promise<void>) | undefined;

afterEach(async () => {
  await createStdioCleanup(client, transport)();
  await closeFixture?.().catch(() => undefined);
  client = undefined;
  transport = undefined;
  closeFixture = undefined;
});

async function startHttpFixture(responseBody: unknown): Promise<{
  url: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    // Only record requests made by the MCP subprocess under test (it always
    // sends our test API key). The fixture binds an ephemeral port, and
    // unrelated processes on the host (e.g. stale probes hitting a reused
    // port) were observed sending a bare `GET /`, which made the request-count
    // assertions flaky without saying anything about memory_timeline.
    if (req.headers.authorization !== "Bearer mns_test_timeline") {
      res.writeHead(404).end();
      return;
    }
    requests.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  closeFixture = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

  return { url: `http://127.0.0.1:${address.port}`, requests };
}

async function connectMcp(fixtureUrl: string): Promise<Client> {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: stdioEnvironment(fixtureUrl, "mns_test_timeline"),
    stderr: "pipe",
  });
  client = new Client({ name: "mnemosyne-timeline-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport, { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS });
  return client;
}

describe("memory_timeline — stdio contract (real MCP dispatch)", () => {
  it(
    "omitted limit reaches the server as limit=20 over the real wire",
    async () => {
      const fixture = await startHttpFixture({ events: [], nextCursor: null });
      const mcpClient = await connectMcp(fixture.url);

      const result = await mcpClient.callTool(
        { name: "memory_timeline", arguments: {} },
        undefined,
        { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS }
      );

      expect("isError" in result ? result.isError : undefined).not.toBe(true);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]!.method).toBe("GET");
      const url = new URL(fixture.requests[0]!.url!, fixture.url);
      expect(url.searchParams.get("limit")).toBe("20");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "limit: 100 (the documented ceiling) is accepted and forwarded",
    async () => {
      const fixture = await startHttpFixture({ events: [], nextCursor: null });
      const mcpClient = await connectMcp(fixture.url);

      const result = await mcpClient.callTool(
        { name: "memory_timeline", arguments: { limit: 100 } },
        undefined,
        { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS }
      );

      expect("isError" in result ? result.isError : undefined).not.toBe(true);
      expect(fixture.requests).toHaveLength(1);
      const url = new URL(fixture.requests[0]!.url!, fixture.url);
      expect(url.searchParams.get("limit")).toBe("100");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "limit: 500 is REJECTED before any HTTP call is made (Scenario: Limit clamps at 100 — proven here as 'enforced by rejection, not clamping')",
    async () => {
      const fixture = await startHttpFixture({ events: [], nextCursor: null });
      const mcpClient = await connectMcp(fixture.url);

      const result = (await mcpClient.callTool(
        { name: "memory_timeline", arguments: { limit: 500 } },
        undefined,
        { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS }
      )) as { isError?: boolean; content: Array<{ text?: string }> };

      // The MCP SDK's own dispatch loop (server/mcp.js) catches the zod
      // McpError InvalidParams thrown by validateToolInput and wraps it as
      // a normal isError:true CallToolResult — it does NOT reject the
      // client's promise, and it never reaches our handler (so the caller
      // never gets a page of results at all, clamped or otherwise).
      expect(result.isError).toBe(true);
      const text = result.content[0]?.text;
      expect(text).toMatch(/memory_timeline/i);
      expect(text).toMatch(/100/);

      // The requirement ("never return more than 100 entries") holds, but
      // not via clamping: the call never even reaches client.timeline(), so
      // it never reaches GET /timeline either.
      expect(fixture.requests).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );
});
