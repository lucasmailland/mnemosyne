/**
 * LIFECYCLE-7 / LIFECYCLE-8 — the collapse writes once, and all of it or none.
 *
 * LIFECYCLE-8: the file header promised "atomic persist" while every write
 * committed on its own. With a fault injected at the first `createStrategy`,
 * six facts and a decision stayed live with no episode, relations or summary;
 * the retry then extracted again and wrote paraphrased duplicates beside them.
 * The episode, its fact links and the summary were also "non-fatal": a failure
 * there produced a `completed` collapse missing the artefacts recall reads.
 *
 * LIFECYCLE-7: nothing checked the session's status. Collapsing twice
 * (sequentially or concurrently) produced a second episode and duplicate
 * decisions and strategies.
 *
 * Here the pipeline is driven against a double with a transactional
 * `commitSessionCollapse` (rollback = restore every map); the Postgres
 * implementation is proven in the server's collapse-integrity integration test.
 */
import { describe, it, expect, vi } from "vitest";
import { collapseSession } from "../collapse.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

const input = { sessionId: "s1", workspaceId: "ws", reason: "explicit" as const };

const EXTRACTION = reply({
  facts: [
    { content: "session tokens are cached in Redis for 15 minutes" },
    { content: "revoked tokens are deleted from the cache" },
  ],
  decisions: [{ title: "Shorten the token TTL", body: "revocation lag", kind: "decision" }],
  strategies: [{ trigger: "a token is revoked", action: "delete it from Redis" }],
});

describe("LIFECYCLE-7 — a collapsed session is not extracted again", () => {
  it("returns without calling the model or writing anything", async () => {
    const h = makeHarness({ replies: [EXTRACTION], sessionStatus: "collapsed" });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(result.alreadyCollapsed).toBe(true);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.storage.createFact).not.toHaveBeenCalled();
    expect(h.storage.createEpisode).not.toHaveBeenCalled();
  });

  it("a second sequential collapse writes nothing new", async () => {
    const h = makeHarness({ replies: [EXTRACTION], atomic: true });

    await collapseSession(input, h.ctx, auth);
    const second = await collapseSession(input, h.ctx, auth);

    expect(second.alreadyCollapsed).toBe(true);
    expect(h.episodes).toHaveLength(1);
    expect(h.activeDecisions()).toHaveLength(1);
    expect(h.strategies).toHaveLength(1);
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("two concurrent collapses produce one extraction set", async () => {
    const h = makeHarness({ replies: [EXTRACTION], atomic: true });

    const results = await Promise.all([
      collapseSession(input, h.ctx, auth),
      collapseSession(input, h.ctx, auth),
    ]);

    expect(results.filter((r) => r.alreadyCollapsed)).toHaveLength(1);
    expect(h.episodes).toHaveLength(1);
    expect(h.activeFacts()).toHaveLength(2);
    expect(h.activeDecisions()).toHaveLength(1);
    expect(h.strategies).toHaveLength(1);
  });

  it("the loser of a race runs none of the post-commit steps", async () => {
    const h = makeHarness({ replies: [EXTRACTION], atomic: true });
    h.storage.commitSessionCollapse!.mockResolvedValueOnce({
      committed: false,
      status: "collapsed",
    });
    const updateWorth = vi.fn(async () => {});
    (h.ctx.storage as unknown as Record<string, unknown>).updateWorth = updateWorth;

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.alreadyCollapsed).toBe(true);
    expect(updateWorth).not.toHaveBeenCalled();
    expect(h.storage.closeSession).not.toHaveBeenCalled();
  });

  it("an archived (skipped) session can still be collapsed explicitly", async () => {
    const h = makeHarness({ replies: [EXTRACTION], atomic: true, sessionStatus: "archived" });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.alreadyCollapsed).toBeUndefined();
    expect(result.factsCreated).toBe(2);
    expect(h.session.status).toBe("collapsed");
  });
});

describe("LIFECYCLE-8 — persistence is all or nothing", () => {
  it("a mid-persist failure leaves no extracted rows and the session open", async () => {
    const h = makeHarness({ replies: [EXTRACTION], atomic: true });
    h.storage.createStrategy.mockRejectedValueOnce(new Error("injected: strategy insert failed"));

    await expect(collapseSession(input, h.ctx, auth)).rejects.toThrow(/injected/);

    expect(h.activeFacts()).toHaveLength(0);
    expect(h.activeDecisions()).toHaveLength(0);
    expect(h.episodes).toHaveLength(0);
    expect(h.session.status).toBe("active");
  });

  it("the retry after a rollback writes exactly one complete set", async () => {
    const h = makeHarness({ replies: [EXTRACTION], atomic: true });
    h.storage.createStrategy.mockRejectedValueOnce(new Error("injected"));
    await expect(collapseSession(input, h.ctx, auth)).rejects.toThrow();

    const retry = await collapseSession(input, h.ctx, auth);

    expect(retry.status).toBe("completed");
    expect(h.activeFacts()).toHaveLength(2);
    expect(h.activeDecisions()).toHaveLength(1);
    expect(h.strategies).toHaveLength(1);
    expect(h.episodes).toHaveLength(1);
    expect(h.session.status).toBe("collapsed");
  });

  it("an episode failure is no longer a 'completed' collapse without an episode", async () => {
    const h = makeHarness({ replies: [EXTRACTION], atomic: true });
    h.storage.createEpisode.mockRejectedValueOnce(new Error("injected: episode insert failed"));

    await expect(collapseSession(input, h.ctx, auth)).rejects.toThrow(/episode/);

    expect(h.activeFacts()).toHaveLength(0);
    expect(h.session.status).toBe("active");
  });

  it("a summary failure rolls the collapse back too", async () => {
    const h = makeHarness({ replies: [EXTRACTION], atomic: true });
    h.storage.updateSessionSummary.mockRejectedValueOnce(new Error("injected: summary failed"));

    await expect(collapseSession(input, h.ctx, auth)).rejects.toThrow(/summary/);

    expect(h.activeFacts()).toHaveLength(0);
    expect(h.episodes).toHaveLength(0);
  });

  it("writes go through the transaction's adapter and the commit closes the session", async () => {
    const h = makeHarness({ replies: [EXTRACTION], atomic: true });

    await collapseSession(input, h.ctx, auth);

    expect(h.storage.commitSessionCollapse).toHaveBeenCalledTimes(1);
    expect(h.storage.closeSession).not.toHaveBeenCalled();
    expect(h.session.status).toBe("collapsed");
  });
});

describe("Review round — topic locks are declared up front", () => {
  it("passes every keyed fact and decision topic to the commit", async () => {
    const h = makeHarness({
      atomic: true,
      replies: [
        reply({
          facts: [
            { content: "B value", topicKey: "topic-b" },
            { content: "A value", topicKey: "topic-a" },
            { content: "no key" },
          ],
          decisions: [{ title: "D", body: "why", kind: "decision", topicKey: "Topic-D" }],
        }),
      ],
    });

    await collapseSession(input, h.ctx, auth);

    expect(h.storage.commitSessionCollapse).toHaveBeenCalledWith(
      expect.objectContaining({
        topicLocks: { facts: ["topic-b", "topic-a"], decisions: ["Topic-D"] },
      }),
      expect.any(Function)
    );
  });
});
