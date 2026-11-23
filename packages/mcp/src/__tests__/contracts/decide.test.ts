/**
 * Contract test for `memory_decide` (packages/mcp/src/tools/decide.ts),
 * covering docs/archive/openspec/tool-promise-remediation/tools/memory_decide.md.
 *
 * This file proves the MCP-layer HANDLER behavior with a stubbed client
 * (no DB): field forwarding, round-tripping of the client's response, and
 * — critically — that the tool applies ZERO client-side transformation to
 * `topicKey` (no case-folding, no trim) before forwarding it. That, plus
 * the field-forwarding proof below, place the entire "idempotente por
 * topic_key normalizado" claim's fate on the server: if the server also
 * does no normalization, the claim is false end-to-end.
 *
 * The server-side half of that claim (whether the byte-exact match is
 * also true at the HTTP route + DB layer, and what "normalized" actually
 * means in the real code) is a DB-level claim and is proven separately
 * against REAL Postgres under a NOSUPERUSER role, per this repo's rule
 * that DB/RLS claims must not be verified by mocks alone:
 * packages/server/src/__tests__/integration/decide-topic-key.integration.test.ts
 *
 * That integration suite found:
 *   - Exact-match topic_key IS an upsert (revision_count increments, same id).
 *   - Case-only variation ("Auth-Strategy" vs "auth-strategy") creates a
 *     SECOND independent row — no case-folding anywhere in the pipeline.
 *   - Whitespace variation (trailing space) creates a SECOND independent
 *     row — no trim anywhere in the pipeline.
 *   - Omitting topicKey never derives one from `title` — every call
 *     without topicKey creates a brand new row, contradicting the tool
 *     schema's (now-fixed) claim that omitting it lets the server compute
 *     one from title.
 * decide.ts's description and topicKey field description have been
 * updated to disclose this (byte-exact match only, no auto-derivation).
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerDecide } from "../../tools/decide.js";

function capture(
  reg: (s: McpServer, c: MnemosyneClient) => void,
  client: MnemosyneClient
): (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}> {
  const server = new McpServer({ name: "decide-test", version: "0.0.0" });
  let handler:
    | ((a: Record<string, unknown>) => Promise<{
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      }>)
    | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_decide") handler = cb as typeof handler;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  reg(server, client);
  if (!handler) throw new Error("memory_decide was not registered");
  return handler;
}

function stub(partial: Record<string, unknown>): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

const FIXED_DECISION = {
  id: "mdec_fixed001",
  workspaceId: "ws_1",
  kind: "architecture" as const,
  title: "Use PostgreSQL as the primary datastore.",
  body:
    "Rationale: ACID + pgvector. Alternatives considered: MongoDB (rejected), " +
    "DynamoDB+separate vector DB (rejected). Chosen: PostgreSQL + pgvector.",
  topicKey: "db-choice",
  revisionCount: 1,
  status: "active" as const,
};

describe("memory_decide MCP contract (handler-level, stubbed client)", () => {
  it("scenario 1: all documented fields (title=summary, body=rationale+alternatives+chosen) are forwarded to createDecision unmodified", async () => {
    const createDecision = vi.fn(async (_input: Record<string, unknown>) => FIXED_DECISION);
    const handler = capture(registerDecide, stub({ createDecision }));

    await handler({
      kind: "architecture",
      title: FIXED_DECISION.title,
      body: FIXED_DECISION.body,
    });

    expect(createDecision).toHaveBeenCalledOnce();
    const input = createDecision.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.kind).toBe("architecture");
    expect(input.title).toBe(FIXED_DECISION.title);
    expect(input.body).toBe(FIXED_DECISION.body);
    // No alternatives/chosen structured fields exist to drop — everything
    // the caller passes lives in title/body verbatim.
    expect(Object.keys(input).sort()).toEqual(["body", "kind", "title"]);
  });

  it("scenario 1b: the client's response round-trips byte-exact through structuredContent and the text payload", async () => {
    const createDecision = vi.fn(async (_input: Record<string, unknown>) => FIXED_DECISION);
    const handler = capture(registerDecide, stub({ createDecision }));

    const result = await handler({
      kind: "architecture",
      title: FIXED_DECISION.title,
      body: FIXED_DECISION.body,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(FIXED_DECISION);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as typeof FIXED_DECISION;
    expect(parsed).toEqual(FIXED_DECISION);
  });

  it("scenario 2/3/4 (client-layer half): topicKey is forwarded BYTE-EXACT — no case-folding, no trim applied before the client call", async () => {
    const createDecision = vi.fn(async (_input: Record<string, unknown>) => FIXED_DECISION);
    const handler = capture(registerDecide, stub({ createDecision }));

    const mixedCase = "Auth-Strategy";
    await handler({ kind: "decision", title: "t", body: "b", topicKey: mixedCase });
    const input1 = createDecision.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input1.topicKey).toBe(mixedCase); // NOT lowercased

    const padded = "billing-policy ";
    await handler({ kind: "decision", title: "t", body: "b", topicKey: padded });
    const input2 = createDecision.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(input2.topicKey).toBe(padded); // NOT trimmed

    // Since the MCP layer performs no normalization, any idempotency the
    // description promises can only come from the server — and the real
    // server also does no normalization (proven against real Postgres in
    // decide-topic-key.integration.test.ts). The tool-layer claim is
    // therefore false end-to-end for non-byte-identical topicKeys.
  });

  it("scenario 5 (client-layer half): omitting topicKey forwards it as absent (undefined key), never derived from title", async () => {
    const createDecision = vi.fn(async (_input: Record<string, unknown>) => FIXED_DECISION);
    const handler = capture(registerDecide, stub({ createDecision }));

    await handler({ kind: "decision", title: "Adopt trunk-based development.", body: "b" });
    const input = createDecision.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("topicKey" in input).toBe(false);
  });

  it("forwards idempotencyKey as createDecision's trailing arg (§34.9)", async () => {
    const createDecision = vi.fn(async (_input: Record<string, unknown>) => FIXED_DECISION);
    const handler = capture(registerDecide, stub({ createDecision }));

    await handler({ kind: "decision", title: "t", body: "b", idempotencyKey: "idem-1" });
    const args = createDecision.mock.calls[0];
    if (!args) throw new Error("createDecision was not called");
    expect(args.at(-1)).toBe("idem-1");
  });

  it("returns isError:true with a descriptive message when the client throws", async () => {
    const createDecision = vi.fn(async () => {
      throw new Error("simulated network failure");
    });
    const handler = capture(registerDecide, stub({ createDecision }));

    const result = await handler({ kind: "decision", title: "t", body: "b" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("memory_decide failed");
    expect(result.content[0]?.text).toContain("simulated network failure");
  });
});
