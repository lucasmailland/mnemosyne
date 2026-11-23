import { describe, expect, it, vi } from "vitest";
import type { AuthContext, MnemoSession, SessionTurn } from "@mnemo-ai/types";
import type { CoreContext } from "../../cognitive/context.js";
import * as managed from "../managed-collapse.js";

const auth: AuthContext = {
  workspaceId: "ws",
  actorId: "system:worker",
  actorType: "system",
  scopes: [],
  maxSensitivity: "restricted",
};
const session: MnemoSession = {
  id: "s",
  workspaceId: "ws",
  status: "collapse_pending",
  sourceHost: "codex",
  sourceGeneration: 0,
  collapseOperationId: "op",
  agentId: "a",
  turnCount: 2,
  tokenCount: 20,
  openedAt: new Date("2026-09-01"),
  metadata: {},
  sensitivity: "internal",
  originActorId: "key:original",
  originActorType: "agent",
  originUserId: null,
  originSensitivityCeiling: "internal",
  closeKind: "authoritative",
};
const turns: SessionTurn[] = ["user", "assistant"].map((role, i) => ({
  id: `t${i}`,
  workspaceId: "ws",
  sessionId: "s",
  turnIndex: i,
  sourceMessageId: `m${i}`,
  role: role as "user" | "assistant",
  content: `Durable architecture decision ${i}`,
  createdAt: session.openedAt,
}));
const empty = {
  goal: "Architecture",
  outcome: "resolved",
  facts: [],
  decisions: [],
  strategies: [],
};
function fixture(summary: Record<string, unknown> = empty) {
  const writes = vi.fn(() => {
    throw new Error("preparation wrote domain state");
  });
  const reads: Record<string, unknown> = {
    getKnowledgeDistribution: async () => ({}),
    getWorkspaceMode: async () => ({
      workspaceId: "ws",
      mode: "production",
      sessionCount: 5,
      promoteAt: 10,
    }),
    listTasksForSession: async () => [],
  };
  const generate = vi.fn(async () => ({
    content: JSON.stringify(summary),
    tokensUsed: { input: 10, output: 20 },
    model: "test",
  }));
  const ctx = {
    storage: new Proxy(reads, { get: (target, name) => target[name as string] ?? writes }),
    llm: { id: "test", generate },
    embed: { semantic: true, embed: async (texts: string[]) => texts.map(() => [1, 0]) },
    vector: { search: async () => [] },
    outbox: { append: writes },
    cache: new Proxy({}, { get: () => writes }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { surpriseThreshold: 0.3 },
  } as unknown as CoreContext;
  // Optional enrichment ports intentionally absent.
  delete reads.findSimilarEpisodes;
  reads.findSimilarEpisodes = undefined;
  reads.reconstructEpisode = undefined;
  return { ctx, writes, generate };
}
const run = (ctx: CoreContext, extra = {}) =>
  managed.prepareManagedCollapse({ session, turns, ...extra }, ctx, auth);

describe("managed collapse preparation", () => {
  it("exports the preparation boundary", () =>
    expect(managed.prepareManagedCollapse).toBeTypeOf("function"));
  it("prepares an episode for a complete two-message zero-candidate exchange without writes", async () => {
    const { ctx, writes } = fixture();
    const plan = await run(ctx);
    expect(plan.status).toBe("prepared");
    if (plan.status !== "prepared") throw new Error(plan.status);
    expect(plan.candidates).toEqual([]);
    expect(plan.episode.input.sourceConversationId).toBe("s");
    expect(plan.episode.sourceMessageIds).toEqual(["m0", "m1"]);
    expect(plan.counters.sessionCount).toBe(1);
    expect(writes).not.toHaveBeenCalled();
  });
  it.each([
    [[], "empty_session"],
    [[turns[0]], "incomplete_exchange"],
  ])("archives %j without an LLM call", async (visible, reason) => {
    const { ctx, generate, writes } = fixture();
    expect(await run(ctx, { turns: visible })).toMatchObject({ status: "archive", reason });
    expect(generate).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });
  it("excludes tool, system and retracted turns from the prompt and source set", async () => {
    const { ctx, generate } = fixture();
    const plan = await run(ctx, {
      turns: [
        ...turns,
        ...["tool", "system", "assistant"].map((role, i) => ({
          ...turns[0],
          id: `x${i}`,
          sourceMessageId: `x${i}`,
          role,
          content: "PRIVATE-EXCLUDED",
          ...(i === 2 ? { retractedAt: session.openedAt } : {}),
        })),
      ],
    });
    expect(plan.sourceMessageIds).toEqual(["m0", "m1"]);
    expect(JSON.stringify(generate.mock.calls)).not.toContain("PRIVATE-EXCLUDED");
  });
  it("returns a safe retry reason for unavailable or malformed LLM output", async () => {
    const { ctx, generate } = fixture();
    generate.mockRejectedValueOnce(new Error("secret provider request"));
    expect(await run(ctx)).toMatchObject({ status: "retryable", reason: "llm_unavailable" });
    generate.mockResolvedValueOnce({
      content: "{}",
      tokensUsed: { input: 0, output: 0 },
      model: "test",
    });
    expect(await run(ctx)).toMatchObject({ status: "retryable", reason: "invalid_extraction" });
  });
  it("inherits original actor and sensitivity, validates source support, and uses stable IDs", async () => {
    const { ctx } = fixture({
      ...empty,
      facts: [{ content: "Use SQLite", topicKey: "db", sourceMessageIds: ["m0"] }],
      decisions: [
        { title: "Database", body: "SQLite", kind: "invented", sourceMessageIds: ["m1"] },
      ],
      strategies: [{ trigger: "When offline", action: "Queue", sourceMessageIds: ["m0", "m1"] }],
    });
    const plan = await run(ctx);
    expect(plan).toEqual(await run(ctx));
    if (plan.status !== "prepared") throw new Error(plan.status);
    expect(plan.candidates).toHaveLength(3);
    for (const candidate of plan.candidates)
      expect(candidate.input).toMatchObject({
        sensitivity: "internal",
        actorId: "key:original",
        actorType: "agent",
        userId: null,
      });
    expect(plan.candidates[0]?.sourceMessageIds).toEqual(["m0"]);
    expect(plan.candidates[1]?.input).toMatchObject({ kind: "decision" });
    expect(plan.postCommitEffects.map((e) => e.effectKind)).toEqual(
      expect.arrayContaining([
        "session_buffer_cleanup",
        "bus_delivery",
        "webhook_delivery",
        "td_credit",
        "governance",
        "graduation",
        "reflection",
        "anticipation_telemetry",
        "llm_usage_telemetry",
      ])
    );
  });
  it("keeps the fact kind the model extracted and coerces an invented one to other", async () => {
    // The managed path hardcoded `kind: "other"`, discarding the kind the shared
    // prompt asks for. On the Acme stack 75% of active facts were `other`.
    const { ctx } = fixture({
      ...empty,
      facts: [
        { content: "Fixed the cache race", kind: "bugfix", sourceMessageIds: ["m0"] },
        { content: "Reviews in Spanish", kind: "preference", sourceMessageIds: ["m1"] },
        { content: "Deploys on Tuesdays", kind: "deployment", sourceMessageIds: ["m0"] },
        { content: "TTL is 15 minutes", sourceMessageIds: ["m1"] },
      ],
    });
    const plan = await run(ctx);
    if (plan.status !== "prepared") throw new Error(plan.status);
    const kinds = Object.fromEntries(
      plan.candidates.map((c) => {
        const input = c.input as { statement: string; kind: string };
        return [input.statement, input.kind];
      })
    );
    expect(kinds).toEqual({
      "Fixed the cache race": "bugfix",
      "Reviews in Spanish": "preference",
      "Deploys on Tuesdays": "other",
      "TTL is 15 minutes": "other",
    });
  });
  it("P153 FM-TOPIC-01: keeps distinct facts with an ambiguous topic independently of extraction order", async () => {
    const facts = [
      {
        content: "Postgres reduces operational overhead",
        topicKey: "db",
        sourceMessageIds: ["m0"],
      },
      { content: "The team already manages Postgres", topicKey: " DB ", sourceMessageIds: ["m1"] },
    ];
    const prepare = async (items: typeof facts) => {
      const { ctx, writes } = fixture({ ...empty, facts: items });
      const plan = await run(ctx, {
        existingTopics: [{ kind: "fact", id: "prior", topicKey: "db", sensitivity: "internal" }],
      });
      if (plan.status !== "prepared") throw new Error(plan.status);
      expect(plan.candidates).toHaveLength(2);
      for (const candidate of plan.candidates) {
        expect(candidate.kind).toBe("fact");
        expect(candidate.topicKey).toBeUndefined();
        expect(candidate.input).not.toHaveProperty("topicKey", expect.any(String));
        expect(candidate.predecessorId).toBeUndefined();
      }
      expect(writes).not.toHaveBeenCalled();
      return plan.candidates.map((candidate) => candidate.id).sort();
    };
    expect(await prepare(facts)).toEqual(await prepare([...facts].reverse()));
  });
  it("P153 FM-TOPIC-02: deduplicates normalized repetitions before checking topic collisions", async () => {
    const { ctx } = fixture({
      ...empty,
      facts: [
        { content: "Use Postgres", topicKey: "db", sourceMessageIds: ["m0"] },
        { content: " USE  POSTGRES ", topicKey: " DB ", sourceMessageIds: ["m1"] },
      ],
    });
    const plan = await run(ctx);
    if (plan.status !== "prepared") throw new Error(plan.status);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({ kind: "fact", topicKey: "db" });
  });
  it.each([
    ["distinct topic keys", "billing-api", "auth-api", "billing-db", "auth-db"],
    ["a shared topic key", "billing-api", "auth-api", "db", " DB "],
    ["no topic key", "billing-api", "auth-api", undefined, undefined],
    ["case-distinct subjects", "api", "API", "db", "db"],
    ["whitespace-distinct subjects", "api", " api ", "db", "db"],
  ])(
    "P153 FM-TOPIC-03: keeps identical statements about distinct subjects with %s",
    async (_label, firstSubject, secondSubject, firstKey, secondKey) => {
      const facts = [
        {
          content: "Uses Postgres",
          subject: firstSubject,
          topicKey: firstKey,
          sourceMessageIds: ["m0"],
        },
        {
          content: "Uses Postgres",
          subject: secondSubject,
          topicKey: secondKey,
          sourceMessageIds: ["m1"],
        },
      ];
      const ambiguous = firstKey?.trim().toLowerCase() === secondKey?.trim().toLowerCase();
      const prepare = async (items: typeof facts) => {
        const { ctx, writes } = fixture({ ...empty, facts: items });
        const plan = await run(ctx);
        if (plan.status !== "prepared") throw new Error(plan.status);
        expect(plan.candidates).toHaveLength(2);
        for (const fact of facts) {
          const topicKey = ambiguous ? undefined : fact.topicKey;
          expect(plan.candidates).toContainEqual(
            expect.objectContaining({
              kind: "fact",
              topicKey,
              sourceMessageIds: fact.sourceMessageIds,
              input: expect.objectContaining({
                statement: fact.content,
                subject: fact.subject,
                topicKey,
              }),
            })
          );
        }
        expect(writes).not.toHaveBeenCalled();
        const ids = plan.candidates.map((candidate) => candidate.id).sort();
        expect(new Set(ids).size).toBe(2);
        return ids;
      };
      expect(await prepare(facts)).toEqual(await prepare([...facts].reverse()));
    }
  );
  it.each([
    [undefined, "general"],
    ["general", undefined],
    ["billing-api", "billing-api"],
  ])(
    "P153 FM-TOPIC-04: deduplicates repetitions for the same effective subject %j",
    async (firstSubject, secondSubject) => {
      const { ctx } = fixture({
        ...empty,
        facts: [
          {
            content: "Uses Postgres",
            subject: firstSubject,
            topicKey: "db",
            sourceMessageIds: ["m0"],
          },
          {
            content: " USES  POSTGRES ",
            subject: secondSubject,
            topicKey: " DB ",
            sourceMessageIds: ["m1"],
          },
        ],
      });
      const plan = await run(ctx);
      if (plan.status !== "prepared") throw new Error(plan.status);
      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0]).toMatchObject({
        kind: "fact",
        topicKey: "db",
        input: { subject: firstSubject ?? "general", statement: "Uses Postgres" },
      });
    }
  );
  it("P153 FM-TOPIC-05: a repetition keeps the supporting messages of every copy", async () => {
    const { ctx } = fixture({
      ...empty,
      facts: [
        { content: "Use Postgres", topicKey: "db", sourceMessageIds: ["m0"] },
        { content: " USE  POSTGRES ", topicKey: " DB ", sourceMessageIds: ["m1", "m0"] },
      ],
      decisions: [
        { title: "Pick Postgres", body: "It is already run", sourceMessageIds: ["m1"] },
        { title: "Pick Postgres", body: "It is already run", sourceMessageIds: ["m0"] },
      ],
    });
    const plan = await run(ctx);
    if (plan.status !== "prepared") throw new Error(plan.status);
    const fact = plan.candidates.filter((candidate) => candidate.kind === "fact");
    const decision = plan.candidates.filter((candidate) => candidate.kind === "decision");
    expect(fact).toHaveLength(1);
    expect(decision).toHaveLength(1);
    expect([...fact[0]!.sourceMessageIds].sort()).toEqual(["m0", "m1"]);
    expect([...decision[0]!.sourceMessageIds].sort()).toEqual(["m0", "m1"]);
  });
  it.each([undefined, [], ["not-live"]])(
    "rejects missing or unsupported source IDs %j",
    async (sourceMessageIds) => {
      const { ctx } = fixture({ ...empty, facts: [{ content: "Unsupported", sourceMessageIds }] });
      expect(await run(ctx)).toMatchObject({ status: "retryable", reason: "invalid_extraction" });
    }
  );
  it("rejects a ceiling-invalid topic merge using hash-only audit detail", async () => {
    const { ctx } = fixture({
      ...empty,
      facts: [{ content: "SECRET-CANDIDATE", topicKey: "private-db", sourceMessageIds: ["m0"] }],
    });
    const plan = await run(ctx, {
      existingTopics: [
        { kind: "fact", id: "prior", topicKey: "private-db", sensitivity: "restricted" },
      ],
    });
    if (plan.status !== "prepared") throw new Error(plan.status);
    expect(plan.candidates).toEqual([]);
    expect(plan.rejectedCandidates).toEqual([
      expect.objectContaining({
        reason: "sensitivity_ceiling",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        requestedSensitivity: "restricted",
      }),
    ]);
    expect(JSON.stringify(plan)).not.toContain("SECRET-CANDIDATE");
  });
  it("honors pin and recurrence gates without the legacy three-turn minimum", async () => {
    const { ctx } = fixture();
    expect(await run(ctx, { policy: { requirePin: true } })).toMatchObject({
      status: "archive",
      reason: "no_pin",
    });
    ctx.embed.embed = async () => [
      [1, 0],
      [0, 1],
    ];
    expect(await run(ctx, { session: { ...session, closeKind: "provisional" } })).toMatchObject({
      status: "archive",
      reason: "low_recurrence_signal",
    });
  });
});

