/**
 * WP-5 — remember()'s persistence path.
 *
 *   - CHAOS-5: an embedder that is configured but not answering used to turn
 *     every write into a 500 with nothing stored. The write now lands, FTS can
 *     find it at once, and the embedding is queued for the outbox worker.
 *   - CHAOS-7: two identical concurrent writes race on `uniq_mnemo_fact_dedup`;
 *     the loser used to get a 500 although its content was stored. It now gets
 *     the winner's id — the write landed.
 *   - AGENTSIM-7: `kind:"decision"` stored `title = subject` and dropped
 *     `scopeRef` and the session.
 *   - Entities: a duplicate live name is a conflict, never a 500.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { AuthContext } from "@mnemo-ai/types";
import { remember, RememberConflictError } from "../remember.js";

const WS = "ws-remember-integrity";
const auth: AuthContext = {
  workspaceId: WS,
  actorId: "key:remember-integrity",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

function makeCtx(
  storage: InMemoryStorageAdapter,
  opts: { embed?: () => Promise<Float32Array>; model?: string } = {}
) {
  const vector = {
    search: vi.fn(async () => []),
    upsert: vi.fn(async () => undefined),
  };
  const embedSingle = vi.fn(opts.embed ?? (async () => new Float32Array([0.1, 0.2, 0.3])));
  return {
    vector,
    embedSingle,
    ctx: {
      storage,
      vector,
      embed: { model: opts.model ?? "test-embed-model", embedSingle },
      telemetry: {
        startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {} }),
      },
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      config: {
        surpriseThreshold: 0,
        maxHotTierSize: 1000,
        worthDecayLambda: 0.1,
        hotTierTtlSeconds: 3600,
        injectionScoreThreshold: 0.85,
        anomalyScoreThreshold: 0.8,
      },
    } as never,
  };
}

const embedderDown = async (): Promise<Float32Array> => {
  throw new Error("LLMProviderError: connect ECONNREFUSED 127.0.0.1:1");
};

describe("CHAOS-5 — embedder down: store now, embed later", () => {
  it("stores the fact, queues a text-form embedding job and touches no vector index", async () => {
    const storage = new InMemoryStorageAdapter();
    const createFact = vi.spyOn(storage, "createFact");
    const contradictions = vi.spyOn(storage, "findContradictingFacts");
    const { ctx, vector } = makeCtx(storage, { embed: embedderDown });

    const res = await remember(
      ctx,
      { workspaceId: WS, kind: "fact", content: "the billing queue retries three times" },
      auth
    );

    expect(res.embeddingDeferred).toBe(true);
    const saved = await storage.getFact(res.id, WS);
    expect(saved?.statement).toBe("the billing queue retries three times");
    expect(createFact.mock.calls[0]![0]).not.toHaveProperty("embedding");
    expect(createFact.mock.calls[0]![0]).toMatchObject({ vectorJob: { indexLsh: true } });
    expect(vector.search).not.toHaveBeenCalled();
    expect(vector.upsert).not.toHaveBeenCalled();
    // Write-time conflict detection needs the vector; it is not faked with
    // an empty one (WP-7 owns running it once the embedding exists).
    expect(contradictions).not.toHaveBeenCalled();
    const jobs = storage.outbox.filter(
      (e) => e.eventType === "vector_upsert" && (e.payload as { id?: string }).id === res.id
    );
    expect(jobs.map((j) => (j.payload as { text?: string }).text)).toEqual([
      "the billing queue retries three times",
    ]);
    expect(storage.outbox.some((e) => e.eventType === "lsh_upsert")).toBe(false);
  });

  it("still redacts PII before storing a deferred write", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage, { embed: embedderDown });
    const res = await remember(
      ctx,
      { workspaceId: WS, kind: "fact", content: "ops pager is ops-oncall@example.com" },
      auth
    );
    const saved = await storage.getFact(res.id, WS);
    expect(saved?.statement).not.toContain("ops-oncall@example.com");
    expect(res.redactedCategories?.length).toBeGreaterThan(0);
  });

  it("queues a text-form job for a kind remember() indexes itself (entity)", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage, { embed: embedderDown });
    const res = await remember(
      ctx,
      { workspaceId: WS, kind: "entity", subject: "Brindlecrest", content: "an analytics vendor" },
      auth
    );
    expect(res.embeddingDeferred).toBe(true);
    const job = storage.outbox.find(
      (e) => e.eventType === "vector_upsert" && (e.payload as { id?: string }).id === res.id
    );
    expect(job?.payload).toMatchObject({ kind: "entity", text: "an analytics vendor" });
    expect(job?.payload).not.toHaveProperty("vector");
  });

  it("stores a recallable non-fact kind, whose repository queues its own text job", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage, { embed: embedderDown });
    const res = await remember(
      ctx,
      { workspaceId: WS, kind: "strategy", subject: "When CI is red", content: "rerun once" },
      auth
    );
    expect(res.embeddingDeferred).toBe(true);
    expect(await storage.getStrategy(res.id, WS)).not.toBeNull();
  });

  it("keeps the 501 when no embedder is configured at all (a deploy choice, not an outage)", async () => {
    const storage = new InMemoryStorageAdapter();
    const notConfigured = Object.assign(new Error("No embed adapter configured"), {
      status: 501,
    });
    const { ctx } = makeCtx(storage, {
      model: "none",
      embed: async () => {
        throw notConfigured;
      },
    });
    await expect(
      remember(ctx, { workspaceId: WS, kind: "fact", content: "x marks the spot" }, auth)
    ).rejects.toBe(notConfigured);
  });

  it("reports nothing deferred on the normal path", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage);
    const res = await remember(
      ctx,
      { workspaceId: WS, kind: "fact", content: "embedded right away" },
      auth
    );
    expect(res.embeddingDeferred).toBeUndefined();
  });
});

/** The shape drizzle-orm + postgres.js throw for a unique violation. */
function uniqueViolation(constraint: string) {
  return Object.assign(new Error("Failed query: insert into mnemosyne.mnemo_fact ..."), {
    cause: Object.assign(
      new Error(`duplicate key value violates unique constraint "${constraint}"`),
      { code: "23505", constraint_name: constraint }
    ),
  });
}

