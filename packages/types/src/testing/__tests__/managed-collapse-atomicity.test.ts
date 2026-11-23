import { describe, it, expect, vi } from "vitest";
import {
  canonicalJson,
  sha256Hex,
  type HarnessEvent,
  type ManagedPreparedCollapsePlan,
  type ManagedSessionProvenance,
} from "../../index.js";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";
const WS_A = "55555555-5555-4555-8555-555555555555";
function planFor(sessionId: string): ManagedPreparedCollapsePlan {
  const operationId = `managed:${WS_A}:${sessionId}:0`;
  const sourceMessageIds = ["m-user", "m-assistant"];
  const provenance: ManagedSessionProvenance = {
    actorId: "key:test",
    actorType: "agent",
    userId: null,
    sensitivityCeiling: "internal",
  };
  const common = {
    workspaceId: WS_A,
    actorId: provenance.actorId,
    actorType: "agent" as const,
    sensitivity: "internal" as const,
  };
  return {
    status: "prepared",
    operationId,
    workspaceId: WS_A,
    sessionId,
    generation: 0,
    sourceMessageIds,
    sensitivity: "internal",
    provenance,
    candidates: [
      ...[0, 1, 2].map((n) => ({
        id: `candidate-f${n}`,
        kind: "fact" as const,
        sourceMessageIds,
        sensitivity: "internal" as const,
        topicKey: `topic-${n}`,
        input: {
          ...common,
          scope: "global" as const,
          statement: `Fact ${n}`,
          subject: "project",
          kind: "other" as const,
          confidence: 0.8,
          topicKey: `topic-${n}`,
          sessionId,
          sourceMessageIds,
          extractionSource: "collapse" as const,
        },
      })),
      {
        id: "candidate-d",
        kind: "decision",
        sourceMessageIds,
        sensitivity: "internal",
        topicKey: "decision-topic",
        input: {
          ...common,
          kind: "architecture",
          title: "Decision",
          body: "Use PostgreSQL",
          topicKey: "decision-topic",
        },
      },
      {
        id: "candidate-s",
        kind: "strategy",
        sourceMessageIds,
        sensitivity: "internal",
        input: { ...common, trigger: "When offline", action: "Queue locally" },
      },
    ],
    episode: {
      id: "candidate-episode",
      sourceMessageIds,
      sensitivity: "internal",
      input: {
        ...common,
        title: "Session",
        narrative: "Completed work",
        occurredAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
        sourceConversationId: sessionId,
      },
    },
    rejectedCandidates: [],
    linkSessionFacts: true,
    relations: [
      {
        id: "rel-1",
        sourceId: "candidate-f0",
        sourceType: "fact",
        targetId: "candidate-f1",
        targetType: "fact",
        verb: "related",
      },
    ],
    hyperedges: [
      {
        id: "hyper-1",
        description: "Project facts",
        memberIds: ["candidate-f0", "candidate-f1", "candidate-f2"],
        label: "project",
      },
    ],
    worthUpdates: [{ factId: "candidate-f0", delta: { success: 1, failure: 0, creditWeight: 1 } }],
    counters: { factCount: 3, sessionCount: 1 },
    summary: {
      goal: "Session",
      outcome: "success",
      discoveries: [],
      relevantEntities: [],
      nextSteps: [],
      keyDecisions: [],
      turnsProcessed: 2,
      pinsUsed: 1,
      llmTokensUsed: 100,
      collapseReason: "authoritative",
      episodeId: "candidate-episode",
    },
    indexJobs: [],
    postCommitEffects: [
      {
        effectKind: "session_buffer_cleanup",
        targetKind: "session",
        targetId: sessionId,
        payload: { sessionId },
      },
      {
        effectKind: "bus_delivery",
        targetKind: "session",
        targetId: sessionId,
        payload: { event: "session.collapsed" },
      },
      {
        effectKind: "llm_usage_telemetry",
        targetKind: "session",
        targetId: sessionId,
        payload: { status: "collapsed" },
      },
    ],
  };
}

