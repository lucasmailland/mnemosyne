/** B4: exercise the real SDK dispatcher and HTTP client with isolated transports.
 * An HTTP listener counts unrelated traffic as well as calls from the tool under
 * test. A per-client fetch spy proves exactly which requests this dispatch made.
 * Built stdio tools/list coverage lives in the shared contract suite.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MnemosyneClient } from "@mnemo-ai/client-ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAllTools } from "../../registry.js";

let client: Client | undefined;
let server: McpServer | undefined;
afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

async function connectMcp() {
  const http = vi.fn<typeof fetch>(async () => Response.json({ applied: true }));
  const memory = new MnemosyneClient({
    url: "http://self-edit.fixture",
    apiKey: "mns_test_self_edit_schema",
    fetch: http,
  });
  server = new McpServer({ name: "mnemosyne-schema-test", version: "1.0.0" });
  registerAllTools(server, memory);
  client = new Client({ name: "self-edit-schema-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { mcpClient: client, http };
}

describe("memory_self_edit input schema (B4)", () => {
  it("does not list 'forget' among the advertised action enum values", async () => {
    const { mcpClient, http } = await connectMcp();
    const result = await mcpClient.listTools();
    const selfEdit = result.tools.find((tool) => tool.name === "memory_self_edit");
    expect(selfEdit, "memory_self_edit tool must be registered").toBeDefined();
    const actionSchema = (
      selfEdit?.inputSchema as { properties?: { action?: { enum?: unknown[] } } }
    )?.properties?.action;
    expect(actionSchema?.enum).toEqual([
      "append",
      "replace",
      "strengthen",
      "weaken",
      "reflect",
      "link",
    ]);
    expect(http).not.toHaveBeenCalled();
  });

  it("rejects action:'forget' with a schema validation error, never reaching HTTP", async () => {
    const { mcpClient, http } = await connectMcp();
    const result = await mcpClient.callTool({
      name: "memory_self_edit",
      arguments: {
        action: "forget",
        target: "mfact_00000000000000000000000000",
        reason: "B4 schema-rejection probe",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/invalid arguments for tool memory_self_edit/i);
    expect(text).toMatch(/\baction\b/);
    expect(http).not.toHaveBeenCalled();

    // Positive control: the same connection must reach HTTP for a valid action.
    // A disconnected handler or broken request spy cannot make this test pass.
    const valid = await mcpClient.callTool({
      name: "memory_self_edit",
      arguments: { action: "strengthen", target: "mfact_fixture", reason: "control" },
    });
    expect(valid.isError).not.toBe(true);
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0]!;
    expect(String(url)).toBe("http://self-edit.fixture/self/edit");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      action: "strengthen",
      target: "mfact_fixture",
      reason: "control",
    });
  });
});