describe("managed enrichment boundaries", () => {
  it("precomputes a safe delta link and falls back to root when enrichment fails", async () => {
    const { ctx } = fixture();
    ctx.embed.embedSingle = async () => new Float32Array([1, 0]);
    ctx.storage.findSimilarEpisodes = async () => [{ id: "parent", score: 0.99 }] as never;
    ctx.storage.getEpisode = async () =>
      ({ id: "parent", workspaceId: "ws", sensitivity: "internal" }) as never;
    const reconstruct = vi.fn(async () => ({ narrative: "Earlier architecture" }));
    ctx.storage.reconstructEpisode = reconstruct as never;
    const plan = await run(ctx);
    if (plan.status !== "prepared") throw new Error(plan.status);
    expect(plan.episode.input.parentEpisodeId).toBe("parent");
    expect(plan.episode.input.deltaContent).toBeTypeOf("string");
    expect(reconstruct).toHaveBeenCalledOnce();
    reconstruct.mockRejectedValueOnce(new Error("unavailable"));
    const fallback = await run(ctx);
    if (fallback.status !== "prepared") throw new Error(fallback.status);
    expect(fallback.episode.input.parentEpisodeId).toBeUndefined();
  });
  it("never reconstructs delta ancestors above episode classification", async () => {
    const { ctx } = fixture();
    ctx.embed.embedSingle = async () => new Float32Array([1, 0]);
    ctx.storage.findSimilarEpisodes = async () => [{ id: "parent", score: 0.99 }] as never;
    ctx.storage.getEpisode = async (id) =>
      ({
        id,
        workspaceId: "ws",
        sensitivity: id === "parent" ? "internal" : "restricted",
        parentEpisodeId: id === "parent" ? "secret-ancestor" : undefined,
      }) as never;
    const reconstruct = vi.fn();
    ctx.storage.reconstructEpisode = reconstruct;
    const plan = await run(ctx);
    if (plan.status !== "prepared") throw new Error(plan.status);
    expect(plan.episode.input.parentEpisodeId).toBeUndefined();
    expect(reconstruct).not.toHaveBeenCalled();
  });
  it("validates hyperedge membership and performs no writes even with full extraction", async () => {
    const { ctx, generate, writes } = fixture({
      ...empty,
      facts: [0, 1, 2].map((i) => ({ content: `Fact ${i}`, sourceMessageIds: ["m0"] })),
    });
    generate.mockResolvedValueOnce({
      content: JSON.stringify({
        ...empty,
        facts: [0, 1, 2].map((i) => ({ content: `Fact ${i}`, sourceMessageIds: ["m0"] })),
      }),
      tokensUsed: { input: 1, output: 2 },
      model: "test",
    });
    generate.mockResolvedValueOnce({
      content: "[[0,0,0],[0,1,99],[0,1,2],[2,1,0]]",
      tokensUsed: { input: 3, output: 4 },
      model: "test",
    });
    const plan = await run(ctx);
    if (plan.status !== "prepared") throw new Error(plan.status);
    expect(plan.hyperedges).toHaveLength(1);
    expect(new Set(plan.hyperedges[0]?.memberIds).size).toBe(3);
    expect(plan.relations).toHaveLength(3);
    expect(plan.worthUpdates).toHaveLength(3);
    expect(plan.summary.llmTokensUsed).toBe(10);
    expect(writes).not.toHaveBeenCalled();
  });
  it("fails closed on missing provenance and cross-workspace turns", async () => {
    const { ctx, generate } = fixture();
    expect(await run(ctx, { session: { ...session, originActorId: null } })).toMatchObject({
      status: "retryable",
      reason: "invalid_provenance",
    });
    expect(
      await run(ctx, { turns: [{ ...turns[0], workspaceId: "foreign" }, turns[1]] })
    ).toMatchObject({ status: "retryable", reason: "invalid_session" });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("managed preparation review regressions", () => {
  it("accepts fractional confidence and stable content keys independently of object key order", async () => {
    const { ctx, generate } = fixture({
      ...empty,
      facts: [{ content: "Durable fact", confidence: 0.8, sourceMessageIds: ["m0"] }],
    });
    const first = await run(ctx);
    expect(first.status).toBe("prepared");
    if (first.status !== "prepared") throw new Error(first.status);
    expect(first.candidates[0]?.input).toMatchObject({ confidence: 0.8 });
    generate.mockResolvedValueOnce({
      content: JSON.stringify({
        ...empty,
        facts: [{ sourceMessageIds: ["m0"], confidence: 0.8, content: "Durable fact" }],
      }),
      tokensUsed: { input: 10, output: 20 },
      model: "test",
    });
    const second = await run(ctx);
    if (second.status !== "prepared") throw new Error(second.status);
    expect(second.candidates[0]?.id).toBe(first.candidates[0]?.id);
  });
  it("applies database decision-topic normalization to ceiling rejection", async () => {
    const { ctx } = fixture({
      ...empty,
      goal: "SECRET-DECISION",
      decisions: [
        {
          title: "SECRET-DECISION",
          body: "Sensitive rationale",
          topicKey: " Database ",
          sourceMessageIds: ["m0"],
        },
      ],
    });
    const plan = await run(ctx, {
      existingTopics: [
        { kind: "decision", id: "prior", topicKey: "database", sensitivity: "restricted" },
      ],
    });
    if (plan.status !== "prepared") throw new Error(plan.status);
    expect(plan.candidates).toHaveLength(0);
    expect(plan.rejectedCandidates).toHaveLength(1);
    expect(JSON.stringify(plan)).not.toContain("SECRET-DECISION");
  });
  it("keeps an LLM outage retryable even if recurrence is low", async () => {
    const { ctx } = fixture();
    ctx.llm = null;
    ctx.embed.embed = async () => [
      [1, 0],
      [0, 1],
    ];
    expect(await run(ctx, { session: { ...session, closeKind: "provisional" } })).toMatchObject({
      status: "retryable",
      reason: "llm_unavailable",
    });
  });
});

it("allocates the deterministic operation identity for a newly claimed session", async () => {
  const { ctx } = fixture();
  const plan = await run(ctx, { session: { ...session, collapseOperationId: null } });
  expect(plan.status).toBe("prepared");
  expect(plan.operationId).toBe("managed:ws:s:0");
});
