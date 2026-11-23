import { describe, it, expect, vi } from "vitest";
import { autoExtractOnCompletion } from "../tasks.js";
import type { MnemoTask } from "@mnemo-ai/types";

function mkTask(over: Partial<MnemoTask> = {}): MnemoTask {
  return {
    id: "task-1", workspaceId: "ws1", title: "Fix billing webhook timeout",
    status: "completed", priority: "medium", assignedTo: "agent-b",
    blockedBy: [], subtaskIds: [], relatedFacts: [], relatedEntities: [],
    outcome: "Fixed by increasing timeout to 30s",
    lessonsLearned: "Always check timeout config first",
    createdAt: new Date(), updatedAt: new Date(), metadata: {}, // determinism-ok: throwaway fixture date, not asserted
    ...over,
  } as MnemoTask;
}

describe("autoExtractOnCompletion (spec §18 auto-extraction)", () => {
  it("creates a strategy, a fact, an episode, AND a MnemoEvent, and links them", async () => {
    const createStrategy = vi.fn().mockResolvedValue({ id: "strat-1" });
    const createFact     = vi.fn().mockResolvedValue({ id: "fact-1" });
    const createEpisode  = vi.fn().mockResolvedValue({ id: "ep-1" });
    const createRelation = vi.fn().mockResolvedValue({ id: "rel-1" });
    const createEvent    = vi.fn().mockResolvedValue({ id: "evt-1" });
    const storage = { createStrategy, createFact, createEpisode, createRelation, createEvent } as any;

    const r = await autoExtractOnCompletion(storage, mkTask());

    expect(createStrategy).toHaveBeenCalledOnce();
    expect(createStrategy.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws1", action: "Always check timeout config first",
    });
    expect(createFact).toHaveBeenCalledOnce();
    expect(createFact.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws1", statement: "Fixed by increasing timeout to 30s", subject: "Fix billing webhook timeout",
    });
    expect(createEpisode).toHaveBeenCalledOnce();
    expect(createEpisode.mock.calls[0][0].linkedFactIds).toContain("fact-1");
    // F26: spec §18 example emits an Event on completion in addition to the Episode.
    expect(createEvent).toHaveBeenCalledOnce();
    expect(createEvent.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws1", type: "agent", name: "task.completed", source: "task_auto_extract",
    });
    expect(createRelation).toHaveBeenCalled();
    expect(r).toEqual({ strategyId: "strat-1", factId: "fact-1", episodeId: "ep-1", eventId: "evt-1" });
  });

  it("is a no-op when neither outcome nor lessonsLearned is present", async () => {
    const storage = { createStrategy: vi.fn(), createFact: vi.fn(), createEpisode: vi.fn(), createRelation: vi.fn(), createEvent: vi.fn() } as any;
    const r = await autoExtractOnCompletion(storage, mkTask({ outcome: undefined, lessonsLearned: undefined }));
    expect(storage.createStrategy).not.toHaveBeenCalled();
    expect(storage.createFact).not.toHaveBeenCalled();
    expect(r).toBeNull();
  });

  it("creates only a fact when lessonsLearned is absent", async () => {
    const createFact = vi.fn().mockResolvedValue({ id: "fact-9" });
    const createEpisode = vi.fn().mockResolvedValue({ id: "ep-9" });
    const createRelation = vi.fn().mockResolvedValue({ id: "rel-9" });
    const createEvent = vi.fn().mockResolvedValue({ id: "evt-9" });
    const storage = { createStrategy: vi.fn(), createFact, createEpisode, createRelation, createEvent } as any;
    const r = await autoExtractOnCompletion(storage, mkTask({ lessonsLearned: undefined }));
    expect(storage.createStrategy).not.toHaveBeenCalled();
    expect(createFact).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ strategyId: null, factId: "fact-9" });
  });
});
