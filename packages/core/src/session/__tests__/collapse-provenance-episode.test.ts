/**
 * AGENTSIM-2 (server part) — facts written by hand during a session the
 * pipeline skips still get an episode.
 *
 * A pure-MCP agent follows the protocol: `memory_episode_start` →
 * `memory_remember(..., sessionId)` → `memory_episode_end`. It sends no turns,
 * so the collapse returns `too_few_turns` before any episode exists, and the
 * facts stay with `episode_id` null — measured 0/58 linked — although SKILL.md
 * promises the episode links "every fact carrying that sessionId — including
 * the ones you wrote by hand".
 *
 * The skip itself is unchanged (no extraction, session archived by the
 * facade). What is added is a provenance episode: created only when the
 * session has hand-written facts not yet linked to any episode, and carrying
 * no model output and no copied statement text (a fact may be confidential;
 * the episode is not).
 */
import { describe, it, expect } from "vitest";
import { collapseSession } from "../collapse.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

const input = { sessionId: "s1", workspaceId: "ws", reason: "explicit" as const };

describe("AGENTSIM-2 — provenance episode for a skipped session", () => {
  it("links hand-written facts of a session with too few turns", async () => {
    const h = makeHarness({
      replies: [reply({})],
      turns: 0,
      seedFacts: [
        { statement: "orders-api uses Redis 7", sessionId: "s1" },
        { statement: "deploys need two approvals", sessionId: "s1" },
        { statement: "from another session", sessionId: "s2" },
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("too_few_turns");
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.episodes).toHaveLength(1);
    const episode = h.episodes[0]!;
    expect((episode.linkedFactIds as string[]).sort()).toEqual(
      h
        .activeFacts()
        .filter((f) => f.sessionId === "s1")
        .map((f) => f.id)
        .sort()
    );
    expect(episode.sourceConversationId).toBe("s1");
    expect(String(episode.narrative)).not.toContain("Redis");
    expect(h.storage.linkSessionFactsToEpisode).toHaveBeenCalledWith("ws", "s1", episode.id);
    expect(result.episodeId).toBe(episode.id);
  });

  it("creates nothing for a skipped session without hand-written facts", async () => {
    const h = makeHarness({ replies: [reply({})], turns: 0 });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("skipped");
    expect(h.episodes).toHaveLength(0);
  });

  it("does not create a second episode when the facts are already linked", async () => {
    const h = makeHarness({
      replies: [reply({})],
      turns: 0,
      seedFacts: [{ statement: "already in an episode", sessionId: "s1", episodeId: "ep-0" }],
    });

    await collapseSession(input, h.ctx, auth);

    expect(h.episodes).toHaveLength(0);
  });

  it("a provenance-episode failure does not turn the skip into an error", async () => {
    const h = makeHarness({
      replies: [reply({})],
      turns: 0,
      seedFacts: [{ statement: "x", sessionId: "s1" }],
    });
    h.storage.createEpisode.mockRejectedValueOnce(new Error("injected"));

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("too_few_turns");
  });
});

describe("Review round — the provenance episode is atomic and single-winner", () => {
  const seed = [
    { statement: "orders-api uses Redis 7", sessionId: "s1" },
    { statement: "deploys need two approvals", sessionId: "s1" },
  ];

  it("two concurrent skips of one session write one episode", async () => {
    const h = makeHarness({ replies: [reply({})], turns: 0, atomic: true, seedFacts: seed });

    await Promise.all([collapseSession(input, h.ctx, auth), collapseSession(input, h.ctx, auth)]);

    expect(h.episodes).toHaveLength(1);
  });

  it("archives the session in the same commit", async () => {
    const h = makeHarness({ replies: [reply({})], turns: 0, atomic: true, seedFacts: seed });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.archived).toBe(true);
    expect(h.session.status).toBe("archived");
    expect(h.storage.commitSessionCollapse).toHaveBeenCalledWith(
      expect.objectContaining({ terminalStatus: "archived", archiveReason: "too_few_turns" }),
      expect.any(Function)
    );
  });

  it("a link failure leaves no orphan episode, and the skip still happens", async () => {
    const h = makeHarness({ replies: [reply({})], turns: 0, atomic: true, seedFacts: seed });
    h.storage.linkSessionFactsToEpisode.mockRejectedValueOnce(new Error("injected"));

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("skipped");
    expect(result.archived).toBeUndefined();
    expect(h.episodes).toHaveLength(0);
  });
});
