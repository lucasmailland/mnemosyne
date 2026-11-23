// auto-trigger-scoped-consolidation (design.md D4/D5): unit tests for the
// write-time scoped semantic conflict check handler.

import { describe, it, expect, vi } from "vitest";
import type { MnemoFact, MnemoRelation } from "@mnemo-ai/types";
import { formatActorRef } from "@mnemo-ai/types";
import {
  createScopedConflictCheckHandler,
  isSealedForLlm,
  SCOPED_CONFLICT_MAX_PAIRS,
} from "../scoped-conflict-check.js";
import { isReplayEligibleSensitivity } from "../scheduler.js";
import type {
  ScopedConflictStorage,
  ScopedConflictCheckContext,
} from "../scoped-conflict-check.js";

const TEST_ACTOR = {
  actorType: "system" as const,
  actorId: formatActorRef("system", "consolidation"),
  userId: null,
};

function makeFact(
  id: string,
  statement: string,
  status: MnemoFact["status"] = "active"
): MnemoFact {
  return { id, statement, status, sensitivity: "internal" } as unknown as MnemoFact;
}

function makeRelation(overrides: Partial<MnemoRelation>): MnemoRelation {
  return {
    id: `rel_${Math.random().toString(36).slice(2)}`, // determinism-ok: throwaway fixture id, never asserted
    workspaceId: "ws-1",
    sourceId: "",
    sourceType: "fact",
    targetId: "",
    targetType: "fact",
    verb: "conflicts_with",
    weight: 1,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as unknown as MnemoRelation;
}

/** classification is keyed by candidate statement text. */
function makeLlm(
  classificationByStatement: Record<string, "CONTRADICTION" | "DUPLICATE" | "COMPATIBLE">
) {
  return {
    generate: vi.fn(async (opts: { messages: Array<{ content: string }> }) => {
      const content = opts.messages[0]?.content ?? "";
      for (const [stmt, cls] of Object.entries(classificationByStatement)) {
        if (content.includes(`"${stmt}"`)) {
          return { content: cls, tokensUsed: { input: 10, output: 5 } };
        }
      }
      return { content: "COMPATIBLE", tokensUsed: { input: 10, output: 5 } };
    }),
  };
}

interface FakeStorageOptions {
  facts?: Record<string, MnemoFact | null>;
  existingRelations?: MnemoRelation[];
}

function makeFakeStorage(opts: FakeStorageOptions = {}): ScopedConflictStorage & {
  createRelation: ReturnType<typeof vi.fn>;
  getFact: ReturnType<typeof vi.fn>;
  getRelations: ReturnType<typeof vi.fn>;
} {
  const facts = opts.facts ?? {};
  const existingRelations = opts.existingRelations ?? [];
  const getFact = vi.fn(async (id: string) => (id in facts ? facts[id] : null));
  const getRelations = vi.fn(
    async (filter: { sourceId?: string; targetId?: string; verb?: string }) =>
      existingRelations.filter(
        (r) =>
          r.verb === filter.verb &&
          (filter.sourceId === undefined || r.sourceId === filter.sourceId) &&
          (filter.targetId === undefined || r.targetId === filter.targetId)
      )
  );
  const createRelation = vi.fn(
    async (input: Parameters<NonNullable<ScopedConflictStorage["createRelation"]>>[0]) =>
      makeRelation(input)
  );
  return { getFact, getRelations, createRelation } as unknown as ScopedConflictStorage & {
    createRelation: ReturnType<typeof vi.fn>;
    getFact: ReturnType<typeof vi.fn>;
    getRelations: ReturnType<typeof vi.fn>;
  };
}

describe("createScopedConflictCheckHandler", () => {
  it("CONTRADICTION verdict creates exactly one relation with the correct evidence.detectedBy and verb", async () => {
    const factA = makeFact("fact-a", "Pablo uses PostgreSQL");
    const factB = makeFact("fact-b", "The team chose MySQL");
    const storage = makeFakeStorage({ facts: { "fact-a": factA, "fact-b": factB } });
    const llm = makeLlm({ "The team chose MySQL": "CONTRADICTION" });
    const ctx: ScopedConflictCheckContext = {
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
    };
    const handler = createScopedConflictCheckHandler(ctx);

    await handler({
      factId: "fact-a",
      workspaceId: "ws-1",
      candidates: [{ id: "fact-b", score: 0.9 }],
    });

    expect(storage.createRelation).toHaveBeenCalledTimes(1);
    const call = storage.createRelation.mock.calls[0]![0];
    expect(call).toMatchObject({
      workspaceId: "ws-1",
      sourceId: "fact-a",
      targetId: "fact-b",
      verb: "conflicts_with",
      evidence: { detectedBy: "scoped_write_time_check", similarity: 0.9 },
      actorId: TEST_ACTOR.actorId,
      userId: TEST_ACTOR.userId,
      actorType: TEST_ACTOR.actorType,
    });
  });

  it("DUPLICATE/COMPATIBLE verdicts create zero relations and never call merge/replay logic", async () => {
    const factA = makeFact("fact-a", "Pablo uses PostgreSQL");
    const factB = makeFact("fact-b", "Database preference noted");
    const factC = makeFact("fact-c", "Pablo really likes databases");
    const storage = makeFakeStorage({
      facts: { "fact-a": factA, "fact-b": factB, "fact-c": factC },
    });
    const llm = makeLlm({
      "Database preference noted": "DUPLICATE",
      "Pablo really likes databases": "COMPATIBLE",
    });
    const ctx: ScopedConflictCheckContext = {
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
    };
    const handler = createScopedConflictCheckHandler(ctx);

    await handler({
      factId: "fact-a",
      workspaceId: "ws-1",
      candidates: [
        { id: "fact-b", score: 0.9 },
        { id: "fact-c", score: 0.88 },
      ],
    });

    expect(storage.createRelation).not.toHaveBeenCalled();
  });

  it("existing conflicts_with relation in either direction skips creation", async () => {
    const factA = makeFact("fact-a", "Pablo uses PostgreSQL");
    const factB = makeFact("fact-b", "The team chose MySQL");
    const factC = makeFact("fact-c", "We deploy to AWS");
    const storage = makeFakeStorage({
      facts: { "fact-a": factA, "fact-b": factB, "fact-c": factC },
      existingRelations: [
        // fact-a -> fact-b already linked (source direction)
        makeRelation({ sourceId: "fact-a", targetId: "fact-b", verb: "conflicts_with" }),
        // fact-c -> fact-a already linked (target direction — fact-a is the target)
        makeRelation({ sourceId: "fact-c", targetId: "fact-a", verb: "conflicts_with" }),
      ],
    });
    const llm = makeLlm({
      "The team chose MySQL": "CONTRADICTION",
      "We deploy to AWS": "CONTRADICTION",
    });
    const ctx: ScopedConflictCheckContext = {
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
    };
    const handler = createScopedConflictCheckHandler(ctx);

    await handler({
      factId: "fact-a",
      workspaceId: "ws-1",
      candidates: [
        { id: "fact-b", score: 0.9 },
        { id: "fact-c", score: 0.88 },
      ],
    });

    // Both fact-b (already linked as source) and fact-c (already linked as
    // target of fact-a) are deduped — no new relation, no LLM call needed.
    expect(storage.createRelation).not.toHaveBeenCalled();
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("no LLM resolvable: zero classifyFactPair calls, handler resolves without throwing", async () => {
    const factA = makeFact("fact-a", "Pablo uses PostgreSQL");
    const factB = makeFact("fact-b", "The team chose MySQL");
    const storage = makeFakeStorage({ facts: { "fact-a": factA, "fact-b": factB } });
    const ctx: ScopedConflictCheckContext = {
      storage,
      actor: TEST_ACTOR,
      // No replayValidator, no getReplayValidator — nothing to resolve an LLM from.
      logger: { warn: vi.fn() },
    };
    const handler = createScopedConflictCheckHandler(ctx);

    await expect(
      handler({
        factId: "fact-a",
        workspaceId: "ws-1",
        candidates: [{ id: "fact-b", score: 0.9 }],
      })
    ).resolves.toBeUndefined();

    expect(storage.getFact).not.toHaveBeenCalled();
    expect(storage.createRelation).not.toHaveBeenCalled();
  });

  it("5 qualifying candidates in payload: at most 3 classifyFactPair calls", async () => {
    const factA = makeFact("fact-a", "Pablo uses PostgreSQL");
    const facts: Record<string, MnemoFact | null> = { "fact-a": factA };
    const candidates = [] as Array<{ id: string; score: number }>;
    for (let i = 0; i < 5; i++) {
      const id = `fact-cand-${i}`;
      facts[id] = makeFact(id, `candidate statement ${i}`);
      candidates.push({ id, score: 0.9 - i * 0.01 });
    }
    const storage = makeFakeStorage({ facts });
    const llm = makeLlm({}); // everything falls through to COMPATIBLE
    const ctx: ScopedConflictCheckContext = {
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
    };
    const handler = createScopedConflictCheckHandler(ctx);

    await handler({ factId: "fact-a", workspaceId: "ws-1", candidates });

    expect(llm.generate.mock.calls.length).toBeLessThanOrEqual(SCOPED_CONFLICT_MAX_PAIRS);
    expect(storage.createRelation).not.toHaveBeenCalled();
  });

  it("confidential/restricted text never reaches the LLM, as the fact or as a candidate", async () => {
    const secret = (id: string, statement: string, sensitivity: MnemoFact["sensitivity"]) =>
      ({ ...makeFact(id, statement), sensitivity }) as MnemoFact;
    const storage = makeFakeStorage({
      facts: {
        "fact-a": secret("fact-a", "Acme payroll runs Fridays", "internal"),
        "fact-b": secret("fact-b", "Acme payroll runs Mondays", "confidential"),
        "fact-c": secret("fact-c", "Acme payroll runs Tuesdays", "restricted"),
        "fact-d": secret("fact-d", "Larkspur Robotics pays on the 1st", "confidential"),
      },
    });
    const llm = makeLlm({});
    const handler = createScopedConflictCheckHandler({
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
    });
    await handler({
      factId: "fact-a",
      workspaceId: "ws-1",
      candidates: [
        { id: "fact-b", score: 0.9 },
        { id: "fact-c", score: 0.9 },
      ],
    });
    await handler({
      factId: "fact-d",
      workspaceId: "ws-1",
      candidates: [{ id: "fact-a", score: 0.9 }],
    });
    expect(llm.generate).not.toHaveBeenCalled();
    expect(storage.createRelation).not.toHaveBeenCalled();
  });

  it("candidate fact is archived/missing: skipped, no throw, no relation", async () => {
    const factA = makeFact("fact-a", "Pablo uses PostgreSQL");
    const archivedCandidate = makeFact("fact-b", "The team chose MySQL", "merged");
    const storage = makeFakeStorage({
      facts: { "fact-a": factA, "fact-b": archivedCandidate, "fact-c": null },
    });
    const llm = makeLlm({ "The team chose MySQL": "CONTRADICTION" });
    const ctx: ScopedConflictCheckContext = {
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
    };
    const handler = createScopedConflictCheckHandler(ctx);

    await expect(
      handler({
        factId: "fact-a",
        workspaceId: "ws-1",
        candidates: [
          { id: "fact-b", score: 0.9 }, // archived (status "merged")
          { id: "fact-c", score: 0.88 }, // missing (getFact -> null)
        ],
      })
    ).resolves.toBeUndefined();

    expect(storage.createRelation).not.toHaveBeenCalled();
    expect(llm.generate).not.toHaveBeenCalled();
  });
  it("a classifier failure is logged as such, creates nothing and does not stop the next pair", async () => {
    // LIFECYCLE-14 — the classifier used to answer COMPATIBLE when the model
    // failed, so this job dropped the pair without a word.
    const factA = makeFact("fact-a", "ledger-api requires PostgreSQL 17");
    const factB = makeFact("fact-b", "ledger-api runs on PostgreSQL 15");
    const factC = makeFact("fact-c", "ledger-api is deployed on Fridays");
    const storage = makeFakeStorage({
      facts: { "fact-a": factA, "fact-b": factB, "fact-c": factC },
    });
    const llm = {
      generate: vi.fn(async (opts: { messages: Array<{ content: string }> }) => {
        if ((opts.messages[0]?.content ?? "").includes('"ledger-api runs on PostgreSQL 15"')) {
          throw new Error("model unavailable");
        }
        return { content: "CONTRADICTION", tokensUsed: { input: 10, output: 5 } };
      }),
    };
    const warn = vi.fn();
    const handler = createScopedConflictCheckHandler({
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
      logger: { warn },
    });

    // APP-010: a model that did not answer is transient — the job rejects so
    // the outbox retries it, but only after the remaining pairs were judged.
    await expect(
      handler({
        factId: "fact-a",
        workspaceId: "ws-1",
        candidates: [
          { id: "fact-b", score: 0.93 },
          { id: "fact-c", score: 0.9 },
        ],
      })
    ).rejects.toThrow(/1 pair\(s\) failed transiently/);

    expect(warn).toHaveBeenCalledWith(
      "scoped_conflict_check.classification_failed",
      expect.objectContaining({ candidateId: "fact-b", reason: "llm_error" })
    );
    // fact-b failed and got nothing; fact-c was still classified.
    expect(storage.createRelation).toHaveBeenCalledTimes(1);
    expect(storage.createRelation.mock.calls[0]![0]).toMatchObject({ targetId: "fact-c" });
  });

  it("APP-010: a failed read of the fact rejects, so the outbox retries the job", async () => {
    const storage = makeFakeStorage();
    storage.getFact.mockRejectedValueOnce(new Error("connection terminated"));
    const llm = makeLlm({});
    const warn = vi.fn();
    const handler = createScopedConflictCheckHandler({
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
      logger: { warn },
    });

    await expect(
      handler({ factId: "fact-a", workspaceId: "ws-1", candidates: [{ id: "fact-b", score: 0.9 }] })
    ).rejects.toThrow("connection terminated");
    expect(warn).toHaveBeenCalledWith(
      "scoped_conflict_check.get_fact_failed",
      expect.objectContaining({ factId: "fact-a" })
    );
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("APP-010: a failed read of a candidate rejects after the other pairs are judged", async () => {
    const storage = makeFakeStorage({
      facts: {
        "fact-a": makeFact("fact-a", "Pablo uses PostgreSQL"),
        "fact-c": makeFact("fact-c", "The team chose MySQL"),
      },
    });
    const getFact = storage.getFact.getMockImplementation() as (
      id: string,
      ws: string
    ) => Promise<MnemoFact | null>;
    storage.getFact.mockImplementation(async (id: string, ws: string) => {
      if (id === "fact-b") throw new Error("statement timeout");
      return getFact(id, ws);
    });
    const llm = makeLlm({ "The team chose MySQL": "CONTRADICTION" });
    const handler = createScopedConflictCheckHandler({
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
    });

    await expect(
      handler({
        factId: "fact-a",
        workspaceId: "ws-1",
        candidates: [
          { id: "fact-b", score: 0.93 },
          { id: "fact-c", score: 0.9 },
        ],
      })
    ).rejects.toThrow(/failed transiently/);
    expect(storage.createRelation).toHaveBeenCalledTimes(1);
    expect(storage.createRelation.mock.calls[0]![0]).toMatchObject({ targetId: "fact-c" });
  });

  it("APP-010: an answer the classifier cannot read is not retried (a retry gets the same answer)", async () => {
    const storage = makeFakeStorage({
      facts: {
        "fact-a": makeFact("fact-a", "Pablo uses PostgreSQL"),
        "fact-b": makeFact("fact-b", "The team chose MySQL"),
      },
    });
    const llm = {
      generate: vi.fn(async () => ({ content: "I am not sure", tokensUsed: { input: 1, output: 1 } })),
    };
    const handler = createScopedConflictCheckHandler({
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
    });
    await expect(
      handler({ factId: "fact-a", workspaceId: "ws-1", candidates: [{ id: "fact-b", score: 0.9 }] })
    ).resolves.toBeUndefined();
    expect(storage.createRelation).not.toHaveBeenCalled();
  });

  it("a pair already judged not to conflict (keep_both) is never re-flagged", async () => {
    // CHAOS-11 — memory_judge keep_both turns the conflicts_with relation into
    // not_conflict. A replayed job must respect that judgment, not reopen it.
    const factA = makeFact("fact-a", "Pablo uses PostgreSQL");
    const factB = makeFact("fact-b", "The team chose MySQL");
    const storage = makeFakeStorage({
      facts: { "fact-a": factA, "fact-b": factB },
      existingRelations: [
        makeRelation({ sourceId: "fact-a", targetId: "fact-b", verb: "not_conflict" }),
      ],
    });
    const llm = makeLlm({ "The team chose MySQL": "CONTRADICTION" });
    const handler = createScopedConflictCheckHandler({
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
    });

    await handler({
      factId: "fact-a",
      workspaceId: "ws-1",
      candidates: [{ id: "fact-b", score: 0.9 }],
    });

    expect(llm.generate).not.toHaveBeenCalled();
    expect(storage.createRelation).not.toHaveBeenCalled();
  });

  it("treats a fact with no sensitivity tier as sealed and never sends it to the LLM", () => {
    const sealed = { id: "x", statement: "s", status: "active" } as unknown as MnemoFact;
    expect(isSealedForLlm(sealed)).toBe(true);
    expect(isSealedForLlm(makeFact("y", "t"))).toBe(false);
  });

  // SECURITY.md §7 / MNEMO_SENSITIVE_TEXT_TO_PROVIDERS: a confidential pair
  // reaches the judge only under `all` or when that judge is local.
  it.each([
    ["unset", {}, {}, false],
    ["none", { sensitiveTextToProviders: "none" }, {}, false],
    ["embed", { sensitiveTextToProviders: "embed" }, {}, false],
    ["all", { sensitiveTextToProviders: "all" }, {}, true],
    ["none, local judge", { sensitiveTextToProviders: "none" }, { localTasks: ["judge"] }, true],
    [
      "none, local summary only",
      { sensitiveTextToProviders: "none" },
      { localTasks: ["summary"] },
      false,
    ],
  ] as const)(
    "sends a confidential pair to the judge under %s only as the policy allows",
    async (_name, policy, llmExtra, sent) => {
      const secret = (id: string, statement: string) =>
        ({ ...makeFact(id, statement), sensitivity: "confidential" }) as MnemoFact;
      const storage = makeFakeStorage({
        facts: {
          "fact-a": secret("fact-a", "Larkspur payroll moves to Acme Bank"),
          "fact-b": secret("fact-b", "Larkspur payroll stays at Acme Credit Union"),
        },
      });
      const llm = {
        ...makeLlm({ "Larkspur payroll stays at Acme Credit Union": "CONTRADICTION" }),
        ...llmExtra,
      };
      const handler = createScopedConflictCheckHandler({
        storage,
        actor: TEST_ACTOR,
        replayValidator: { llm } as never,
        ...policy,
      });

      await handler({
        factId: "fact-a",
        workspaceId: "ws-1",
        candidates: [{ id: "fact-b", score: 0.9 }],
      });

      const prompts = llm.generate.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(prompts.some((p) => p.includes("Acme Credit Union"))).toBe(sent);
      expect(storage.createRelation).toHaveBeenCalledTimes(sent ? 1 : 0);
    }
  );

  it("never judges a fact it could not open, whatever the policy", async () => {
    const unreadable = {
      ...makeFact("fact-b", "[unreadable]"),
      sensitivity: "confidential",
      redacted: "unreadable",
    } as unknown as MnemoFact;
    const storage = makeFakeStorage({
      facts: {
        "fact-a": makeFact("fact-a", "Larkspur payroll moves to Acme Bank"),
        "fact-b": unreadable,
      },
    });
    const llm = makeLlm({ "[unreadable]": "CONTRADICTION" });
    const handler = createScopedConflictCheckHandler({
      storage,
      actor: TEST_ACTOR,
      replayValidator: { llm } as never,
      sensitiveTextToProviders: "all",
    });
    await handler({
      factId: "fact-a",
      workspaceId: "ws-1",
      candidates: [{ id: "fact-b", score: 0.9 }],
    });
    expect(llm.generate).not.toHaveBeenCalled();
  });
});

describe("consolidation scheduler eligibility", () => {
  it.each([
    ["public", {}, true],
    ["internal", {}, true],
    ["confidential", {}, false],
    ["restricted", {}, false],
    [undefined, {}, false],
    ["toString", {}, false],
    ["internal", { redacted: "unreadable" }, false],
  ] as const)("tier %s %o", (sensitivity, extra, eligible) => {
    const fact = { id: "f", statement: "s", status: "active", sensitivity, ...extra };
    expect(isReplayEligibleSensitivity(fact as unknown as MnemoFact)).toBe(eligible);
  });
});
