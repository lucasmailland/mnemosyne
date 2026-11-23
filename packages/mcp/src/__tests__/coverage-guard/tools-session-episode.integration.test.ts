/**
 * B4.2 — MCP tool coverage fill-in: session/episode tools (design.md "B4.
 * Coverage fill-in", spec.md Requirement 13). Exercises all 10
 * `memory_session` action branches, `memory_episode_start` +
 * `memory_episode_end` (the legacy 2-tool split of the same lifecycle), and
 * `memory_context` against the real live-surface harness's `mcp` stdio
 * client.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";
import { callTool, callToolOk } from "./mcp-tool-helpers.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 120_000);

afterAll(async () => {
  await surface.close();
});

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("memory_session (B4.2) — full lifecycle across its 10 actions", () => {
  it("start, turn, scratch, feedback, pin_turn, get, discard", async () => {
    const started = await callToolOk(surface.mcp, "memory_session", { action: "start" });
    const sessionId = (started.structuredContent as { id: string }).id;
    expect(sessionId).toBeTruthy();

    const turned = await callToolOk(surface.mcp, "memory_session", {
      action: "turn",
      sessionId,
      content: "Hello from B4.2 memory_session coverage.",
    });
    expect((turned.structuredContent as { appended: boolean }).appended).toBe(true);

    const scratched = await callToolOk(surface.mcp, "memory_session", {
      action: "scratch",
      sessionId,
      content: "B4.2 scratch note.",
    });
    expect((scratched.structuredContent as { scratched: boolean }).scratched).toBe(true);

    const fedBack = await callToolOk(surface.mcp, "memory_session", {
      action: "feedback",
      sessionId,
      rating: "up",
    });
    expect((fedBack.structuredContent as { feedback: boolean; rating: string }).rating).toBe("up");

    // action='turn' surfaces no turn id, so pin by index: the turn above is
    // index 0. A selector that matches no turn is an error since 40065898.
    const pinnedTurn = await callToolOk(surface.mcp, "memory_session", {
      action: "pin_turn",
      sessionId,
      turnIndex: 0,
    });
    expect((pinnedTurn.structuredContent as { pinned: boolean }).pinned).toBe(true);
    const missingTurn = await callTool(surface.mcp, "memory_session", {
      action: "pin_turn",
      sessionId,
      turnId: randomUUID(),
    });
    expect(missingTurn.isError).toBe(true);

    const got = await callToolOk(surface.mcp, "memory_session", { action: "get", sessionId });
    expect((got.structuredContent as { id: string }).id).toBe(sessionId);

    const discarded = await callToolOk(surface.mcp, "memory_session", {
      action: "discard",
      sessionId,
    });
    expect((discarded.structuredContent as { discarded: boolean }).discarded).toBe(true);
  });

  it("start then collapse — closes the session and collapses the ephemeral buffer", async () => {
    const started = await callToolOk(surface.mcp, "memory_session", { action: "start" });
    const sessionId = (started.structuredContent as { id: string }).id;
    await callToolOk(surface.mcp, "memory_session", {
      action: "turn",
      sessionId,
      content: "Collapse this session via memory_session, B4.2.",
    });
    const collapsed = await callToolOk(surface.mcp, "memory_session", {
      action: "collapse",
      sessionId,
    });
    const body = collapsed.structuredContent as { sessionId: string; accepted?: boolean };
    expect(body.sessionId).toBe(sessionId);
  });

  it("action='pin' — pins a fact through the session tool's alias path", async () => {
    const fact = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 fact pinned via memory_session." }),
      })
    );
    const pinned = await callToolOk(surface.mcp, "memory_session", {
      action: "pin",
      factId: fact.id,
    });
    expect((pinned.structuredContent as { pinned: boolean }).pinned).toBe(true);
  });

  it("action='list' — lists sessions in the workspace", async () => {
    const listed = await callToolOk(surface.mcp, "memory_session", { action: "list" });
    const body = listed.structuredContent as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
  });
});

describe("memory_episode_start / memory_episode_end (B4.2) — legacy 2-tool split", () => {
  it("starts an episode then ends (collapses) it", async () => {
    const started = await callToolOk(surface.mcp, "memory_episode_start", {
      label: "B4.2 episode",
    });
    const startedText = started.content[0]?.text ?? "";
    const match = /sessionId:\s*(\S+)/.exec(startedText);
    expect(match).toBeTruthy();
    const sessionId = match![1];

    const ended = await callToolOk(surface.mcp, "memory_episode_end", { sessionId });
    const endedText = ended.content[0]?.text ?? "";
    expect(endedText).toContain(sessionId);
    // The harness wires no LLM and the episode has no turns, so the pipeline
    // skips extraction. Since P115 the tool reports that verdict instead of an
    // unconditional "collapsed".
    const body = ended.structuredContent as { status: string; skipReason?: string };
    expect(body.status).toBe("skipped");
    expect(body.skipReason).toBeTruthy();
    expect(endedText).toContain("did NOT extract knowledge");
  });
});

describe("memory_context (B4.2)", () => {
  it("returns the active workspace identity, role, and stats", async () => {
    const result = await callToolOk(surface.mcp, "memory_context", {});
    const body = result.structuredContent as {
      workspace: { id: string } | null;
      _note: string;
    };
    expect(body.workspace?.id).toBe(surface.workspaceId);
    expect(typeof body._note).toBe("string");
  });
});
