import { describe, it, expect, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import type { AuthContext } from "@mnemo-ai/types";

// §33 Distributed Consensus on the PRODUCTION fact-write path.
//
// remember() now surfaces contradicting active facts via the storage port
// (findContradictingFacts) and runs the PURE deterministic resolver
// (decideAutoResolution) for each, applying the verdict with EXISTING port
// methods: supersede → archiveFact, reject/review → enqueueReviewItem (the
// incoming explicit create is always kept — onReject:"review" semantics).
//
// WP-7: a candidate is persisted as a conflict only once the fact-pair
// classifier calls it a CONTRADICTION (remember-conflict-classification.test.ts
// covers the other verdicts). This file is about what happens AFTER that
// verdict — the §33 action, the relation, the review row — so its LLM confirms
// every pair it is shown.
const confirmsEveryPair = {
  id: "stub",
  model: "stub-model",
  generate: async () => ({
    content: "CONTRADICTION",
    tokensUsed: { input: 5, output: 1 },
    model: "stub-model",
  }),
};

function makeCtx(storage: InMemoryStorageAdapter) {
  return {
    storage,
    vector: { search: async () => [] }, // pe = 1.0 → never surprise-gated
    embed: { embedSingle: async () => new Float32Array(3).fill(0.1) },
    llm: confirmsEveryPair,
    telemetry: { startSpan: () => ({ end: () => {} }) },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    config: {
      surpriseThreshold: 0,
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 3600,
      writeConflictClassification: true,
    },
  } as never;
}

const auth: AuthContext = {
  workspaceId: "ws-test",
  actorId: "agent-1",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

describe("remember() — §33 deterministic contradiction resolution", () => {
  it("supersedes a dominated existing fact when the incoming wins decisively", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    // Existing low-trust fact (inferred, trust 40).
    const existing = await storage.createFact({
      workspaceId: "ws-test",
      scope: "global",
      kind: "other",
      subject: "deploy-target",
      statement: "we deploy to AWS",
      attribution: "inferred",
    });
    expect(existing.status).toBe("active");

    // Incoming high-trust contradicting fact (objective_fact, trust 100) on the
    // SAME subject → trust anchor differs → conf 0.9 > 0.7 → incoming supersedes.
    await remember(
      ctx,
      {
        workspaceId: "ws-test",
        kind: "fact",
        content: "we deploy to GCP",
        subject: "deploy-target",
        provenance: "objective_fact",
      },
      auth
    );

    // P108 — the dominated fact is NOT archived any more. The verdict is real
    // (trust anchor, conf 0.9) but the PREMISE was never established:
    // findContradictingFacts matches on same-subject OR term overlap with no
    // polarity analysis, so "supersede" only ever meant "these two share words
    // and one has better attribution". Both facts stay active and the conflict
    // is queued for a resolver that can actually read them.
    const stillThere = await storage.getFact(existing.id, "ws-test");
    expect(stillThere?.status).toBe("active");

    const active = await storage.queryFacts({
      workspaceId: "ws-test",
      subject: undefined,
      status: "active",
    } as never);
    expect(active.items).toHaveLength(2);

    // The verdict survives where a resolver can see it.
    const review = storage.reviewItems.find((r) => r.reason === "contradiction");
    expect(review).toBeDefined();
    expect((review!.detail as { action?: string }).action).toBe("supersede");
  });

  it("keeps the incoming explicit create and enqueues review when the existing dominates", async () => {
    const storage = new InMemoryStorageAdapter();
    const enqueueSpy = vi.spyOn(storage, "enqueueReviewItem");
    const ctx = makeCtx(storage);

    // Existing high-trust fact (objective_fact, trust 100).
    const existing = await storage.createFact({
      workspaceId: "ws-test",
      scope: "global",
      kind: "other",
      subject: "db-engine",
      statement: "the database is Postgres",
      attribution: "objective_fact",
    });

    // Incoming low-trust contradicting fact (inferred, trust 40) → existing
    // dominates (winner local, conf 0.9) → reject verdict. As an EXPLICIT
    // create we never silently drop it: keep it + enqueue review.
    await remember(
      ctx,
      {
        workspaceId: "ws-test",
        kind: "fact",
        content: "the database is MySQL",
        subject: "db-engine",
        provenance: "inferred",
      },
      auth
    );

    // The existing dominant fact is untouched (still active).
    expect((await storage.getFact(existing.id, "ws-test"))?.status).toBe("active");

    // The incoming fact is preserved (still active — never silently dropped).
    const incoming = (
      await storage.queryFacts({ workspaceId: "ws-test", status: "active" })
    ).items.find((f) => f.statement === "the database is MySQL");
    expect(incoming).toBeDefined();

    // A contradiction review was enqueued for the incoming fact.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-test",
        primitiveId: incoming!.id,
        primitiveKind: "fact",
        reason: "contradiction",
      })
    );
  });

  it("mixed verdicts: a single write contradicting two existing facts returns one entry per contradiction with its own action", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    // existingSuperseded: low-trust (inferred, 40) → incoming (objective_fact,
    // 100) wins decisively (trust anchor, confidence 0.9) → action "supersede".
    const existingSuperseded = await storage.createFact({
      workspaceId: "ws-test",
      scope: "global",
      kind: "other",
      subject: "release-cadence",
      statement: "the release cadence is monthly",
      attribution: "inferred",
    });

    // existingReview: SAME trust tier as the incoming fact (objective_fact,
    // 100) → decideAutoResolution's trust-anchor rule is skipped (te === ti).
    // validFrom necessarily differs from the incoming fact's (created earlier
    // in this test) → the recency rule fires with confidence exactly 0.7,
    // which is NOT > the 0.7 auto-resolve threshold → action "review".
    const existingReview = await storage.createFact({
      workspaceId: "ws-test",
      scope: "global",
      kind: "other",
      subject: "release-cadence",
      statement: "the release cadence is quarterly",
      attribution: "objective_fact",
    });

    const result = await remember(
      ctx,
      {
        workspaceId: "ws-test",
        kind: "fact",
        content: "the release cadence is weekly",
        subject: "release-cadence",
        provenance: "objective_fact",
      },
      auth
    );

    // One candidate per contradiction, in findContradictingFacts order
    // (subject-match-ranked — both share the exact subject, so InMemory's
    // scorer preserves insertion order for ties).
    expect(result.conflict).toBeDefined();
    expect(result.conflict!.judgmentRequired).toBe(true);
    expect(result.conflict!.candidates).toHaveLength(2);

    const supersedeCandidate = result.conflict!.candidates.find(
      (c) => c.id === existingSuperseded.id
    );
    const reviewCandidate = result.conflict!.candidates.find((c) => c.id === existingReview.id);

    expect(supersedeCandidate).toBeDefined();
    expect(supersedeCandidate!.action).toBe("supersede");
    // P108 — a supersede candidate now carries a relationId like any other: the
    // verdict is a recommendation queued for judgment, not an applied archive.
    expect(typeof supersedeCandidate!.relationId).toBe("string");

    expect(reviewCandidate).toBeDefined();
    expect(reviewCandidate!.action).toBe("review");
    expect(typeof reviewCandidate!.relationId).toBe("string");

    // Side effects match each verdict independently: the superseded fact is
    // P108 — neither is archived any more. Both stay active and both carry a
    // pending conflicts_with relation; the differing verdicts survive as the
    // recommendation recorded on each review item, not as an applied action.
    expect((await storage.getFact(existingSuperseded.id, "ws-test"))?.status).toBe("active");
    expect((await storage.getFact(existingReview.id, "ws-test"))?.status).toBe("active");

    const relations = await storage.getRelations({
      workspaceId: "ws-test",
      targetId: existingReview.id,
    });
    expect(relations).toHaveLength(1);
    expect(relations[0]?.verb).toBe("conflicts_with");
    expect(relations[0]?.id).toBe(reviewCandidate!.relationId);
  });

  it("does nothing extra when there is no contradiction", async () => {
    const storage = new InMemoryStorageAdapter();
    const enqueueSpy = vi.spyOn(storage, "enqueueReviewItem");
    const archiveSpy = vi.spyOn(storage, "archiveFact");
    const ctx = makeCtx(storage);

    await storage.createFact({
      workspaceId: "ws-test",
      scope: "global",
      kind: "other",
      subject: "favourite-colour",
      statement: "the favourite colour is blue",
      attribution: "user_stated",
    });

    // Unrelated subject AND no statement-token overlap → no candidates.
    await remember(
      ctx,
      {
        workspaceId: "ws-test",
        kind: "fact",
        content: "lunch happens at noon",
        subject: "meal-timing",
        provenance: "user_stated",
      },
      auth
    );

    expect(archiveSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
    // Both facts coexist as active.
    const active = await storage.queryFacts({ workspaceId: "ws-test", status: "active" });
    expect(active.items).toHaveLength(2);
  });
});

