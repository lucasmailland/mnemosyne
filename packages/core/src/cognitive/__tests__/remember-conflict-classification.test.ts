/**
 * WP-7 — an agent is asked to judge only a CLASSIFIED contradiction.
 *
 * Measured before this change (eval 2026-10-17): 42 of 62 writes came back
 * `judgmentRequired:true` (AGENTSIM-3), 107 of 145 (RECALL-13), 641 writes left
 * 3,037 review items and 3,028 pending `conflicts_with` (CHAOS-11), 6 of 11
 * "conflicts" were paraphrases and four paraphrases stayed live side by side
 * (LIFECYCLE-11). The cause was one: cosine ≥ 0.55 was promoted straight into
 * a conflict. Similarity says two facts are about the same thing, never that
 * they disagree.
 *
 * Now every candidate goes through the fact-pair classifier BEFORE anything is
 * persisted:
 *   - CONTRADICTION → pending conflicts_with relation + judgmentRequired;
 *   - DUPLICATE     → the write reuses the existing fact (under guards);
 *   - COMPATIBLE    → nothing;
 *   - no verdict (no LLM, error, timeout) → nothing at write time, the pair
 *     rides to the async scoped check, and the failure is logged.
 *
 * Embeddings are 2-D unit vectors at exact cosines: the incoming statement is
 * always [1, 0] and a seeded fact at `at(c)` sits at cosine c from it.
 */
