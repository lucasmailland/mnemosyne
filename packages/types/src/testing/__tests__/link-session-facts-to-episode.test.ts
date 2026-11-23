import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

// P109 — `mnemo_fact.episode_id` and its FK to `mnemo_episode` have existed
// since the baseline migration, and `preferSourceEpisode` (recall-cold.ts,
// spec §17 "prefer source episode") reads that column on every cold recall.
// Nothing ever wrote it: the episode is created at collapse step 7.5, after the
// facts, and recorded the link only on its own side (`linkedFactIds`). The
// enrichment was fully implemented and permanently inert.
//
// These guards pin the write side. Keying on sessionId rather than an id list
// is the point: it covers the facts an agent wrote mid-session through
// remember(), which are precisely the ones carrying no clue about what the
// session was about.

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";

async function seedFact(
  adapter: InMemoryStorageAdapter,
  opts: { workspaceId?: string; sessionId?: string; statement: string }
) {
  return adapter.createFact({
    workspaceId: opts.workspaceId ?? WS,
    statement: opts.statement,
    subject: "workspace",
    kind: "other",
    scope: "global",
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  } as never);
}

describe("linkSessionFactsToEpisode (P109)", () => {
  it("links every fact of the session, not just the ones collapse extracted", async () => {
    const adapter = new InMemoryStorageAdapter();
    const written = await seedFact(adapter, { sessionId: "s-1", statement: "written mid-session" });
    const extracted = await seedFact(adapter, {
      sessionId: "s-1",
      statement: "extracted at collapse",
    });

    const linked = await adapter.linkSessionFactsToEpisode(WS, "s-1", "ep-1");

    expect(linked).toBe(2);
    expect((await adapter.getFact(written.id, WS))?.episodeId).toBe("ep-1");
    expect((await adapter.getFact(extracted.id, WS))?.episodeId).toBe("ep-1");
  });

  it("leaves facts from other sessions alone", async () => {
    const adapter = new InMemoryStorageAdapter();
    const mine = await seedFact(adapter, { sessionId: "s-1", statement: "mine" });
    const theirs = await seedFact(adapter, { sessionId: "s-2", statement: "theirs" });

    const linked = await adapter.linkSessionFactsToEpisode(WS, "s-1", "ep-1");

    expect(linked).toBe(1);
    expect((await adapter.getFact(mine.id, WS))?.episodeId).toBe("ep-1");
    expect((await adapter.getFact(theirs.id, WS))?.episodeId).toBeUndefined();
  });

  it("never re-points a fact already bound to an episode", async () => {
    const adapter = new InMemoryStorageAdapter();
    const f = await seedFact(adapter, { sessionId: "s-1", statement: "already linked" });

    await adapter.linkSessionFactsToEpisode(WS, "s-1", "ep-1");
    const second = await adapter.linkSessionFactsToEpisode(WS, "s-1", "ep-2");

    // Re-running a collapse must not steal facts from the first episode.
    expect(second).toBe(0);
    expect((await adapter.getFact(f.id, WS))?.episodeId).toBe("ep-1");
  });

  it("does not cross workspaces even for an identical session id", async () => {
    const adapter = new InMemoryStorageAdapter();
    const other = await seedFact(adapter, {
      workspaceId: OTHER_WS,
      sessionId: "s-1",
      statement: "another tenant",
    });

    const linked = await adapter.linkSessionFactsToEpisode(WS, "s-1", "ep-1");

    expect(linked).toBe(0);
    expect((await adapter.getFact(other.id, OTHER_WS))?.episodeId).toBeUndefined();
  });

  it("reports zero for a session that produced no facts", async () => {
    const adapter = new InMemoryStorageAdapter();
    expect(await adapter.linkSessionFactsToEpisode(WS, "s-empty", "ep-1")).toBe(0);
  });
});