// write-time-conflict-surfacing — resolveFactContradictions returns verdicts
// (RememberConflictCandidate[]) instead of void, and RememberResponse.conflict
// threads them through remember().
describe("remember() — write-time conflict surfacing (RememberResponse.conflict)", () => {
  it("supersede-only verdict: judgmentRequired:true now that nothing is auto-applied (P108)", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    await storage.createFact({
      workspaceId: "ws-test",
      scope: "global",
      kind: "other",
      subject: "deploy-target",
      statement: "we deploy to AWS",
      attribution: "inferred",
    });

    const result = await remember(
      ctx,
      {
        workspaceId: "ws-test",
        kind: "fact",
        content: "we deploy to GCP",
        subject: "deploy-target",
        provenance: "objective_fact",
      },
      auth
    );

    expect(result.conflict).toBeDefined();
    // P108 — judgmentRequired used to be `candidates.some(c => c.action !==
    // "supersede")`, on the premise that a supersede had already been applied
    // and left nothing to judge. It is not applied any more, so reporting
    // "nothing to judge" would leave a live conflicts_with relation behind
    // while telling the caller it was handled.
    expect(result.conflict?.judgmentRequired).toBe(true);
    expect(result.conflict?.candidates).toHaveLength(1);
    expect(result.conflict?.candidates[0]?.action).toBe("supersede");
    expect(typeof result.conflict?.candidates[0]?.relationId).toBe("string");
  });

  it("reject/review verdict: judgmentRequired:true, relationId set, relation visible via getRelations", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const existing = await storage.createFact({
      workspaceId: "ws-test",
      scope: "global",
      kind: "other",
      subject: "db-engine",
      statement: "the database is Postgres",
      attribution: "objective_fact",
    });

    const result = await remember(
      ctx,
      {
        workspaceId: "ws-test",
        kind: "fact",
        content: "the database is MySQL",
        subject: "db-engine",
        provenance: "inferred",
      },
      auth
    );

    expect(result.conflict).toBeDefined();
    expect(result.conflict?.judgmentRequired).toBe(true);
    expect(result.conflict?.candidates).toHaveLength(1);
    const candidate = result.conflict?.candidates[0];
    expect(["reject", "review"]).toContain(candidate?.action);
    expect(candidate?.relationId).toBeDefined();

    const relations = await storage.getRelations({
      workspaceId: "ws-test",
      verb: "conflicts_with",
    });
    expect(relations).toHaveLength(1);
    expect(relations[0]?.id).toBe(candidate?.relationId);
    expect(relations[0]?.sourceId).toBe(result.id);
    expect(relations[0]?.targetId).toBe(existing.id);
  });

  it("createRelation failure: candidate dropped, conflict omitted when it was the sole candidate", async () => {
    const storage = new InMemoryStorageAdapter();
    vi.spyOn(storage, "createRelation").mockRejectedValue(new Error("boom"));
    const ctx = makeCtx(storage);

    await storage.createFact({
      workspaceId: "ws-test",
      scope: "global",
      kind: "other",
      subject: "db-engine",
      statement: "the database is Postgres",
      attribution: "objective_fact",
    });

    const result = await remember(
      ctx,
      {
        workspaceId: "ws-test",
        kind: "fact",
        content: "the database is MySQL",
        subject: "db-engine",
        provenance: "inferred",
      },
      auth
    );

    // Fact write still succeeds despite the relation write failure.
    expect(result.id).toBeDefined();
    expect(result.staged).toBe(false);
    // The sole candidate was dropped → conflict omitted entirely.
    expect(result.conflict).toBeUndefined();
  });

  it("no contradiction: conflict is undefined (not null, not {})", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    await storage.createFact({
      workspaceId: "ws-test",
      scope: "global",
      kind: "other",
      subject: "favourite-colour",
      statement: "the favourite colour is blue",
      attribution: "user_stated",
    });

    const result = await remember(
      ctx,
      {
        workspaceId: "ws-test",
        kind: "fact",
        content: "lunch happens at noon",
        subject: "meal-timing",
        provenance: "user_stated",
      },
      auth
    );

    expect(result.conflict).toBeUndefined();
    expect("conflict" in result).toBe(false);
  });
});
