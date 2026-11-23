import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const MCP_TIMEOUT_MS = 5_000;
export const TEST_TIMEOUT_MS = 15_000;
export const MCP_ENTRY = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));

type BuiltTools = Awaited<ReturnType<Client["listTools"]>>["tools"];

export interface BuiltToolsFixture {
  tools: BuiltTools;
  httpRequestCount: () => number;
  close: () => Promise<void>;
}

/**
 * `toolProfile` is MNEMO_MCP_TOOLS; null (the default) removes it, even if the
 * parent shell sets it, so the child serves its own default profile (full).
 */
export function stdioEnvironment(
  fixtureUrl: string,
  apiKey: string,
  toolProfile: string | null = null,
): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    MNEMO_URL: fixtureUrl,
    MNEMO_KEY: apiKey,
  };
  if (toolProfile === null) delete env.MNEMO_MCP_TOOLS;
  else env.MNEMO_MCP_TOOLS = toolProfile;
  return env;
}

export function createStdioCleanup(
  client: Client | undefined,
  transport: StdioClientTransport | undefined,
): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return () => cleanup ??= (async () => {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  })();
}

export async function listBuiltTools(toolProfile: string | null = null): Promise<BuiltToolsFixture> {
  let requestCount = 0;
  let serverListening = false;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let childStderr = "";

  const server = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "tools/list must not call HTTP" }));
  });
  let cleanup: Promise<void> | undefined;
  const close = () => cleanup ??= (async () => {
    await createStdioCleanup(client, transport)();
    if (serverListening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      serverListening = false;
    }
  })();

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    serverListening = true;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP fixture did not bind to a TCP port");
    }

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_ENTRY],
      env: stdioEnvironment(`http://127.0.0.1:${address.port}`, "mns_test_contracts", toolProfile),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      childStderr += String(chunk);
    });
    client = new Client(
      { name: "mnemosyne-contract-schema-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport, {
      timeout: MCP_TIMEOUT_MS,
      maxTotalTimeout: MCP_TIMEOUT_MS,
    });
    const result = await client.listTools(undefined, {
      timeout: MCP_TIMEOUT_MS,
      maxTotalTimeout: MCP_TIMEOUT_MS,
    });

    return {
      tools: result.tools,
      httpRequestCount: () => requestCount,
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    const diagnostics = childStderr.trim() || "no child stderr";
    throw new Error(`Built MCP tools/list failed (${diagnostics})`, { cause: error });
  }
}