import { describe, it, expect, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { AuthContext, RememberRequest } from "@mnemo-ai/types";
import { remember } from "../remember.js";

const WS = "ws-classify";
const QUERY = new Float32Array([1, 0]);
const at = (c: number): number[] => [c, Math.sqrt(1 - c * c)];

const auth: AuthContext = {
  workspaceId: WS,
  actorId: "key:k1",
  actorType: "agent",
  userId: null,
  scopes: ["memory:write"] as never,
};

type Verdict = "DUPLICATE" | "CONTRADICTION" | "COMPATIBLE";

/** An LLM whose verdict is keyed by a substring of the EXISTING statement. */
function stubLlm(
  verdicts: Record<string, Verdict | Error | "hang">,
  fallback: Verdict = "COMPATIBLE"
) {
  return {
    id: "stub",
    model: "stub-model",
    generate: vi.fn(async (input: { messages: Array<{ content: string }> }) => {
      const prompt = input.messages[0]?.content ?? "";
      const b = /B: "([\s\S]*?)"\n/.exec(prompt)?.[1] ?? "";
      let verdict: Verdict | Error | "hang" = fallback;
      for (const [key, v] of Object.entries(verdicts)) if (b.includes(key)) verdict = v;
      if (verdict === "hang") return new Promise<never>(() => {});
      if (verdict instanceof Error) throw verdict;
      return { content: verdict, tokensUsed: { input: 5, output: 1 }, model: "stub-model" };
    }),
    generateStructured: async () => {
      throw new Error("unused");
    },
    healthCheck: async () => ({ healthy: true }),
  };
}

function makeCtx(
  storage: InMemoryStorageAdapter,
  llm?: ReturnType<typeof stubLlm>,
  opts: { timeoutMs?: number; classify?: boolean } = {}
) {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const vector = { search: vi.fn(async () => []), upsert: vi.fn(async () => {}) };
  const ctx = {
    storage,
    vector,
    embed: { model: "test-embed", embedSingle: async () => QUERY },
    telemetry: { startSpan: () => ({ end: () => {} }) },
    logger,
    ...(llm ? { llm } : {}),
    config: {
      surpriseThreshold: 0,
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 3600,
      injectionScoreThreshold: 0.85,
      anomalyScoreThreshold: 0.8,
      ...(opts.classify === false ? {} : { writeConflictClassification: true }),
      ...(opts.timeoutMs !== undefined ? { conflictClassificationTimeoutMs: opts.timeoutMs } : {}),
    },
  };
  return { ctx: ctx as never, logger, vector };
}

async function seed(
  storage: InMemoryStorageAdapter,
  statement: string,
  cosine: number,
  extra: Record<string, unknown> = {}
) {
  return storage.createFact({
    workspaceId: WS,
    scope: "global",
    kind: "other",
    subject: "general",
    statement,
    attribution: "user_stated",
    embedding: at(cosine),
    ...extra,
  } as never);
}

const write = (content: string, extra: Partial<RememberRequest> = {}): RememberRequest =>
  ({ workspaceId: WS, kind: "fact", content, ...extra }) as RememberRequest;

async function conflictRelations(storage: InMemoryStorageAdapter) {
  return storage.getRelations({ workspaceId: WS, verb: "conflicts_with" });
}

function scopedJobCandidateIds(storage: InMemoryStorageAdapter, factId: string): string[] {
  const job = storage.outbox.find(
    (e) =>
      e.eventType === "queue_job" &&
      (e.payload as { job?: string }).job === "scoped_semantic_conflict_check" &&
      (e.payload as { data?: { factId?: string } }).data?.factId === factId
  );
  return (
    (job?.payload as { data?: { candidates?: Array<{ id: string }> } } | undefined)?.data
      ?.candidates ?? []
  ).map((c) => c.id);
}

describe("remember() — similarity alone never asks for judgment", () => {
  it("a similar but COMPATIBLE fact: no conflict, no review item, no relation", async () => {
    const storage = new InMemoryStorageAdapter();
    await seed(storage, "Sofía Lind is the design lead", 0.72);
    const { ctx } = makeCtx(storage, stubLlm({ "Sofía Lind": "COMPATIBLE" }));

    const res = await remember(ctx, write("The mobile app uses Expo SDK 51"), auth);

    expect("conflict" in res).toBe(false);
    expect(storage.reviewItems.filter((r) => r.reason === "contradiction")).toHaveLength(0);
    expect(await conflictRelations(storage)).toHaveLength(0);
  });

  it("a CLASSIFIED contradiction: judgmentRequired with a judgeable relation", async () => {
    const storage = new InMemoryStorageAdapter();
    const existing = await seed(storage, "ledger-api runs on PostgreSQL 15", 0.91);
    const { ctx } = makeCtx(storage, stubLlm({ "PostgreSQL 15": "CONTRADICTION" }));

    const res = await remember(ctx, write("ledger-api requires PostgreSQL 17"), auth);

    expect(res.conflict?.judgmentRequired).toBe(true);
    expect(res.conflict?.candidates.map((c) => c.id)).toEqual([existing.id]);
    const relations = await conflictRelations(storage);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ sourceId: res.id, targetId: existing.id });
    expect(res.conflict?.candidates[0]?.relationId).toBe(relations[0]?.id);
    // The review row points at the relation it describes.
    const review = storage.reviewItems.filter((r) => r.reason === "contradiction");
    expect(review).toHaveLength(1);
    expect(review[0]?.detail).toMatchObject({
      contradictsFactId: existing.id,
      relationId: relations[0]?.id,
      classification: "CONTRADICTION",
    });
  });

  it("only the contradicting candidate is reported when several are similar", async () => {
    const storage = new InMemoryStorageAdapter();
    const contra = await seed(storage, "the nightly reindex for kappa-1 starts at 01:15", 0.95);
    await seed(storage, "the nightly reindex for kappa-2 starts at 02:15", 0.94);
    await seed(storage, "the export job for tenant t0 runs on worker w0", 0.8);
    const { ctx } = makeCtx(storage, stubLlm({ "kappa-1": "CONTRADICTION" }));

    const res = await remember(ctx, write("the nightly reindex for kappa-1 starts at 04:15"), auth);

    expect(res.conflict?.candidates.map((c) => c.id)).toEqual([contra.id]);
    expect(await conflictRelations(storage)).toHaveLength(1);
  });
});

