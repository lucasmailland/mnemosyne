/**
 * Deep-mode semantic classification tests for the consolidation scheduler (B6.35).
 *
 * Deep mode classifies each absorbed fact against the survivor with the SAME
 * resolved validator, then routes DUPLICATE subsets through the ONE shared
 * mergeClusterWithReplay helper (no separate merge path). CONTRADICTION →
 * conflicts_with relation; COMPATIBLE → skipped.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { parseActorRef } from "@mnemo-ai/types";
import { runConsolidationTick, CONSOLIDATION_SYSTEM_ACTOR } from "../scheduler.js";
import type { SchedulerContext } from "../scheduler.js";
import { makeInMemoryStorage, seedCluster, validatorDeep, TEST_SYSTEM_ACTOR } from "./helpers.js";

// `classifyFactPair` itself always catches LLM errors internally (safe
// default: COMPATIBLE) — it never throws in real usage. To exercise the
// scheduler's Requirement 3 failure-safe-default path (spec: "classifyFactPair
// throws for a pair"), the module is mocked with a sentinel: any statement
// containing "THROWS" makes the call reject; everything else passes through
// to the real implementation unchanged.
vi.mock("../SemanticClassifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../SemanticClassifier.js")>();
  return {
    ...actual,
    classifyFactPair: vi.fn(async (llm, statementA: string, statementB: string) => {
      if (statementB.includes("THROWS")) throw new Error("classifyFactPair exploded (test)");
      return actual.classifyFactPair(llm as never, statementA, statementB);
    }),
  };
});

afterEach(() => vi.clearAllMocks());

describe("consolidation scheduler — actor is a required field (type-level)", () => {
  it("a SchedulerContext literal missing `actor` fails to typecheck", () => {
    // @ts-expect-error — `actor` has no `?` and no default; omitting it must be a
    // compile error, not a silent runtime default (p47 D2).
    const ctx: SchedulerContext = {
      storage: makeInMemoryStorage(),
      listWorkspaceIds: async () => [],
    };
    expect(ctx).toBeDefined();
  });
});

describe("consolidation scheduler — deep mode (B6.35)", () => {
  it("CONTRADICTION: creates conflicts_with relation and merges only duplicates", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo uses PostgreSQL", // survivor (highest hitCount)
      "The team chose MySQL",
      "Database preference noted",
    ]);
    const survivorId = facts[0]!.id;
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validatorDeep(
        { "The team chose MySQL": "CONTRADICTION", "Database preference noted": "DUPLICATE" },
        survivorId
      ),
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
    };

    const result = await runConsolidationTick(ctx);

    // Exact-value assertion on the actor triple — objectContaining alone would
    // silently pass even if the actor field were entirely missing.
    const call = (storage.createRelation as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      workspaceId: string;
      sourceId: string;
      targetId: string;
      verb: string;
      actorId: string;
      userId: string | null;
      actorType: string;
    };
    expect(call).toMatchObject({
      workspaceId: "ws-1",
      sourceId: survivorId,
      targetId: facts[1]!.id,
      verb: "conflicts_with",
    });
    expect(call.actorId).toBe("system:consolidation");
    expect(call.actorType).toBe("system");
    expect(call.userId).toBeNull();
    // Contradiction fact not merged.
    expect((await storage.adapter.getFact(facts[1]!.id, "ws-1"))?.status).toBe("active");
    // Duplicate merged.
    expect((await storage.adapter.getFact(facts[2]!.id, "ws-1"))?.status).toBe("merged");
    expect(result.mergedPairs).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("forwards a non-system actor unchanged — no re-derivation at the call site", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo uses PostgreSQL",
      "The team chose MySQL",
      "Database preference noted",
    ]);
    const survivorId = facts[0]!.id;
    const callerActor = { actorType: "agent" as const, actorId: "key:k1" as const, userId: "u1" };
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validatorDeep(
        { "The team chose MySQL": "CONTRADICTION", "Database preference noted": "DUPLICATE" },
        survivorId
      ),
      mode: "deep",
      actor: callerActor,
    };

    await runConsolidationTick(ctx);

    const call = (storage.createRelation as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      actorId: string;
      userId: string | null;
      actorType: string;
    };
    expect(call.actorId).toBe(callerActor.actorId);
    expect(call.actorType).toBe(callerActor.actorType);
    expect(call.userId).toBe(callerActor.userId);
  });

  it("emits actor refs that parseActorRef() accepts for both construction sites", () => {
    expect(parseActorRef(CONSOLIDATION_SYSTEM_ACTOR.actorId)).not.toBeNull();
    expect(parseActorRef(TEST_SYSTEM_ACTOR.actorId)).not.toBeNull();
    // A route-sourced actorId (namespaced "key:") also parses.
    expect(parseActorRef("key:some-api-key-id")).not.toBeNull();
    expect(parseActorRef("user:some-user-id")).not.toBeNull();
  });

  it("COMPATIBLE: skips merge, creates not_conflict relation (never reclassified)", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo likes coffee",
      "Pablo prefers espresso",
      "Pablo drinks coffee daily",
    ]);
    const survivorId = facts[0]!.id;
    const validator = validatorDeep(
      { "Pablo prefers espresso": "COMPATIBLE", "Pablo drinks coffee daily": "COMPATIBLE" },
      survivorId
    );
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validator,
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
    };

    const result = await runConsolidationTick(ctx);

    // Behavior reversal per design.md D5/Requirement 2: a first-time
    // COMPATIBLE verdict now creates a `not_conflict` relation so the pair is
    // never reclassified — it no longer silently skips with zero writes.
    expect(storage.createRelation).toHaveBeenCalledTimes(2);
    const calls = (storage.createRelation as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as Record<string, unknown>
    );
    for (const call of calls) {
      expect(call).toMatchObject({
        workspaceId: "ws-1",
        sourceId: survivorId,
        verb: "not_conflict",
        evidence: { detectedBy: "semantic_classifier", consolidationMode: "deep" },
      });
    }
    const targetIds = calls.map((c) => c.targetId);
    expect(targetIds.sort()).toEqual([facts[1]!.id, facts[2]!.id].sort());
    expect(result.mergedPairs).toBe(0);
    expect(result.skippedPairs).toBe(1);
    // Nothing merged.
    for (const f of facts) {
      expect((await storage.adapter.getFact(f.id, "ws-1"))?.status).toBe("active");
    }
  });

  it("first-time COMPATIBLE pair is memoized: zero reclassification calls on a later tick", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo likes coffee",
      "Pablo prefers espresso",
      "Pablo drinks coffee daily",
    ]);
    const survivorId = facts[0]!.id;
    const validator = validatorDeep(
      { "Pablo prefers espresso": "COMPATIBLE", "Pablo drinks coffee daily": "COMPATIBLE" },
      survivorId
    );
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validator,
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
    };

    await runConsolidationTick(ctx);

    const genMock = validator.llm.generate as ReturnType<typeof vi.fn>;
    const classifyCallsAfterFirstTick = genMock.mock.calls.filter((c) =>
      (c[0] as { messages: Array<{ content: string }> }).messages[0]!.content.includes("Classify")
    ).length;
    expect(classifyCallsAfterFirstTick).toBe(2);
    expect(storage.createRelation).toHaveBeenCalledTimes(2);

    // Simulated second tick: the same cluster reforms (nothing was merged),
    // but both pairs are now memoized via the not_conflict relations just
    // written — zero NEW classification calls and zero NEW writes.
    const secondResult = await runConsolidationTick(ctx);

    const classifyCallsAfterSecondTick = genMock.mock.calls.filter((c) =>
      (c[0] as { messages: Array<{ content: string }> }).messages[0]!.content.includes("Classify")
    ).length;
    expect(classifyCallsAfterSecondTick).toBe(classifyCallsAfterFirstTick);
    expect(storage.createRelation).toHaveBeenCalledTimes(2);
    expect(secondResult.mergedPairs).toBe(0);
    expect(secondResult.skippedPairs).toBe(1);
  });

  it("existing not_conflict relation (any detectedBy) is never reclassified", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo uses PostgreSQL",
      "Pablo also enjoys hiking",
      "PostgreSQL is used by Pablo",
    ]);
    const survivorId = facts[0]!.id;
    // Pre-seed directly via the adapter (bypassing the createRelation spy) so
    // the assertion below on the spy's call count starts at zero.
    await storage.adapter.createRelation({
      workspaceId: "ws-1",
      sourceId: survivorId,
      sourceType: "fact",
      targetId: facts[1]!.id,
      targetType: "fact",
      verb: "not_conflict",
      evidence: { detectedBy: "semantic_classifier", consolidationMode: "deep" },
      actorId: TEST_SYSTEM_ACTOR.actorId,
      userId: TEST_SYSTEM_ACTOR.userId,
      actorType: TEST_SYSTEM_ACTOR.actorType,
    });
    const validator = validatorDeep(
      {
        // Would be CONTRADICTION if the memo failed to skip it — proves the
        // skip is not an accidental COMPATIBLE/DUPLICATE fallback.
        "Pablo also enjoys hiking": "CONTRADICTION",
        "PostgreSQL is used by Pablo": "DUPLICATE",
      },
      survivorId
    );
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validator,
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
    };

    const result = await runConsolidationTick(ctx);

    const genMock = validator.llm.generate as ReturnType<typeof vi.fn>;
    const classifiedHiking = genMock.mock.calls.some(
      (c) =>
        (c[0] as { messages: Array<{ content: string }> }).messages[0]!.content.includes(
          "Pablo also enjoys hiking"
        ) &&
        (c[0] as { messages: Array<{ content: string }> }).messages[0]!.content.includes("Classify")
    );
    expect(classifiedHiking).toBe(false);
    // No NEW relation written for the memoized pair.
    expect(storage.createRelation).not.toHaveBeenCalled();
    // Memoized fact stays active — excluded from merge, not reclassified.
    expect((await storage.adapter.getFact(facts[1]!.id, "ws-1"))?.status).toBe("active");
    // The freshly-classified DUPLICATE fact still merges normally.
    expect((await storage.adapter.getFact(facts[2]!.id, "ws-1"))?.status).toBe("merged");
    expect(result.mergedPairs).toBe(1);
  });

  it("existing conflicts_with relation (any detectedBy) is never reclassified", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo uses PostgreSQL",
      "The team chose MySQL",
      "PostgreSQL is used by Pablo",
    ]);
    const survivorId = facts[0]!.id;
    // Pre-seeded by a DIFFERENT detection path (not this scheduler's own
    // semantic_classifier) — proves "any detectedBy" matters, not just its own.
    await storage.adapter.createRelation({
      workspaceId: "ws-1",
      sourceId: survivorId,
      sourceType: "fact",
      targetId: facts[1]!.id,
      targetType: "fact",
      verb: "conflicts_with",
      evidence: { detectedBy: "scoped_write_time_check" },
      actorId: TEST_SYSTEM_ACTOR.actorId,
      userId: TEST_SYSTEM_ACTOR.userId,
      actorType: TEST_SYSTEM_ACTOR.actorType,
    });
    const validator = validatorDeep(
      {
        // Would be COMPATIBLE if the memo failed to skip it.
        "The team chose MySQL": "COMPATIBLE",
        "PostgreSQL is used by Pablo": "DUPLICATE",
      },
      survivorId
    );
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validator,
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
    };

    const result = await runConsolidationTick(ctx);

    const genMock = validator.llm.generate as ReturnType<typeof vi.fn>;
    const classifiedMysql = genMock.mock.calls.some(
      (c) =>
        (c[0] as { messages: Array<{ content: string }> }).messages[0]!.content.includes(
          "The team chose MySQL"
        ) &&
        (c[0] as { messages: Array<{ content: string }> }).messages[0]!.content.includes("Classify")
    );
    expect(classifiedMysql).toBe(false);
    expect(storage.createRelation).not.toHaveBeenCalled();
    expect((await storage.adapter.getFact(facts[1]!.id, "ws-1"))?.status).toBe("active");
    expect((await storage.adapter.getFact(facts[2]!.id, "ws-1"))?.status).toBe("merged");
    expect(result.mergedPairs).toBe(1);
  });

  it("getRelations throws: cluster skipped (skippedPairs++), zero classification calls", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo uses PostgreSQL",
      "The team chose MySQL",
      "Database preference noted",
    ]);
    const survivorId = facts[0]!.id;
    const validator = validatorDeep(
      { "The team chose MySQL": "CONTRADICTION", "Database preference noted": "DUPLICATE" },
      survivorId
    );
    storage.getRelations = vi.fn().mockRejectedValue(new Error("DB error"));
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validator,
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
    };

    const result = await runConsolidationTick(ctx);

    expect(result.skippedPairs).toBe(1);
    expect(result.mergedPairs).toBe(0);
    const genMock = validator.llm.generate as ReturnType<typeof vi.fn>;
    for (const call of genMock.mock.calls) {
      expect(
        (call[0] as { messages: Array<{ content: string }> }).messages[0]!.content
      ).not.toContain("Classify");
    }
    expect(storage.createRelation).not.toHaveBeenCalled();
    for (const f of facts) {
      expect((await storage.adapter.getFact(f.id, "ws-1"))?.status).toBe("active");
    }
  });

  it("classifyFactPair throws: fact excluded from merge, no write, no merge", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo uses PostgreSQL",
      "Absorbed fact THROWS during classification",
      "PostgreSQL is used by Pablo",
    ]);
    const survivorId = facts[0]!.id;
    const validator = validatorDeep({ "PostgreSQL is used by Pablo": "DUPLICATE" }, survivorId);
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validator,
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
    };

    const result = await runConsolidationTick(ctx);

    // The pair whose classification threw is excluded from the merge, and no
    // relation is written for it — it must NOT fall through as if DUPLICATE.
    expect((await storage.adapter.getFact(facts[1]!.id, "ws-1"))?.status).toBe("active");
    expect(storage.createRelation).not.toHaveBeenCalled();
    // The other, successfully-classified DUPLICATE fact still merges.
    expect((await storage.adapter.getFact(facts[2]!.id, "ws-1"))?.status).toBe("merged");
    expect(result.mergedPairs).toBe(1);
  });

  it("DUPLICATE: merges via the shared helper (retained)", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo uses PostgreSQL",
      "Pablo uses PostgreSQL for storage",
      "PostgreSQL is Pablo's DB of choice",
    ]);
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validatorDeep(
        {
          "Pablo uses PostgreSQL for storage": "DUPLICATE",
          "PostgreSQL is Pablo's DB of choice": "DUPLICATE",
        },
        facts[0]!.id
      ),
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
    };

    const result = await runConsolidationTick(ctx);

    expect((await storage.adapter.getFact(facts[1]!.id, "ws-1"))?.status).toBe("merged");
    expect((await storage.adapter.getFact(facts[2]!.id, "ws-1"))?.status).toBe("merged");
    expect(result.mergedPairs).toBe(1);
    expect(storage.createRelation).not.toHaveBeenCalled();
  });

  it("no validator in deep mode → validator_unavailable, no merge", async () => {
    const storage = makeInMemoryStorage();
    await seedCluster(storage.adapter, "ws-1", 3);
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
      // No validator — fail closed
    };

    const result = await runConsolidationTick(ctx);

    expect(result.availability).toBe("validator_unavailable");
    expect(result.mergedPairs).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("createRelation failure is non-fatal — duplicate still merges", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, [
      "Pablo uses PostgreSQL",
      "The team chose MySQL",
      "PostgreSQL is used by Pablo",
    ]);
    const createRelationMock = vi.fn().mockRejectedValue(new Error("DB error"));
    storage.createRelation = createRelationMock as unknown as typeof storage.createRelation;
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validatorDeep(
        { "The team chose MySQL": "CONTRADICTION", "PostgreSQL is used by Pablo": "DUPLICATE" },
        facts[0]!.id
      ),
      mode: "deep",
      actor: TEST_SYSTEM_ACTOR,
    };

    const result = await runConsolidationTick(ctx);

    expect(result.errors).toBe(0);
    expect((await storage.adapter.getFact(facts[2]!.id, "ws-1"))?.status).toBe("merged");
    expect(result.mergedPairs).toBe(1);
  });

  it("fast mode (default): the validator is never used for classification", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3);
    const validator = validatorDeep({}, facts[0]!.id);
    const ctx: SchedulerContext = {
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
      replayValidator: validator,
      actor: TEST_SYSTEM_ACTOR,
      // mode not set → fast
    };

    const result = await runConsolidationTick(ctx);

    expect(result.mergedPairs).toBe(1);
    expect(result.errors).toBe(0);
    // In fast mode the LLM is only used for replay query generation, never a
    // classification prompt.
    const genMock = validator.llm.generate as ReturnType<typeof vi.fn>;
    for (const call of genMock.mock.calls) {
      expect(call[0].messages[0].content).not.toContain("Classify");
    }
  });
});