describe("CHAOS-7 — a lost dedup race returns the winner's id", () => {
  it("re-reads the live row on uniq_mnemo_fact_dedup instead of failing", async () => {
    const storage = new InMemoryStorageAdapter();
    const winner = await storage.createFact({
      workspaceId: WS,
      statement: "the deploy window is friday 14:00",
      subject: "general",
      kind: "other",
      scope: "global",
      attribution: "user_stated",
    } as never);
    // The loser read no hash row (the winner had not written it yet), then
    // lost the INSERT on the unique index.
    vi.spyOn(storage, "lookupFactHash").mockResolvedValue(null);
    vi.spyOn(storage, "createFact").mockRejectedValue(uniqueViolation("uniq_mnemo_fact_dedup"));
    const { ctx } = makeCtx(storage);

    const res = await remember(
      ctx,
      { workspaceId: WS, kind: "fact", content: "the deploy window is friday 14:00" },
      auth
    );
    expect(res.id).toBe(winner.id);
  });

  it("recognises a wrapped topic-key race and merges into the winner", async () => {
    const storage = new InMemoryStorageAdapter();
    const winner = await storage.createFact({
      workspaceId: WS,
      statement: "deploys go through ArgoCD",
      subject: "general",
      kind: "other",
      scope: "global",
      attribution: "user_stated",
      topicKey: "infra/deploy",
    } as never);
    const merge = vi.spyOn(storage, "mergeFactByTopicKey");
    merge.mockResolvedValueOnce(null); // the first lookup ran before the winner committed
    vi.spyOn(storage, "createFact").mockRejectedValue(
      uniqueViolation("idx_fact_topic_active_unique")
    );
    const { ctx } = makeCtx(storage);

    const res = await remember(
      ctx,
      {
        workspaceId: WS,
        kind: "fact",
        content: "deploys go through Flux",
        topicKey: "infra/deploy",
      },
      auth
    );
    expect(merge).toHaveBeenCalledTimes(2);
    expect(res.kind).toBe("fact");
    expect(winner.id).toBeTruthy();
  });

  it("rethrows a unique violation it cannot resolve", async () => {
    const storage = new InMemoryStorageAdapter();
    vi.spyOn(storage, "createFact").mockRejectedValue(uniqueViolation("some_other_index"));
    const { ctx } = makeCtx(storage);
    await expect(
      remember(ctx, { workspaceId: WS, kind: "fact", content: "unresolvable" }, auth)
    ).rejects.toThrow("Failed query");
  });
});