async function ready() {
  const storage = new InMemoryStorageAdapter();
  const provenance: ManagedSessionProvenance = {
    actorId: "key:test",
    actorType: "agent",
    userId: null,
    sensitivityCeiling: "internal",
  };
  let sessionId = "";
  for (const [n, body] of [
    { type: "session.start" },
    {
      type: "turn.append",
      sourceGeneration: 0,
      hostMessageId: "m-user",
      role: "user",
      content: "Visible",
      contentHash: sha256Hex("Visible"),
    },
    {
      type: "turn.append",
      sourceGeneration: 0,
      hostMessageId: "m-assistant",
      role: "assistant",
      content: "Visible",
      contentHash: sha256Hex("Visible"),
    },
  ].entries()) {
    const base = {
      eventId: `event-${n}`,
      host: "opencode",
      clientInstanceId: "client",
      hostSessionId: "source",
      enqueueSequence: n + 1,
      occurredAt: new Date().toISOString(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
      normalizationVersion: 1,
      ...body,
    };
    const event = { ...base, payloadHash: sha256Hex(canonicalJson(base)) } as HarnessEvent;
    const ack = await storage.ingestHarnessEvent({
      workspaceId: WS_A,
      provenance,
      event,
      receivedAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
    });
    expect(ack.status).toBe("accepted");
    sessionId = ack.sessionId!;
  }
  await storage.setHarnessSessionLifecycle(WS_A, {
    generation: 0,
    status: "collapse_pending",
    closeKind: "authoritative",
    closeGraceDeadline: new Date(0),
  });
  await storage.claimManagedSessions({
    workspaceId: WS_A,
    leaseOwner: "worker",
    limit: 1,
    inactivityMs: 60_000,
    provisionalGraceMs: 0,
    leaseMs: 30_000,
  });
  const input = {
    workspaceId: WS_A,
    sessionId,
    generation: 0,
    operationId: planFor(sessionId).operationId,
    leaseOwner: "worker",
    plan: planFor(sessionId),
  };
  const turns = await storage.listManagedCollapseTurns(sessionId, WS_A);
  const ids = turns.map((t) => t.sourceMessageId!);
  input.plan.sourceMessageIds = ids;
  input.plan.episode.sourceMessageIds = ids;
  for (const c of input.plan.candidates) c.sourceMessageIds = ids;
  return { storage, input };
}
describe("in-memory atomic managed collapse", () => {
  it("persists one complete output and concurrent retries return the same result", async () => {
    const { storage, input } = await ready();
    const result = await storage.commitManagedCollapse(input);
    expect(result.status).toBe("collapsed");
    expect(
      await Promise.all([
        storage.commitManagedCollapse(input),
        storage.commitManagedCollapse(input),
      ])
    ).toEqual([result, result]);
    expect((await storage.queryFacts({ workspaceId: WS_A })).items).toHaveLength(3);
    expect((await storage.queryEpisodes({ workspaceId: WS_A })).items).toHaveLength(1);
    expect((await storage.getSession(input.sessionId, WS_A))?.status).toBe("collapsed");
    expect(await storage.getWorkspaceMode(WS_A)).toMatchObject({ sessionCount: 1, factCount: 3 });
  });
  it("rejects invalid support and stale leases without partial output", async () => {
    const { storage, input } = await ready();
    input.plan.candidates[1]!.sourceMessageIds = ["not-visible"];
    await expect(storage.commitManagedCollapse(input)).rejects.toThrow();
    expect((await storage.queryFacts({ workspaceId: WS_A })).items).toHaveLength(0);
    expect((await storage.queryEpisodes({ workspaceId: WS_A })).items).toHaveLength(0);
    input.plan.candidates[1]!.sourceMessageIds = input.plan.sourceMessageIds;
    await expect(
      storage.commitManagedCollapse({ ...input, leaseOwner: "wrong" })
    ).rejects.toThrow();
    await expect(storage.commitManagedCollapse(input)).resolves.toMatchObject({
      status: "collapsed",
    });
  });
  it("commits one episode even with zero new candidates", async () => {
    const { storage, input } = await ready();
    input.plan.candidates = [];
    input.plan.relations = [];
    input.plan.hyperedges = [];
    input.plan.worthUpdates = [];
    const result = await storage.commitManagedCollapse(input);
    expect(result.episodeId).toMatch(/^mepi_/);
    expect((await storage.queryEpisodes({ workspaceId: WS_A })).items).toHaveLength(1);
    expect(await storage.getWorkspaceMode(WS_A)).toMatchObject({ sessionCount: 1, factCount: 0 });
  });
  it("atomically archives a skipped plan and replays its stored result", async () => {
    const { storage, input } = await ready();
    const plan = { ...input.plan, status: "archive" as const, reason: "no_pin" as const };
    const result = await storage.commitManagedCollapse({ ...input, plan });
    expect(result).toMatchObject({ status: "archived", reason: "no_pin" });
    expect(await storage.commitManagedCollapse({ ...input, plan })).toEqual(result);
    expect((await storage.getSession(input.sessionId, WS_A))?.status).toBe("archived");
    expect((await storage.queryEpisodes({ workspaceId: WS_A })).items).toHaveLength(0);
  });
  it("preserves a stricter topic and omits a rejected candidate from effects", async () => {
    const { storage, input } = await ready();
    const prior = await storage.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Restricted existing",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
      sensitivity: "restricted",
    });
    input.plan.postCommitEffects.push({
      effectKind: "td_credit",
      targetKind: "fact",
      targetId: "candidate-f0",
      payload: { credit: 1 },
    });
    const result = await storage.commitManagedCollapse(input);
    expect(result).toMatchObject({ status: "collapsed", rejectedCount: 1 });
    expect((await storage.getFact(prior.id, WS_A))?.status).toBe("active");
    const state = (
      storage as unknown as { state: { managedCollapseEffects: Array<{ targetId?: string }> } }
    ).state;
    expect(state.managedCollapseEffects.some((e) => e.targetId === "candidate-f0")).toBe(false);
  });
  it("rolls back an exception after facts, decisions and episode were prepared", async () => {
    const { storage, input } = await ready();
    const failure = vi
      .spyOn(InMemoryStorageAdapter.prototype, "createHyperedge")
      .mockRejectedValueOnce(new Error("late failpoint"));
    try {
      await expect(storage.commitManagedCollapse(input)).rejects.toThrow("late failpoint");
    } finally {
      failure.mockRestore();
    }
    expect((await storage.queryFacts({ workspaceId: WS_A })).items).toHaveLength(0);
    expect((await storage.queryEpisodes({ workspaceId: WS_A })).items).toHaveLength(0);
    expect((await storage.getSession(input.sessionId, WS_A))?.status).toBe("collapse_pending");
    await expect(storage.commitManagedCollapse(input)).resolves.toMatchObject({
      status: "collapsed",
    });
  });
  it("never closes a topic when this correction retracts its source", async () => {
    const { storage, input } = await ready();
    const prior = await storage.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Mixed fact",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
    });
    const state = (
      storage as unknown as { state: import("../in-memory/state.js").InMemoryStorageState }
    ).state;
    state.harnessRetractions.push({
      workspaceId: WS_A,
      sessionId: input.sessionId,
      sourceMessageId: "old-source",
      predecessorSessionId: "predecessor",
      eventId: "retraction",
    });
    state.managedProvenance.push({
      workspaceId: WS_A,
      sessionId: "predecessor",
      operationId: "old-operation",
      primitiveKind: "fact",
      primitiveId: prior.id,
      sourceMessageIds: ["old-source", "another-source"],
      sensitivity: "internal",
    });
    await storage.commitManagedCollapse(input);
    expect((await storage.getFact(prior.id, WS_A))?.status).toBe("active");
    expect(state.reviewItems).toContainEqual(
      expect.objectContaining({
        primitiveId: prior.id,
        detail: expect.objectContaining({ mixedSource: true }),
      })
    );
  });
  it("archives a retraction-only correction but still queues supported knowledge for review", async () => {
    const { storage, input } = await ready();
    const prior = await storage.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Mixed fact",
      subject: "project",
      kind: "other",
    });
    const state = (
      storage as unknown as { state: import("../in-memory/state.js").InMemoryStorageState }
    ).state;
    state.harnessRetractions.push({
      workspaceId: WS_A,
      sessionId: input.sessionId,
      sourceMessageId: "old-source",
      predecessorSessionId: "predecessor",
      eventId: "retraction",
    });
    state.managedProvenance.push({
      workspaceId: WS_A,
      sessionId: "predecessor",
      operationId: "old-operation",
      primitiveKind: "fact",
      primitiveId: prior.id,
      sourceMessageIds: ["old-source"],
      sensitivity: "internal",
    });
    await storage.commitManagedCollapse({
      ...input,
      plan: { ...input.plan, status: "archive", reason: "empty_session" },
    });
    expect(state.reviewItems).toContainEqual(
      expect.objectContaining({ primitiveId: prior.id, reason: "managed_source_retracted" })
    );
    expect((await storage.getFact(prior.id, WS_A))?.status).toBe("active");
  });

  it("scrubs episode and summary after a commit-time sensitivity rejection", async () => {
    const { storage, input } = await ready();
    await storage.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Higher tier",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
      sensitivity: "restricted",
    });
    input.plan.episode.input.narrative = "REFLECTED_SECRET";
    input.plan.summary.discoveries = ["REFLECTED_SECRET"];
    const result = await storage.commitManagedCollapse(input);
    if (result.status !== "collapsed") throw new Error("fixture");
    expect(JSON.stringify(await storage.getEpisode(result.episodeId, WS_A))).not.toContain(
      "REFLECTED_SECRET"
    );
    expect(JSON.stringify(await storage.getSession(input.sessionId, WS_A))).not.toContain(
      "REFLECTED_SECRET"
    );
  });
  it("rejects a consolidation-pending topic without touching it", async () => {
    const { storage, input } = await ready();
    const prior = await storage.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Pending",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
    });
    const state = (
      storage as unknown as { state: import("../in-memory/state.js").InMemoryStorageState }
    ).state;
    state.facts.get(prior.id)!.metadata.__mnemoConsolidationPending = true;
    await expect(storage.commitManagedCollapse(input)).rejects.toThrow();
    expect((await storage.getFact(prior.id, WS_A))?.status).toBe("active");
  });
  it("refuses a delta link whose parent classification changed since preparation", async () => {
    const { storage, input } = await ready();
    const parent = await storage.createEpisode({
      workspaceId: WS_A,
      title: "Private",
      narrative: "Higher tier",
      occurredAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
      sensitivity: "restricted",
    });
    input.plan.episode.input.parentEpisodeId = parent.id;
    input.plan.episode.input.deltaContent = "private delta";
    await expect(storage.commitManagedCollapse(input)).rejects.toThrow();
    expect((await storage.queryFacts({ workspaceId: WS_A })).items).toHaveLength(0);
  });
});
