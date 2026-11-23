/**
 * Contract test for `memory_remember` (packages/mcp/src/tools/remember.ts).
 *
 * REMEMBER-1: the tool's description made three untruths. (a) `confidence`
 * is a `z.number().min(0).max(1)` everywhere (MCP schema, HTTP schema,
 * handler default `?? 0.7`) — there is no `'llm'` enum value anywhere in the
 * type or logic (grepped across core/types/client-ts/server/mcp; the only
 * real `"llm"` is `TrustLadderRung` in `core/src/recall/trust-ladder.ts`,
 * which is `mnemo_relation.provenance`, unrelated to fact confidence). (b)
 * the normal path calls `createPrimitive()` directly — it does NOT enqueue
 * to a review queue (that only happens in the surprise-gate staging and
 * anomaly-review branches). (c) when the surprise gate trips, the fact is
 * staged (`status:'staged'`, not immediately searchable) rather than
 * unconditionally "buscable inmediatamente" — and `routes/remember.ts`
 * already surfaces `status:'staged'|'active'` on the wire, so the caller CAN
 * detect this today, just wasn't told to look at `status`.
 */
import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRemember } from "../../tools/remember.js";
import { registeredDescription } from "./registered-description.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function registerAndCapture(client: MnemosyneClient): {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  description: string;
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      if (toolName === "memory_remember") {
        handler = cb as unknown as (args: Record<string, unknown>) => Promise<ToolResult>;
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerRemember(server, client);
  if (!handler) throw new Error("memory_remember was not registered");
  return { handler, description: registeredDescription("memory_remember") };
}

describe("memory_remember — description does not promise a nonexistent confidence value", () => {
  it("never mentions confidence='llm' (no such value exists anywhere in the type or logic)", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).not.toContain("confidence='llm'");
    expect(description).not.toContain("llm");
  });
  it("does not claim the fact enters a review queue on the normal path", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).not.toContain("review queue");
  });
});

// P74 — this block used to assert the OPPOSITE: that the description disclosed
// a staging path the caller had to check for. That path is gone. It diverted
// low-prediction-error writes into a queue with no table, no consumer and no
// promotion step, and returned a fabricated id for a row that was never
// written — so the description was teaching callers to handle a state that only
// ever meant "your write was lost". The contract now guards the inverse: the
// description must NOT resurrect the staging promise.
describe("memory_remember — description does not promise a staging path (P74)", () => {
  it("does NOT promise unconditional immediate searchability", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).not.toMatch(/se vuelve buscable inmediatamente/i);
  });
  it("does NOT describe a staging queue or a promotion job", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).not.toMatch(/staged|staging/i);
    expect(description).not.toMatch(/promueva/i);
  });
  it("points the caller at what the response reports (statement, warnings, conflicts)", () => {
    // `status` is always "active" since P74; the signals live in `statement`
    // (what was stored), `warnings` and the conflict verdicts.
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).toContain("`statement` is what was stored");
    expect(description).toContain("`warnings`");
    expect(description).toContain("memory_judge");
  });
});

describe("memory_remember — status pass-through", () => {
  it("surfaces status:'active' on the normal path", async () => {
    const remember = vi.fn(async () => ({
      id: "f_1",
      workspaceId: "ws",
      statement: "s",
      status: "active",
    }));
    const { handler } = registerAndCapture({ remember } as unknown as MnemosyneClient);
    const out = await handler({ statement: "the sky is blue" });
    expect(out.structuredContent?.status).toBe("active");
  });
});
