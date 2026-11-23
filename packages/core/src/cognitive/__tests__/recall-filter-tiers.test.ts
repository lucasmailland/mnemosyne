import { describe, expect, it, vi } from "vitest";
import type {
  AuthContext,
  MnemoDecision,
  MnemoEntity,
  MnemoEpisode,
  MnemoEvent,
  MnemoFact,
  MnemoReasoning,
  MnemoSkill,
  MnemoStrategy,
  MnemoTask,
  MnemoWorkflow,
  PointerCandidate,
  RecallFilter,
} from "@mnemo-ai/types";
import { tryHotTier, hotTierKey } from "../recall-hot.js";
import { tryPointerTier } from "../recall-pointer.js";
import { expandHyperedgeMembers, ftsFallbackRecall, recallCold } from "../recall-cold.js";

const NOW = new Date("2026-07-17T12:00:00Z");
const AUTH = {
  workspaceId: "ws",
  actorId: "caller",
  actorType: "agent",
  scopes: ["memory:read"],
  maxSensitivity: "internal",
} as AuthContext;

function fact(id: string, overrides: Partial<MnemoFact> = {}): MnemoFact {
  return {
    id,
    workspaceId: "ws",
    actorId: "actor-1",
    scope: "global",
    scopeRef: "project-1",
    statement: `statement ${id}`,
    subject: "recall",
    kind: "other",
    confidence: 0.9,
    relevance: 1,
    hitCount: 0,
    worthSuccess: 20,
    worthFailure: 1,
    worthAlpha: 20,
    worthBeta: 2,
    worth: 0.9,
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    attribution: "user_stated",
    sourceMessageIds: [],
    revisionCount: 1,
    protocolVersion: "3.0",
    status: "active",
    pinned: false,
    canonical: false,
    sensitivity: "internal",
    validFrom: NOW,
    embeddingStale: false,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: { tags: ["typescript"] },
    ...overrides,
  };
}

function baseCtx() {
  return {
    telemetry: {
      startSpan: () => ({ end() {}, setAttribute() {} }),
      histogram() {},
      counter() {},
      gauge() {},
      async shutdown() {},
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      child() {
        return this;
      },
    },
    config: { maxHotTierSize: 1000 },
    outbox: { append: vi.fn(async () => undefined) },
  };
}

function candidateFromFact(f: MnemoFact): PointerCandidate {
  return {
    factId: f.id,
    statement: f.statement,
    embedding: (f as { embedding?: number[] }).embedding ?? null,
    sensitivity: f.sensitivity,
    worth: f.worth,
    worthAlpha: f.worthAlpha,
    worthBeta: f.worthBeta,
    attribution: f.attribution,
    createdAt: f.createdAt,
    validFrom: f.validFrom,
    validTo: f.validTo ?? null,
    status: f.status,
    confidence: f.confidence,
    tags: Array.isArray(f.metadata.tags) ? (f.metadata.tags as string[]) : [],
    scope: f.scope,
    scopeRef: f.scopeRef,
    actorId: f.actorId ?? null,
    entityId: f.entityId,
    sessionId: f.sessionId,
  };
}