describe("AGENTSIM-7 — remember(kind:'decision') keeps its context", () => {
  // A keyless decision is created through createDecisionUnlessDuplicate since
  // WP-7's atomic dedup (PRIM-18); the input it receives is the row written.
  it("titles the decision from the statement and forwards scopeRef, session and subject", async () => {
    const storage = new InMemoryStorageAdapter();
    const createDecision = vi.spyOn(storage, "createDecisionUnlessDuplicate");
    const { ctx } = makeCtx(storage);
    const statement =
      "ledgerly: payments-api is a Node 20 Fastify service. It talks to Postgres 16 on RDS.";

    await remember(
      ctx,
      {
        workspaceId: WS,
        kind: "decision",
        subtype: "architecture",
        subject: "payments-api",
        content: statement,
        scopeRef: "ledgerly",
        sessionId: "sess-42",
      },
      auth
    );

    const input = createDecision.mock.calls[0]![0];
    expect(input.title).toBe("ledgerly: payments-api is a Node 20 Fastify service.");
    expect(input.body).toBe(statement);
    expect(input.scopeRef).toBe("ledgerly");
    expect(input.conversationId).toBe("sess-42");
    expect(input.metadata).toMatchObject({ subject: "payments-api" });
  });

  it("prefers an explicit conversationId and caps a long first sentence", async () => {
    const storage = new InMemoryStorageAdapter();
    const createDecision = vi.spyOn(storage, "createDecisionUnlessDuplicate");
    const { ctx } = makeCtx(storage);
    const long = "word ".repeat(80).trim();

    await remember(
      ctx,
      {
        workspaceId: WS,
        kind: "decision",
        content: long,
        conversationId: "conv-1",
        sessionId: "sess-1",
      },
      auth
    );

    const input = createDecision.mock.calls[0]![0];
    expect(input.conversationId).toBe("conv-1");
    expect(input.title.length).toBeLessThanOrEqual(120);
    expect(input.title.endsWith("…")).toBe(true);
    expect(input.body).toBe(long);
  });

  it("forwards the same context on the topic-key update path", async () => {
    const storage = new InMemoryStorageAdapter();
    const merge = vi.spyOn(storage, "mergeDecisionByTopicKey");
    const { ctx } = makeCtx(storage);

    await remember(
      ctx,
      {
        workspaceId: WS,
        kind: "decision",
        content: "We use Kafka. Throughput needs it.",
        topicKey: "arch/queue",
        scopeRef: "ledgerly",
        sessionId: "sess-7",
      },
      auth
    );

    expect(merge.mock.calls[0]![0]).toMatchObject({
      title: "We use Kafka.",
      body: "We use Kafka. Throughput needs it.",
      scopeRef: "ledgerly",
      conversationId: "sess-7",
    });
  });
});

describe("entities — a duplicate live name is a conflict, not a 500", () => {
  it.each([
    ["the typed storage conflict", Object.assign(new Error("exists"), { code: "conflict" })],
    ["a raw unique violation", uniqueViolation("mnemo_entity_workspace_id_name_kind_key")],
  ])("maps %s to RememberConflictError", async (_label, failure) => {
    const storage = new InMemoryStorageAdapter();
    vi.spyOn(storage, "createEntity").mockRejectedValue(failure);
    const { ctx } = makeCtx(storage);
    await expect(
      remember(
        ctx,
        { workspaceId: WS, kind: "entity", subject: "Quartzfinch Corp", content: "a vendor" },
        auth
      )
    ).rejects.toBeInstanceOf(RememberConflictError);
  });
});

describe("review round — the entity conflict does not hand out unreadable ids", () => {
  it("carries the existing entity's sensitivity beside, not inside, the response details", async () => {
    const storage = new InMemoryStorageAdapter();
    const existing = await storage.createEntity({
      workspaceId: WS,
      name: "Vaultkeeper",
      kind: "organization",
      sensitivity: "restricted",
    } as never);
    vi.spyOn(storage, "createEntity").mockRejectedValue(
      Object.assign(new Error("exists"), { code: "conflict" })
    );
    const { ctx } = makeCtx(storage);
    const failure = await remember(
      ctx,
      {
        workspaceId: WS,
        kind: "entity",
        subtype: "organization",
        subject: "Vaultkeeper",
        content: "x",
      },
      auth
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(RememberConflictError);
    expect((failure as RememberConflictError).existingSensitivity).toBe("restricted");
    expect((failure as RememberConflictError).details).toMatchObject({ existingId: existing.id });
    expect((failure as RememberConflictError).details).not.toHaveProperty("sensitivity");
  });
});
