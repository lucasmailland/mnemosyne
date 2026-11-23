import { describe, it, expect, vi } from "vitest";
import { runReflectionCycle } from "../self-reflect.js";

function fakeCtx(over: any = {}) {
  const updateWorth = vi.fn().mockResolvedValue(undefined);
  const createEpisode = vi.fn().mockResolvedValue({ id: "ep-1" });
  const upsertAgentProfile = vi.fn().mockResolvedValue({
    workspaceId: "ws1",
    agentId: "a1",
    summary: "S",
    metadata: {},
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  }); // determinism-ok: throwaway fixture date, not asserted
  return {
    ctx: {
      storage: {
        queryEpisodes: vi.fn().mockResolvedValue({
          items: [
            {
              id: "c1",
              narrative: "session 1",
              metadata: { strategiesUsed: ["s-good"], outcome: "success" },
            },
            {
              id: "c2",
              narrative: "session 2",
              metadata: { strategiesUsed: ["s-bad"], outcome: "fail" },
            },
          ],
          total: 2,
          offset: 0,
          limit: 10,
          hasMore: false,
        }),
        updateWorth,
        createEpisode,
        upsertAgentProfile,
        incrementSessionsSinceReflection: vi.fn(),
        ...over.storage,
      },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
      telemetry: { startSpan: () => ({ end() {} }) },
    },
    updateWorth,
    createEpisode,
    upsertAgentProfile,
  };
}

describe("runReflectionCycle (spec §13 self-reflection pipeline)", () => {
  it("strengthens strategies from successful sessions and weakens from failed ones", async () => {
    const { ctx, updateWorth } = fakeCtx();
    await runReflectionCycle(ctx as any, { workspaceId: "ws1", scopes: [] } as any, "a1");
    expect(updateWorth).toHaveBeenCalledWith(
      "s-good",
      "ws1",
      "strategy",
      expect.objectContaining({ success: 1 })
    );
    expect(updateWorth).toHaveBeenCalledWith(
      "s-bad",
      "ws1",
      "strategy",
      expect.objectContaining({ failure: 1 })
    );
  });

  it("logs the reflection as an Episode and rewrites the profile summary", async () => {
    const { ctx, createEpisode, upsertAgentProfile } = fakeCtx();
    await runReflectionCycle(ctx as any, { workspaceId: "ws1", scopes: [] } as any, "a1");
    expect(createEpisode).toHaveBeenCalledTimes(1);
    expect(upsertAgentProfile).toHaveBeenCalledTimes(1);
  });

  it("resets sessionsSinceReflection to 0 after running", async () => {
    const { ctx, upsertAgentProfile } = fakeCtx();
    await runReflectionCycle(ctx as any, { workspaceId: "ws1", scopes: [] } as any, "a1");
    const call = upsertAgentProfile.mock.calls.at(-1)![0];
    expect(call.metadata.sessionsSinceReflection).toBe(0);
  });
});

// ─── Step-2 branch extensions ─────────────────────────────────────────────────

describe("runReflectionCycle — step-2 branch extensions (spec §13)", () => {
  it("calls archiveFact for each id listed in an episode's metadata.factsContradicted", async () => {
    const archiveFact = vi.fn().mockResolvedValue(undefined);
    const { ctx } = fakeCtx({
      storage: {
        queryEpisodes: vi.fn().mockResolvedValue({
          items: [
            {
              id: "ep-contradicted",
              narrative: "contradicted session",
              metadata: {
                strategiesUsed: [],
                outcome: "success",
                factsContradicted: ["fact-x", "fact-y"],
              },
            },
          ],
          total: 1,
          offset: 0,
          limit: 10,
          hasMore: false,
        }),
        archiveFact,
      },
    });
    await runReflectionCycle(ctx as any, { workspaceId: "ws1", scopes: [] } as any, "a1");
    expect(archiveFact).toHaveBeenCalledWith("fact-x", "ws1");
    expect(archiveFact).toHaveBeenCalledWith("fact-y", "ws1");
  });

  // P111: this used to assert an `appendOutbox` of a `flag_missing_knowledge`
  // queue_job. No handler was ever registered for that job and its payload was
  // written flat, so the gaps were computed and discarded — the test passed
  // while the feature did nothing. It now asserts the durable destination.
  it("enqueues a review item for the episode when metadata has missingKnowledge", async () => {
    const enqueueReviewItem = vi.fn().mockResolvedValue(undefined);
    const appendOutbox = vi.fn().mockResolvedValue(undefined);
    const { ctx } = fakeCtx({
      storage: {
        queryEpisodes: vi.fn().mockResolvedValue({
          items: [
            {
              id: "ep-missing",
              narrative: "missing knowledge session",
              metadata: {
                strategiesUsed: [],
                outcome: "success",
                missingKnowledge: ["topic-y", "topic-z"],
              },
            },
          ],
          total: 1,
          offset: 0,
          limit: 10,
          hasMore: false,
        }),
        enqueueReviewItem,
        appendOutbox,
      },
    });
    await runReflectionCycle(ctx as any, { workspaceId: "ws1", scopes: [] } as any, "a1");
    expect(enqueueReviewItem).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        primitiveId: "ep-missing",
        primitiveKind: "episode",
        reason: "missing_knowledge",
        detail: expect.objectContaining({ topics: ["topic-y", "topic-z"] }),
      })
    );
    // Regression guard: it must not go back to the orphaned queue job.
    expect(appendOutbox).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ job: "flag_missing_knowledge" }),
      })
    );
  });

  it("calls createStrategy with ALTERNATIVE action when a failed episode has a strategyId", async () => {
    const createStrategy = vi.fn().mockResolvedValue({ id: "alt-st" });
    const { ctx } = fakeCtx({
      storage: {
        queryEpisodes: vi.fn().mockResolvedValue({
          items: [
            {
              id: "ep-failed",
              narrative: "failed session",
              metadata: {
                strategiesUsed: ["s-bad"],
                outcome: "fail",
                strategyId: "s-bad",
                strategyTrigger: "user-request",
              },
            },
          ],
          total: 1,
          offset: 0,
          limit: 10,
          hasMore: false,
        }),
        createStrategy,
      },
    });
    await runReflectionCycle(ctx as any, { workspaceId: "ws1", scopes: [] } as any, "a1");
    expect(createStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        agentId: "a1",
        action: expect.stringContaining("ALTERNATIVE"),
      })
    );
  });
});
