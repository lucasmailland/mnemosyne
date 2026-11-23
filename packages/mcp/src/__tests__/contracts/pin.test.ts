/**
 * Contract test for `memory_pin` (packages/mcp/src/tools/pin.ts),
 * covering docs/archive/openspec/tool-promise-remediation/tools/memory_pin.md.
 *
 * The audit's central question is not "does the flag flip" but "what does
 * `pinned` actually protect against". The answer, established while auditing
 * `memory_purge`, is narrower than the word suggests: `pinned` is ANTI-DECAY.
 * It does not protect a fact from `memory_purge`'s bulk path
 * (`purgeForgottenFacts` filters on `status = 'forgotten'` and the
 * consolidation marker only), and `recall-cold.ts` never reads it for
 * ranking. This file pins the MCP-layer half; the semantics are recorded here
 * so the next reader does not assume the stronger meaning.
 *
 * Proven here: pin and unpin are the SAME server route with an opposite flag,
 * routed by intent — so a slip inverts the user's decision silently, and the
 * idempotency key must survive both directions.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerPin } from "../../tools/pin.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(client: MnemosyneClient): {
  call: (args: Record<string, unknown>) => Promise<ToolResult>;
  description: string;
} {
  const server = new McpServer({ name: "pin-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_pin") {
        handler = cb as typeof handler;
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerPin(server, client);
  if (!handler) throw new Error("memory_pin was not registered");
  return { call: handler, description };
}

const stub = (p: Record<string, unknown>): MnemosyneClient => p as unknown as MnemosyneClient;

describe("memory_pin — contract", () => {
  it("pins by default and unpins only when asked", async () => {
    const pinFact = vi.fn(async () => ({ pinned: true }));
    const unpinFact = vi.fn(async () => ({ pinned: false }));
    const { call } = capture(stub({ pinFact, unpinFact }));

    await call({ factId: "fact_1" });
    expect(pinFact).toHaveBeenCalledTimes(1);
    expect(unpinFact).not.toHaveBeenCalled();

    pinFact.mockClear();
    await call({ factId: "fact_1", unpin: true });
    expect(unpinFact).toHaveBeenCalledTimes(1);
    // The two directions share one route (`POST /facts/:id/pin` with a
    // `pinned` flag). Crossing them would invert the caller's decision with
    // no error anywhere.
    expect(pinFact).not.toHaveBeenCalled();
  });

  it("forwards the idempotency key in both directions", async () => {
    const pinFact = vi.fn(async () => ({ pinned: true }));
    const unpinFact = vi.fn(async () => ({ pinned: false }));
    const { call } = capture(stub({ pinFact, unpinFact }));

    await call({ factId: "fact_1", idempotencyKey: "idem-1" });
    expect(pinFact).toHaveBeenCalledWith("fact_1", undefined, "idem-1");

    await call({ factId: "fact_1", unpin: true, idempotencyKey: "idem-2" });
    expect(unpinFact).toHaveBeenCalledWith("fact_1", undefined, "idem-2");
  });

  it("surfaces a client failure as a tool error", async () => {
    const { call } = capture(
      stub({
        pinFact: vi.fn(async () => {
          throw new Error("404 fact not found");
        }),
      })
    );
    const res = await call({ factId: "gone" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("404 fact not found");
  });
});
