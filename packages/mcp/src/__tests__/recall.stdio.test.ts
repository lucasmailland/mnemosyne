import { once } from "node:events";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStdioCleanup,
  MCP_ENTRY,
  MCP_TIMEOUT_MS,
  stdioEnvironment,
  TEST_TIMEOUT_MS,
} from "./contracts/stdio-tools.js";
import { EXPECTED_TOOL_NAMES } from "./tool-names.js";

const TEST_API_KEY = "mns_test_stdio";

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;
type DirectToolResult = Extract<ToolCallResult, { content: unknown }>;
type ToolContent = DirectToolResult["content"][number];
type TextContent = Extract<ToolContent, { type: "text" }>;

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

let client: Client | undefined;
let transport: StdioClientTransport | undefined;
let closeFixture: (() => Promise<void>) | undefined;
let childStderr = "";

afterEach(async () => {
  await createStdioCleanup(client, transport)();
  await closeFixture?.().catch(() => undefined);
  client = undefined;
  transport = undefined;
  closeFixture = undefined;
  childStderr = "";
});

function requireDirectResult(result: ToolCallResult): DirectToolResult {
  if (!("content" in result)) throw new Error("Expected a direct tool result");
  return result as DirectToolResult;
}

function isTextContent(item: ToolContent): item is TextContent {
  return item.type === "text";
}

async function startHttpFixture(
  responseBody: unknown,
  status = 200
): Promise<{
  url: string;
  captured: CapturedRequest;
}> {
  const captured: CapturedRequest = {
    method: undefined,
    url: undefined,
    authorization: undefined,
    body: undefined,
  };
  const server = createServer(async (req, res) => {
    try {
      let rawBody = "";
      for await (const chunk of req) rawBody += String(chunk);
      captured.method = req.method;
      captured.url = req.url;
      captured.authorization = req.headers.authorization;
      captured.body = rawBody ? JSON.parse(rawBody) : undefined;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("HTTP fixture did not bind to a TCP port");
  }

  closeFixture = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  return { url: `http://127.0.0.1:${address.port}`, captured };
}

async function connectMcp(fixtureUrl: string): Promise<Client> {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: stdioEnvironment(fixtureUrl, TEST_API_KEY),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    childStderr += String(chunk);
  });
  client = new Client({ name: "mnemosyne-b6-2-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport, {
      timeout: MCP_TIMEOUT_MS,
      maxTotalTimeout: MCP_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`MCP stdio initialization failed: ${childStderr}`, { cause: error });
  }
  return client;
}

async function callRecall(mcpClient: Client): Promise<DirectToolResult> {
  try {
    return requireDirectResult(
      await mcpClient.callTool(
        { name: "memory_recall", arguments: { query: "answer style", limit: 5 } },
        undefined,
        { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS }
      )
    );
  } catch (error) {
    throw new Error(`memory_recall stdio call failed: ${childStderr}`, { cause: error });
  }
}

describe("memory_recall stdio contract", () => {
  it(
    "lists the exact ordered 33-tool contract",
    async () => {
      const fixture = await startHttpFixture({ hits: [] });
      const mcpClient = await connectMcp(fixture.url);
      const result = await mcpClient.listTools(undefined, {
        timeout: MCP_TIMEOUT_MS,
        maxTotalTimeout: MCP_TIMEOUT_MS,
      });

      expect(result.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "returns memories as a hit array with sibling debug metadata",
    async () => {
      const fixtureResponse = {
        hits: [
          {
            id: "fact-1",
            content: "The user prefers concise answers",
            score: 0.91,
            validFrom: "2026-07-15T00:00:00.000Z",
            validTo: null,
            attribution: { source: "user_stated" },
          },
        ],
        debug: { embedded: true, latencyMs: 12 },
      };
      const fixture = await startHttpFixture(fixtureResponse);
      const result = await callRecall(await connectMcp(fixture.url));

      expect(fixture.captured.method).toBe("POST");
      expect(fixture.captured.url).toBe("/recall");
      expect(fixture.captured.authorization).toBe(`Bearer ${TEST_API_KEY}`);
      expect(fixture.captured.body).toMatchObject({ query: "answer style", topK: 5 });

      const structured = result.structuredContent as Record<string, unknown>;
      // APP-020: compact (the MCP default) structures the fields the text shows,
      // not the wire hit a second time: no attribution, no null validTo.
      expect(structured.memories).toEqual([
        {
          id: "fact-1",
          content: "The user prefers concise answers",
          score: 0.91,
          validFrom: "2026-07-15T00:00:00.000Z",
        },
      ]);
      expect(Array.isArray(structured.memories)).toBe(true);
      expect(structured.debug).toEqual(fixtureResponse.debug);
      expect(structured._mnemo_label).toBe("untrusted_external_content");
      expect(structured._mnemo_version).toBe("3.0");
      expect(structured.memories).not.toHaveProperty("hits");
      expect(structured.memories).not.toHaveProperty("debug");

      const text = result.content.find(isTextContent);
      expect(text).toBeDefined();
      // RECALL-9: the text is a compact rendering.
      expect(text!.text).toContain("untrusted data");
      expect(text!.text).toContain("<untrusted_context>");
      expect(text!.text).toContain("fact-1");
      expect(text!.text).toContain("The user prefers concise answers");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "forwards hitFreshness verbatim on each hit (topicKey-suggest-and-hit-freshness slice c — hitFreshness is in the compact field set)",
    async () => {
      const fixtureResponse = {
        hits: [
          {
            id: "fact-1",
            content: "The user prefers concise answers",
            score: 0.91,
            validFrom: "2026-07-15T00:00:00.000Z",
            validTo: null,
            hitFreshness: "aging",
          },
        ],
      };
      const fixture = await startHttpFixture(fixtureResponse);
      const result = await callRecall(await connectMcp(fixture.url));

      const structured = result.structuredContent as Record<string, unknown>;
      const { validTo: _nullValidTo, ...shown } = fixtureResponse.hits[0]!;
      expect(structured.memories).toEqual([shown]);
      expect((structured.memories as Array<Record<string, unknown>>)[0]!.hitFreshness).toBe(
        "aging"
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    "omits debug when the SDK response does not provide it",
    async () => {
      const fixture = await startHttpFixture({ hits: [] });
      const result = await callRecall(await connectMcp(fixture.url));
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.memories).toEqual([]);
      expect(structured).not.toHaveProperty("debug");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "forwards sessionId to POST /recall (P37: was silently dropped, not exposed in the tool's inputSchema at all)",
    async () => {
      const fixture = await startHttpFixture({ hits: [] });
      const mcpClient = await connectMcp(fixture.url);
      await mcpClient.callTool(
        {
          name: "memory_recall",
          arguments: { query: "answer style", limit: 5, sessionId: "sess_abc123" },
        },
        undefined,
        { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS }
      );

      expect(fixture.captured.body).toMatchObject({
        query: "answer style",
        sessionId: "sess_abc123",
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "omits sessionId from the request body when not supplied",
    async () => {
      const fixture = await startHttpFixture({ hits: [] });
      await callRecall(await connectMcp(fixture.url));

      expect(fixture.captured.body).not.toHaveProperty("sessionId");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "preserves the existing MCP error response for HTTP failures",
    async () => {
      const fixture = await startHttpFixture({ error: "invalid recall" }, 400);
      const result = await callRecall(await connectMcp(fixture.url));

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("memory_recall failed:"),
        }),
      ]);
    },
    TEST_TIMEOUT_MS
  );
});