describe("canonical recall filters across tiers", () => {
  it("hyperedge members enforce lifecycle, worth, filters, sensitivity, includeLowWorth, and preserve tags", async () => {
    const member = fact("member", { metadata: { tags: ["real-tag"] } });
    const lowEvidence = fact("low-evidence", { worth: 0.9, worthAlpha: 2, worthBeta: 2 });
    const archived = fact("archived", { status: "forgotten", validTo: NOW });
    const parent = {
      id: "parent",
      primitive: "fact",
      content: "parent",
      score: 1,
      sensitivity: "internal",
      injectionScore: 0,
      provenance: "user_stated",
      origin: "local",
      contested: false,
      validFrom: NOW,
      validTo: null,
      tags: [],
      relations: [],
      worth: 0.9,
      hyperedges: [{ id: "he", coMembers: [member.id, lowEvidence.id, archived.id], worth: 0.9 }],
    } as const;
    const ctx = {
      ...baseCtx(),
      storage: {
        getFact: vi.fn(async (id: string) =>
          id === member.id ? member : id === lowEvidence.id ? lowEvidence : archived
        ),
      },
    } as never;

    const gated = await expandHyperedgeMembers(ctx, "ws", [parent] as never, AUTH, {
      tags: ["real-tag"],
    });
    expect(gated.map((hit) => hit.id)).toEqual([member.id]);
    expect(gated[0]?.tags).toEqual(["real-tag"]);

    const inspection = await expandHyperedgeMembers(ctx, "ws", [parent] as never, AUTH, undefined, {
      includeArchived: true,
      includeLowWorth: true,
    });
    expect(inspection.map((hit) => hit.id).sort()).toEqual(
      [archived.id, lowEvidence.id, member.id].sort()
    );
  });
  it("hot scopeRef mismatch falls through without reinforcement", async () => {
    const ids = ["h1", "h2", "h3"];
    const zincrby = vi.fn(async () => undefined);
    const ctx = {
      ...baseCtx(),
      cache: {
        zrangeByScore: vi.fn(async (key: string) => (key === hotTierKey("ws") ? ids : [])),
        zincrby,
      },
      storage: {
        getFact: vi.fn(async (id: string) => fact(id)),
        getRecallLog: vi.fn(async () =>
          [0, 1, 2, 3, 4].map((seconds) => ({
            recalledAt: new Date(Date.now() - seconds * 1000).toISOString(), // determinism-ok: test date
          }))
        ),
      },
    } as never;

    const result = await tryHotTier(
      ctx,
      {
        workspaceId: "ws",
        text: "query",
        filter: { scopeRef: "project-2" },
      },
      AUTH
    );

    expect(result).toBeNull();
    expect(zincrby).not.toHaveBeenCalled();
  });

  it("pointer actor mismatch falls through without hot promotion", async () => {
    const embedding = new Float32Array(64).fill(1);
    const candidates: PointerCandidate[] = ["p1", "p2", "p3"].map((id) => ({
      factId: id,
      statement: `statement ${id}`,
      embedding: Array.from(embedding),
      sensitivity: "internal",
      worth: 0.9,
      attribution: "user_stated",
      createdAt: NOW,
      status: "active",
      validTo: null,
    }));
    const zincrby = vi.fn(async () => undefined);
    const ctx = {
      ...baseCtx(),
      embed: { embedSingle: vi.fn(async () => embedding) },
      storage: {
        pointerCandidates: vi.fn(async () => candidates),
        getFact: vi.fn(async (id: string) => fact(id, { actorId: "actor-1" })),
      },
      cache: { zincrby, zrangeByScore: vi.fn(async () => []) },
    } as never;

    const result = await tryPointerTier(
      ctx,
      {
        workspaceId: "ws",
        text: "query",
        embedding,
        filter: { actorId: "actor-2" },
      },
      AUTH
    );

    expect(result).toBeNull();
    expect(zincrby).not.toHaveBeenCalled();
  });

  it("FTS rejects provenance and sensitivity mismatches", async () => {
    const provenanceMismatch = fact("fts-provenance", {
      attribution: "inferred",
      sensitivity: "public",
    });
    const sensitivityMismatch = fact("fts-sensitivity", {
      attribution: "user_stated",
      sensitivity: "restricted",
    });
    const rows: PointerCandidate[] = [provenanceMismatch, sensitivityMismatch].map((f) => ({
      factId: f.id,
      statement: f.statement,
      embedding: null,
      sensitivity: f.sensitivity,
      worth: f.worth,
      attribution: f.attribution,
      createdAt: f.createdAt,
      status: f.status,
      validTo: null,
    }));
    const ctx = {
      ...baseCtx(),
      storage: {
        ftsCandidates: vi.fn(async () => rows),
        getFact: vi.fn(async (id: string) =>
          id === provenanceMismatch.id ? provenanceMismatch : sensitivityMismatch
        ),
      },
    } as never;

    const result = await ftsFallbackRecall(
      ctx,
      {
        workspaceId: "ws",
        text: "query",
        filter: { provenance: ["user_stated"] },
      },
      AUTH
    );

    expect(result).toEqual([]);
    expect(ctx.outbox.append).not.toHaveBeenCalled();
  });

  it("FTS serves forgotten facts only when includeArchived is true and never serves merged facts", async () => {
    const forgotten = fact("fts-forgotten", {
      status: "forgotten",
      validTo: new Date("2026-07-01T00:00:00Z"),
    });
    const merged = fact("fts-merged", {
      status: "merged",
      validTo: new Date("2026-07-02T00:00:00Z"),
    });
    const ftsCandidates = vi.fn(async () => [
      candidateFromFact(forgotten),
      candidateFromFact(merged),
    ]);
    const ctx = { ...baseCtx(), storage: { ftsCandidates } } as never;

    const defaultHits = await ftsFallbackRecall(ctx, { workspaceId: "ws", text: "query" }, AUTH);
    const archivedHits = await ftsFallbackRecall(
      ctx,
      { workspaceId: "ws", text: "query", includeArchived: true, includeLowWorth: true },
      AUTH
    );

    expect(defaultHits).toEqual([]);
    expect(archivedHits.map((hit) => hit.id)).toEqual([forgotten.id]);
    expect(ftsCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeArchived: true })
    );
  });

  it("cold retrieval hydrates a stale forgotten vector only for includeArchived", async () => {
    const forgotten = fact("cold-forgotten", {
      status: "forgotten",
      validTo: new Date("2026-07-01T00:00:00Z"),
    });
    const ctx = {
      ...baseCtx(),
      vector: {
        search: vi.fn(async () => [{ id: forgotten.id, score: 1, primitiveKind: "fact" }]),
      },
      embed: {
        model: "test",
        embedSingle: vi.fn(async () => new Float32Array([1, 0])),
        embed: vi.fn(async () => [new Float32Array([1, 0])]),
      },
      storage: {
        getFact: vi.fn(async () => forgotten),
        findSimilarEntities: vi.fn(async () => []),
        getRelations: vi.fn(async () => []),
        queryHyperedges: vi.fn(async () => ({ items: [] })),
        recordRecall: vi.fn(async () => undefined),
      },
    } as never;

    const defaultResult = await recallCold(ctx, { workspaceId: "ws", text: "query" }, AUTH);
    const archivedResult = await recallCold(
      ctx,
      { workspaceId: "ws", text: "query", includeArchived: true, includeLowWorth: true },
      AUTH
    );

    expect(defaultResult.hits).toEqual([]);
    expect(archivedResult.hits.map((hit) => hit.id)).toEqual([forgotten.id]);
  });

  it("asOf recalls what was valid at the instant, closed since or not, and leaves no trace", async () => {
    // Line 3 ran firmware 4.1 from July 1 until it was replaced on July 10.
    const old = fact("firmware-4-1", {
      status: "forgotten",
      validFrom: new Date("2026-07-01T00:00:00Z"),
      validTo: new Date("2026-07-10T00:00:00Z"),
    });
    const current = fact("firmware-4-2", { validFrom: new Date("2026-07-10T00:00:00Z") });
    const byId = new Map([old, current].map((f) => [f.id, f]));
    const recordRecall = vi.fn(async () => undefined);
    const zincrby = vi.fn(async () => undefined);
    const ctx = {
      ...baseCtx(),
      vector: {
        search: vi.fn(async () => [
          { id: old.id, score: 0.9, primitiveKind: "fact" },
          { id: current.id, score: 0.9, primitiveKind: "fact" },
        ]),
      },
      embed: {
        model: "test",
        embedSingle: vi.fn(async () => new Float32Array([1, 0])),
        embed: vi.fn(async () => [new Float32Array([1, 0])]),
      },
      storage: {
        getFact: vi.fn(async (id: string) => byId.get(id) ?? null),
        findSimilarEntities: vi.fn(async () => []),
        getRelations: vi.fn(async () => []),
        queryHyperedges: vi.fn(async () => ({ items: [] })),
        recordRecall,
      },
      cache: { zincrby },
    } as never;
    const ask = (asOf?: Date) =>
      recallCold(
        ctx,
        { workspaceId: "ws", text: "line 3 firmware", ...(asOf ? { asOf } : {}) },
        AUTH
      );

    const then = await ask(new Date("2026-07-05T00:00:00Z"));
    expect(then.hits.map((h) => h.id)).toEqual([old.id]);
    expect(then.hits[0]?.status).toBe("superseded");
    // The boundary is half-open: at the instant of the close the old row is gone.
    expect((await ask(new Date("2026-07-10T00:00:00Z"))).hits.map((h) => h.id)).toEqual([
      current.id,
    ]);
    // Reading the past is not use: no recall log, no hot-tier bump.
    expect(recordRecall).not.toHaveBeenCalled();
    expect(zincrby).not.toHaveBeenCalled();

    expect((await ask()).hits.map((h) => h.id)).toEqual([current.id]);
    // P140: recallCold no longer writes the recall log; recall() records the
    // served hits when it finalizes the observation, and skips that for asOf
    // (runEffects is false). The cold tier itself still bumps the hot tier on
    // a current read.
    expect(recordRecall).not.toHaveBeenCalled();
    expect(zincrby).toHaveBeenCalled();
  });

  it("applies the default worth gate to pointer and FTS with an includeLowWorth override", async () => {
    const embedding = new Float32Array(64).fill(1);
    const low = fact("low", { worth: 0.9, worthAlpha: 20, worthBeta: 100 });
    // Distinct statements: lexical recall drops exact-content duplicates.
    const candidates = ["low-1", "low-2", "low-3"].map((id) =>
      candidateFromFact({
        ...low,
        id,
        statement: `${low.statement} ${id}`,
        embedding: Array.from(embedding),
      })
    );
    const getFact = vi.fn(async () => low);
    const ctx = {
      ...baseCtx(),
      embed: { embedSingle: vi.fn(async () => embedding) },
      storage: {
        pointerCandidates: vi.fn(async () => candidates),
        ftsCandidates: vi.fn(async () => candidates),
        getFact,
      },
      cache: { zincrby: vi.fn(async () => undefined), zrangeByScore: vi.fn(async () => []) },
    } as never;

    expect(
      await tryPointerTier(ctx, { workspaceId: "ws", text: "query", embedding }, AUTH)
    ).toBeNull();
    expect(
      await tryPointerTier(
        ctx,
        { workspaceId: "ws", text: "query", embedding, includeLowWorth: true },
        AUTH
      )
    ).not.toBeNull();
    expect(await ftsFallbackRecall(ctx, { workspaceId: "ws", text: "query" }, AUTH)).toEqual([]);
    expect(
      await ftsFallbackRecall(
        ctx,
        { workspaceId: "ws", text: "query", includeLowWorth: true },
        AUTH
      )
    ).toHaveLength(3);
    expect(getFact).not.toHaveBeenCalled();
  });

  it("cold temporal and tag mismatch rejects before graph, recall, outbox, or cache side effects", async () => {
    const candidate = fact("cold-1", {
      validFrom: new Date("2026-01-01T00:00:00Z"),
      metadata: { tags: ["backend"] },
    });
    const getRelations = vi.fn(async () => []);
    const queryHyperedges = vi.fn(async () => ({ items: [] }));
    const recordRecall = vi.fn(async () => undefined);
    const zincrby = vi.fn(async () => undefined);
    const ctx = {
      ...baseCtx(),
      vector: {
        search: vi.fn(async () => [{ id: candidate.id, score: 1, primitiveKind: "fact" }]),
      },
      embed: {
        model: "test",
        embedSingle: vi.fn(async () => new Float32Array([1, 0])),
        embed: vi.fn(async () => [new Float32Array([1, 0])]),
      },
      storage: {
        getFact: vi.fn(async () => candidate),
        findSimilarEntities: vi.fn(async () => []),
        getRelations,
        queryHyperedges,
        recordRecall,
      },
      cache: { zincrby },
    } as never;

    const result = await recallCold(
      ctx,
      {
        workspaceId: "ws",
        text: "query",
        filter: { validAfter: new Date("2026-02-01T00:00:00Z"), tags: ["typescript"] },
      },
      AUTH
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.hits).toEqual([]);
    expect(getRelations).not.toHaveBeenCalled();
    expect(queryHyperedges).not.toHaveBeenCalled();
    expect(recordRecall).not.toHaveBeenCalled();
    expect(ctx.outbox.append).not.toHaveBeenCalled();
    expect(zincrby).not.toHaveBeenCalled();
  });

  it("cold over-fetches through the canonical bound so a selective match below rank 50 survives", async () => {
    const matching = fact("cold-match", { metadata: { tags: ["wanted"] } });
    const rejected = Array.from({ length: 60 }, (_, index) => fact(`cold-reject-${index}`));
    const search = vi.fn(async ({ limit }: { limit: number }) =>
      [
        ...rejected.map((item) => ({ id: item.id, score: 1, primitiveKind: "fact" })),
        { id: matching.id, score: 0.8, primitiveKind: "fact" },
      ].slice(0, limit)
    );
    const byId = new Map([...rejected, matching].map((item) => [item.id, item]));
    const ctx = {
      ...baseCtx(),
      vector: { search },
      embed: {
        model: "test",
        embedSingle: vi.fn(async () => new Float32Array([1, 0])),
        embed: vi.fn(async () => [new Float32Array([1, 0])]),
      },
      storage: {
        getFact: vi.fn(async (id: string) => byId.get(id) ?? null),
        findSimilarEntities: vi.fn(async () => []),
        getRelations: vi.fn(async () => []),
        queryHyperedges: vi.fn(async () => ({ items: [] })),
        recordRecall: vi.fn(async () => undefined),
      },
    } as never;

    const result = await recallCold(
      ctx,
      { workspaceId: "ws", text: "query", limit: 1, filter: { tags: ["wanted"] } },
      AUTH
    );

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
    expect(result.hits.map((hit) => hit.id)).toEqual([matching.id]);
  });

  it("hybrid FTS constrains candidate sensitivity to the effective auth ceiling", async () => {
    const ftsCandidates = vi.fn(async () => []);
    const ctx = {
      ...baseCtx(),
      vector: { search: vi.fn(async () => []) },
      embed: {
        model: "test",
        embedSingle: vi.fn(async () => new Float32Array([1, 0])),
        embed: vi.fn(async () => []),
      },
      storage: {
        findSimilarEntities: vi.fn(async () => []),
        ftsCandidates,
      },
    } as never;

    await recallCold(
      ctx,
      {
        workspaceId: "ws",
        text: "query",
        hybridFts: true,
        filter: { sensitivity: ["public", "restricted"] },
      },
      AUTH
    );

    expect(ftsCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { sensitivity: ["public"] } })
    );
  });

  const primitiveCases: Array<{
    name: string;
    kind:
      | "decision"
      | "episode"
      | "entity"
      | "strategy"
      | "workflow"
      | "skill"
      | "task"
      | "event"
      | "reasoning";
    value:
      | MnemoDecision
      | MnemoEpisode
      | MnemoEntity
      | MnemoStrategy
      | MnemoWorkflow
      | MnemoSkill
      | MnemoTask
      | MnemoEvent
      | MnemoReasoning;
    supported: RecallFilter;
    unsupported: RecallFilter;
  }> = [
    {
      name: "decision",
      kind: "decision",
      value: {
        id: "decision-1",
        workspaceId: "ws",
        actorId: "actor-1",
        scopeRef: "project-1",
        kind: "decision",
        title: "Decision",
        body: "Use real decision fields",
        revisionCount: 1,
        normalizedHash: "hash",
        status: "active",
        confidence: 0.9,
        sensitivity: "internal",
        embeddingStale: false,
        validFrom: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        metadata: {},
      },
      supported: {
        validAfter: new Date("2026-07-01T00:00:00Z"),
        minConfidence: 0.8,
        scopeRef: "project-1",
        actorId: "actor-1",
      },
      unsupported: { provenance: ["user_stated"] },
    },
    {
      name: "episode",
      kind: "episode",
      value: {
        id: "episode-1",
        workspaceId: "ws",
        actorId: "actor-1",
        title: "Episode",
        narrative: "Real episode",
        occurredAt: NOW,
        participants: [],
        topics: ["typescript"],
        linkedFactIds: [],
        isRoot: true,
        depth: 0,
        isSynthetic: false,
        sensitivity: "internal",
        validFrom: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        metadata: {},
      },
      supported: { tags: ["typescript"], actorId: "actor-1" },
      unsupported: { minWorth: 0.1 },
    },
    {
      name: "entity",
      kind: "entity",
      value: {
        id: "entity-1",
        workspaceId: "ws",
        actorId: "actor-1",
        name: "Entity",
        kind: "project",
        aliases: [],
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        mentionCount: 1,
        sensitivity: "internal",
        validFrom: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        metadata: { tags: ["typescript"] },
      },
      supported: { tags: ["typescript"], actorId: "actor-1" },
      unsupported: { provenance: ["user_stated"] },
    },
    {
      name: "strategy",
      kind: "strategy",
      value: {
        id: "strategy-1",
        workspaceId: "ws",
        actorId: "actor-1",
        scopeRef: "project-1",
        trigger: "when",
        action: "then",
        relatedFacts: [],
        memoryType: "procedural",
        attribution: "inferred",
        successCount: 9,
        failureCount: 1,
        worth: 0.9,
        status: "active",
        sensitivity: "internal",
        embeddingStale: false,
        validFrom: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        metadata: {},
      },
      supported: {
        validAfter: new Date("2026-07-01T00:00:00Z"),
        minWorth: 0.8,
        provenance: ["inferred"],
        scopeRef: "project-1",
        actorId: "actor-1",
      },
      unsupported: { minConfidence: 0.1 },
    },
    {
      name: "workflow",
      kind: "workflow",
      value: {
        id: "workflow-1",
        workspaceId: "ws",
        actorId: "actor-1",
        scopeRef: "project-1",
        name: "Workflow",
        steps: [],
        avgDurationMs: 1,
        successRate: 0.9,
        executionCount: 10,
        version: 1,
        status: "active",
        sensitivity: "internal",
        validFrom: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        metadata: { tags: ["typescript"] },
        worth: 0.9,
      } as MnemoWorkflow,
      supported: { tags: ["typescript"], minWorth: 0.8, scopeRef: "project-1", actorId: "actor-1" },
      unsupported: { provenance: ["user_stated"] },
    },
    {
      name: "skill",
      kind: "skill",
      value: {
        id: "skill-1",
        workspaceId: "ws",
        actorId: "actor-1",
        name: "Skill",
        promptTemplate: "Prompt",
        variables: [],
        requiredContext: [],
        qualityScore: 0.9,
        usageCount: 10,
        sensitivity: "internal",
        embeddingStale: false,
        validFrom: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        metadata: { tags: ["typescript"] },
        worth: 0.9,
      } as MnemoSkill,
      supported: { tags: ["typescript"], minWorth: 0.8, actorId: "actor-1" },
      unsupported: { scopeRef: "project-1" },
    },
    {
      name: "task",
      kind: "task",
      value: {
        id: "task-1",
        workspaceId: "ws",
        actorId: "actor-1",
        title: "Task",
        status: "pending",
        priority: "high",
        assignedTo: "agent",
        blockedBy: [],
        subtaskIds: [],
        relatedFacts: [],
        relatedEntities: [],
        sessionId: "session-1",
        sensitivity: "internal",
        validFrom: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        metadata: {},
      },
      supported: {
        validAfter: new Date("2026-07-01T00:00:00Z"),
        sessionId: "session-1",
        actorId: "actor-1",
      },
      unsupported: { minWorth: 0.1 },
    },
    {
      name: "event",
      kind: "event",
      value: {
        id: "event-1",
        workspaceId: "ws",
        type: "system",
        name: "Event",
        description: "Real event",
        occurredAt: NOW,
        source: "system",
        relatedEntities: ["entity-1"],
        annotations: [],
        sensitivity: "internal",
        createdAt: NOW,
        metadata: { tags: ["typescript"] },
      },
      supported: { tags: ["typescript"], entityId: "entity-1" },
      unsupported: { actorId: "system" },
    },
    {
      name: "reasoning",
      kind: "reasoning",
      value: {
        id: "reasoning-1",
        workspaceId: "ws",
        question: "Why?",
        chain: [],
        conclusion: "Because",
        successCount: 9,
        failureCount: 1,
        worth: 0.9,
        status: "golden",
        usageCount: 10,
        sensitivity: "internal",
        embeddingStale: false,
        validFrom: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        metadata: { tags: ["typescript"] },
      },
      supported: { tags: ["typescript"], minWorth: 0.8 },
      unsupported: { provenance: ["inferred"] },
    },
  ];

  it.each(primitiveCases)(
    "uses real $name fields and rejects unsupported filter dimensions",
    async ({ kind, value, supported, unsupported }) => {
      const getter = `get${kind[0]!.toUpperCase()}${kind.slice(1)}`;
      const ctx = {
        ...baseCtx(),
        vector: { search: vi.fn(async () => [{ id: value.id, score: 1, primitiveKind: kind }]) },
        embed: {
          model: "test",
          embedSingle: vi.fn(async () => new Float32Array([1, 0])),
          embed: vi.fn(async () => [new Float32Array([1, 0])]),
        },
        storage: {
          [getter]: vi.fn(async () => value),
          findSimilarEntities: vi.fn(async () => []),
          getRelations: vi.fn(async () => []),
          queryHyperedges: vi.fn(async () => ({ items: [] })),
        },
      } as never;

      const matching = await recallCold(
        ctx,
        { workspaceId: "ws", text: "query", filter: supported, includeLowWorth: true },
        AUTH
      );
      const excluded = await recallCold(
        ctx,
        { workspaceId: "ws", text: "query", filter: unsupported, includeLowWorth: true },
        AUTH
      );

      expect(matching.hits.map((hit) => hit.id)).toEqual([value.id]);
      expect(excluded.hits).toEqual([]);
    }
  );

  const lifecycleCases = [
    ["decision", { status: "withdrawn", validTo: NOW }],
    ["episode", { validTo: NOW }],
    ["entity", { validTo: NOW }],
    ["strategy", { status: "archived", validTo: NOW }],
    ["workflow", { status: "deprecated", validTo: NOW }],
    ["skill", { validTo: NOW }],
    ["task", { status: "cancelled", validTo: NOW }],
    ["reasoning", { status: "archived" }],
  ] as const;

  it.each(lifecycleCases)(
    "enforces %s lifecycle before graph side effects and honors includeArchived",
    async (kind, archived) => {
      const base = primitiveCases.find((entry) => entry.kind === kind)!;
      const value = { ...base.value, ...archived };
      const getRelations = vi.fn(async () => []);
      const getter = `get${kind[0]!.toUpperCase()}${kind.slice(1)}`;
      const ctx = {
        ...baseCtx(),
        vector: { search: vi.fn(async () => [{ id: value.id, score: 1, primitiveKind: kind }]) },
        embed: {
          model: "test",
          embedSingle: vi.fn(async () => new Float32Array([1, 0])),
          embed: vi.fn(async () => [new Float32Array([1, 0])]),
        },
        storage: {
          [getter]: vi.fn(async () => value),
          findSimilarEntities: vi.fn(async () => []),
          getRelations,
          queryHyperedges: vi.fn(async () => ({ items: [] })),
        },
      } as never;

      expect(
        (await recallCold(ctx, { workspaceId: "ws", text: "query", includeLowWorth: true }, AUTH))
          .hits
      ).toEqual([]);
      expect(getRelations).not.toHaveBeenCalled();
      expect(
        (
          await recallCold(
            ctx,
            { workspaceId: "ws", text: "query", includeArchived: true, includeLowWorth: true },
            AUTH
          )
        ).hits.map((hit) => hit.id)
      ).toEqual([value.id]);
    }
  );
});
