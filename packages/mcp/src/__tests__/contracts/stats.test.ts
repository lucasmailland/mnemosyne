/**
 * Contract test for `memory_stats` (packages/mcp/src/tools/stats.ts).
 *
 * STATS-2: the description told callers to invoke "memory_status's
 * GET /governance/drift?fresh=true equivalent" to force-refresh five stale
 * fields. `GET /governance/drift` is real (packages/server/src/routes/governance.ts)
 * but has zero client-side callers — `memory_status`/`memory_introspect` have
 * no wrapper for it — and it's gated on the `memory:governance` scope, which
 * typical MCP keys don't hold. The described "equivalent" does not exist.
 */
import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStats } from "../../tools/stats.js";
import { registeredDescription } from "./registered-description.js";

function registerAndCapture(client: MnemosyneClient): { description: string } {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (toolName: string, schema: unknown, cb: unknown) => {
      if (toolName === "memory_stats") {
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerStats(server, client);
  return { description: registeredDescription("memory_stats") };
}

describe("memory_stats — description does not advertise an unreachable refresh path", () => {
  it("does not tell the caller to invoke a memory_status 'equivalent' of GET /governance/drift", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).not.toContain("memory_status's GET /governance/drift");
    expect(description).not.toMatch(/equivalent if you need those five fields recomputed/);
  });
  it("states plainly that no MCP-callable refresh exists and names the daily cron instead", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).toContain("no MCP-callable way");
    expect(description).toContain("memory:governance");
    expect(description).toContain("mnemo.health.snapshot");
  });
});