describe("remember() — no verdict means no conflict, and a logged deferral", () => {
  it("LLM throws: write stored, no conflict, warning logged, pair deferred", async () => {
    const storage = new InMemoryStorageAdapter();
    const existing = await seed(storage, "ledger-api runs on PostgreSQL 15", 0.91);
    const { ctx, logger } = makeCtx(
      storage,
      stubLlm({ "PostgreSQL 15": new Error("model unavailable") })
    );

    const res = await remember(ctx, write("ledger-api requires PostgreSQL 17"), auth);

    expect((await storage.getFact(res.id, WS))?.status).toBe("active");
    expect("conflict" in res).toBe(false);
    expect(await conflictRelations(storage)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("conflict classification failed"),
      expect.objectContaining({ candidateId: existing.id, reason: "llm_error" })
    );
    expect(scopedJobCandidateIds(storage, res.id)).toEqual([existing.id]);
  });

  it("no LLM configured: no conflict; candidates below 0.85 still reach the scoped check", async () => {
    const storage = new InMemoryStorageAdapter();
    const existing = await seed(storage, "usamos Postgres como base principal", 0.69);
    const { ctx } = makeCtx(storage);

    const res = await remember(ctx, write("ya no usamos Postgres, migramos a MySQL"), auth);

    expect("conflict" in res).toBe(false);
    expect(await conflictRelations(storage)).toHaveLength(0);
    expect(scopedJobCandidateIds(storage, res.id)).toEqual([existing.id]);
  });

  it("classification off (the default): no lookup, no LLM call, nothing deferred", async () => {
    const storage = new InMemoryStorageAdapter();
    await seed(storage, "ledger-api runs on PostgreSQL 15", 0.91);
    await seed(storage, "usamos Postgres como base principal", 0.69);
    const llm = stubLlm({ "PostgreSQL 15": "CONTRADICTION" }, "CONTRADICTION");
    const { ctx } = makeCtx(storage, llm, { classify: false });
    const lookup = vi.spyOn(storage, "findContradictingFacts");

    const res = await remember(ctx, write("ledger-api requires PostgreSQL 17"), auth);

    expect("conflict" in res).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(llm.generate).not.toHaveBeenCalled();
    expect(await conflictRelations(storage)).toHaveLength(0);
    expect(scopedJobCandidateIds(storage, res.id)).toEqual([]);
  });

  it("LLM hangs: the write returns at the deadline and the pair is deferred", async () => {
    const storage = new InMemoryStorageAdapter();
    const existing = await seed(storage, "ledger-api runs on PostgreSQL 15", 0.91);
    const { ctx } = makeCtx(storage, stubLlm({ "PostgreSQL 15": "hang" }), { timeoutMs: 30 });

    const res = await remember(ctx, write("ledger-api requires PostgreSQL 17"), auth);

    expect("conflict" in res).toBe(false);
    expect(scopedJobCandidateIds(storage, res.id)).toEqual([existing.id]);
  });

  it("after an LLM failure the classifier is skipped for a while instead of failing every write", async () => {
    const storage = new InMemoryStorageAdapter();
    await seed(storage, "ledger-api runs on PostgreSQL 15", 0.91);
    const llm = stubLlm({ "PostgreSQL 15": new Error("model unavailable") });
    const { ctx } = makeCtx(storage, llm);

    await remember(ctx, write("ledger-api requires PostgreSQL 17"), auth);
    const callsAfterFirst = llm.generate.mock.calls.length;
    const second = await remember(ctx, write("ledger-api requires PostgreSQL 18"), auth);

    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(llm.generate.mock.calls.length).toBe(callsAfterFirst);
    expect(scopedJobCandidateIds(storage, second.id).length).toBeGreaterThan(0);
  });

  it("a classified contradiction whose relation write fails is handed to the scoped check", async () => {
    // WP-7 review — the pair counted as done once classified, so a failed
    // relation write dropped it from the scoped job too: no conflict in the
    // response and no retry anywhere.
    const storage = new InMemoryStorageAdapter();
    const existing = await seed(storage, "ledger-api runs on PostgreSQL 15", 0.91);
    vi.spyOn(storage, "createRelation").mockRejectedValue(new Error("relation write failed"));
    const { ctx } = makeCtx(storage, stubLlm({ "PostgreSQL 15": "CONTRADICTION" }));

    const res = await remember(ctx, write("ledger-api requires PostgreSQL 17"), auth);

    expect("conflict" in res).toBe(false);
    expect(scopedJobCandidateIds(storage, res.id)).toEqual([existing.id]);
  });

  it("a classified pair is not sent to the scoped check again", async () => {
    const storage = new InMemoryStorageAdapter();
    const existing = await seed(storage, "Sofía Lind is the design lead", 0.9);
    const { ctx } = makeCtx(storage, stubLlm({ "Sofía Lind": "COMPATIBLE" }));
    (ctx as { vector: { search: unknown } }).vector.search = async () => [
      { id: existing.id, score: 0.9 },
    ];

    const res = await remember(ctx, write("The mobile app uses Expo SDK 51"), auth);

    expect(scopedJobCandidateIds(storage, res.id)).toEqual([]);
  });
});

