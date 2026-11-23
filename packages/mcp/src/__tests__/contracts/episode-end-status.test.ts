/**
 * `memory_episode_end` reports the pipeline's verdict, not just that the call
 * returned. Found while doing tool-promise-remediation task 2.5.
 *
 * This is the P115 defect, one layer higher up than where it was fixed. P115
 * was: a collapse the pipeline SKIPPED answered `accepted:true` and nothing
 * else, so a discarded session was indistinguishable from a saved one — which
 * is exactly how sessions were being thrown away invisibly for as long as they
 * were. The fix threaded `status` and `skipReason` out through core and the
 * HTTP route, and `routes/session.ts` carries a comment saying why.
 *
 * The MCP tool then dropped both on the floor and printed
 * "Episode ended and collapsed." unconditionally. So for every agent calling
 * through MCP — which is every agent — P115 was still live: an episode skipped
 * for `llm_unavailable` reported as collapsed, and the agent went on believing
 * its session had been written to durable memory.
 *
 * `CollapseSessionResponse` in client-ts did not declare the two fields
 * either, so the tool could not have read them without a type change. Three of
 * the four layers carried the truth and the last two silently discarded it —
 * which is why a caveat in the description alone would not have been enough
 * here: the description would warn about a case the tool then reports as
 * success anyway.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollapseSessionResponse, MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerEpisodeEnd } from "../../tools/episode_end.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(response: CollapseSessionResponse | Error): {
  call: (args: Record<string, unknown>) => Promise<ToolResult>;
} {
  const collapseSession = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const server = new McpServer({ name: "episode-end-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_episode_end") handler = cb as typeof handler;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  // The collapse runs on a long-budget clone (APP-014); the stub is its own clone.
  const client = { collapseSession, withTimeout: () => client };
  registerEpisodeEnd(server, client as unknown as MnemosyneClient);
  if (!handler) throw new Error("memory_episode_end was not registered");
  return { call: handler };
}

describe("memory_episode_end — the pipeline's verdict reaches the caller", () => {
  it("reports a completed collapse as collapsed", async () => {
    const { call } = capture({ accepted: true, sessionId: "ses_1", status: "completed" });

    const res = await call({ sessionId: "ses_1" });

    expect(res.content[0]?.text).toContain("collapsed");
    expect(res.structuredContent).toMatchObject({ sessionId: "ses_1", status: "completed" });
  });

  for (const skipReason of [
    "llm_unavailable",
    "too_few_turns",
    "low_recurrence_signal",
    "no_pin",
  ] as const) {
    it(`does NOT claim success when the pipeline skipped for ${skipReason}`, async () => {
      const { call } = capture({
        accepted: true,
        sessionId: "ses_1",
        status: "skipped",
        skipReason,
      });

      const res = await call({ sessionId: "ses_1" });

      // The exact wording may change; what may not is that a skip stops
      // reading as a save. "collapsed" unqualified is the claim that was
      // false, so it must not appear on this path.
      expect(res.content[0]?.text).not.toMatch(/ended and collapsed/i);
      expect(res.content[0]?.text).toContain("did NOT extract");
      expect(res.content[0]?.text).toContain(skipReason);
      expect(res.structuredContent).toMatchObject({ status: "skipped", skipReason });

      // Not an error: the request WAS processed and the episode IS closed.
      // Turning a skip into isError would be the opposite failure — the agent
      // would retry a call that is behaving exactly as designed.
      expect(res.isError).toBe(false);
    });
  }

  it("surfaces a failed extraction as not-completed too", async () => {
    const { call } = capture({ accepted: true, sessionId: "ses_1", status: "failed" });

    const res = await call({ sessionId: "ses_1" });

    expect(res.content[0]?.text).not.toMatch(/ended and collapsed/i);
    expect(res.structuredContent).toMatchObject({ status: "failed" });
    // Nothing was written: unlike a skip, a failure is an error (APP-014).
    expect(res.isError).toBe(true);
  });

  it("treats a server too old to send status as completed", async () => {
    // Wire-compat: pre-P115 servers answer `{accepted, sessionId}` only.
    // Defaulting a missing status to "skipped" would make every such server
    // look broken; defaulting to "completed" matches what those servers meant.
    const { call } = capture({ accepted: true, sessionId: "ses_1" });

    const res = await call({ sessionId: "ses_1" });

    expect(res.content[0]?.text).toContain("collapsed");
    expect(res.structuredContent).toMatchObject({ status: "completed" });
  });

  it("marks an idempotent retry as resumed rather than as fresh work", async () => {
    const { call } = capture({
      accepted: true,
      sessionId: "ses_1",
      status: "completed",
      resumed: true,
    });

    const res = await call({ sessionId: "ses_1" });

    expect(res.content[0]?.text).toContain("resumed");
    expect(res.structuredContent).toMatchObject({ resumed: true });
  });

  it("still surfaces a transport failure as a tool error", async () => {
    const { call } = capture(new Error("404 session not found"));

    const res = await call({ sessionId: "gone" });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("404 session not found");
  });
});