describe("remember() — a confident paraphrase reuses the existing fact (LIFECYCLE-11)", () => {
  it("DUPLICATE at cosine ≥ 0.85: same id back, no second live copy, no conflict", async () => {
    const storage = new InMemoryStorageAdapter();
    const existing = await seed(storage, "ledger-api requires PostgreSQL 17 (MERGE in 0007)", 0.93);
    const { ctx, vector } = makeCtx(storage, stubLlm({ "PostgreSQL 17": "DUPLICATE" }));

    const res = await remember(ctx, write("ledger-api needs Postgres 17 because of MERGE"), auth);

    expect(res.id).toBe(existing.id);
    // What memory holds is the existing statement, and the caller is told so.
    expect(res.storedContent).toBe(existing.statement);
    expect("conflict" in res).toBe(false);
    const active = await storage.queryFacts({ workspaceId: WS, status: "active" } as never);
    expect(active.items).toHaveLength(1);
    // The existing fact's vector must not be overwritten with the paraphrase's.
    expect(vector.upsert).not.toHaveBeenCalled();
  });

  it("repeating a reused paraphrase is still a reuse: twin's index untouched, twin's text reported", async () => {
    // WP-7 review — the first reuse points the paraphrase's hash at the twin,
    // so the repeat takes the content-hash path. That path reported the
    // repeat as a fresh write: the twin's vector and LSH bands were
    // overwritten with the paraphrase's, and `storedContent` echoed wording
    // the row does not hold.
    const storage = new InMemoryStorageAdapter();
    const existing = await seed(storage, "ledger-api requires PostgreSQL 17 (MERGE in 0007)", 0.93);
    const { ctx, vector } = makeCtx(storage, stubLlm({ "PostgreSQL 17": "DUPLICATE" }));

    const first = await remember(ctx, write("ledger-api needs Postgres 17 because of MERGE"), auth);
    const again = await remember(ctx, write("ledger-api needs Postgres 17 because of MERGE"), auth);

    expect(first.id).toBe(existing.id);
    expect(again.id).toBe(existing.id);
    expect(again.storedContent).toBe(existing.statement);
    expect(vector.upsert).not.toHaveBeenCalled();
    const lshForTwin = storage.outbox.filter(
      (e) =>
        e.eventType === "lsh_upsert" && (e.payload as { factId?: string }).factId === existing.id
    );
    expect(lshForTwin).toHaveLength(0);
  });

  it("four paraphrases in a row leave one live fact", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage, stubLlm({}, "DUPLICATE"));

    const ids = new Set<string>();
    for (const s of [
      "ledger-api requires PostgreSQL 17 (MERGE in 0007)",
      "ledger-api needs Postgres 17 because migration 0007 uses MERGE",
      "PostgreSQL 17 is required by ledger-api for MERGE",
      "ledger-api depends on PG17 (MERGE, migration 0007)",
    ]) {
      ids.add((await remember(ctx, write(s), auth)).id);
    }

    expect(ids.size).toBe(1);
    const active = await storage.queryFacts({ workspaceId: WS, status: "active" } as never);
    expect(active.items).toHaveLength(1);
  });

  for (const [label, seedExtra, writeExtra, cosine] of [
    ["a different scopeRef", { scopeRef: "proj-a" }, { scopeRef: "proj-b" }, 0.95],
    ["a different sensitivity", {}, { sensitivity: "confidential" }, 0.95],
    ["a topicKey on the write", {}, { topicKey: "ledger/pg-version" }, 0.95],
    ["a different specific subject", { subject: "ledger-api" }, { subject: "billing-api" }, 0.95],
    ["cosine below 0.85", {}, {}, 0.8],
    // Stored encrypted: no plaintext to compare or to report back.
    [
      "a confidential tier on both sides",
      { sensitivity: "confidential" },
      { sensitivity: "confidential" },
      0.95,
    ],
  ] as const) {
    it(`DUPLICATE with ${label}: stored as its own fact`, async () => {
      const storage = new InMemoryStorageAdapter();
      const existing = await seed(storage, "ledger-api requires PostgreSQL 17", cosine, {
        ...seedExtra,
      });
      const { ctx } = makeCtx(storage, stubLlm({ "PostgreSQL 17": "DUPLICATE" }));

      const res = await remember(
        ctx,
        write("ledger-api needs Postgres 17", { ...writeExtra } as Partial<RememberRequest>),
        auth
      );

      expect(res.id).not.toBe(existing.id);
      expect("conflict" in res).toBe(false);
    });
  }
});
