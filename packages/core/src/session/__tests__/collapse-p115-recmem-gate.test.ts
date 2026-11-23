/**
 * P115 — the RecMem gate must not discard content it has no business judging.
 *
 * What went wrong: `POST /session/:id/collapse` answered `202 {accepted:true}`
 * while the gate had thrown the session away, and the facade then wrote
 * `status='collapsed'` — a state that claims knowledge was extracted. The sweep
 * selects `WHERE status='active'`, so the turns were stranded with no path back.
 * Measured on a live stack: three turns in, zero episodes and zero facts out,
 * caller told it succeeded.
 *
 * The gate itself is kept — skipping an LLM round-trip for a session with no
 * sustained theme is a legitimate saving. These tests pin the three boundaries
 * that make it safe:
 *   1. it still fires on an automatic collapse with real, low-recurrence vectors
 *   2. it stands down for an EXPLICIT collapse (the caller asked; it is their spend)
 *   3. it stands down when the embedder is not semantic (a gate reading hash
 *      noise is a dice roll, and this one closes sessions)
 * plus the two that make a skip honest:
 *   4. a skip ARCHIVES the session rather than marking it collapsed
 *   5. the status/skipReason reach the caller instead of being swallowed
 */
import { describe, it, expect, vi } from "vitest";
import { collapseSession } from "../collapse.js";
import { createCore } from "../../cognitive/index.js";
import type { CoreContext } from "../../cognitive/context.js";
import type { AuthContext } from "@mnemo-ai/types";

const auth = {
  actorId: "system:test",
  actorType: "system",
  workspaceId: "ws",
  scopes: [],
} as unknown as AuthContext;

function makeTurns(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    workspaceId: "ws",
    sessionId: "s1",
    turnIndex: i,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `unrelated topic number ${i}`,
    createdAt: new Date(0),
  }));
}

/**
 * `recurrenceSignal` averages, per turn, the MAX cosine against any other turn.
 * Mutually orthogonal unit vectors give 0 — comfortably under the 0.6 default,
 * so the gate fires whenever it is allowed to.
 */
const orthogonalEmbeddings = (texts: string[]) =>
  texts.map((_, i) => {
    const v = [0, 0, 0, 0, 0];
    v[i % 5] = 1;
    return v;
  });

interface CtxOptions {
  semantic?: boolean;
  archiveSession?: ReturnType<typeof vi.fn>;
  closeSession?: ReturnType<typeof vi.fn>;
}

function makeDeps(turns: ReturnType<typeof makeTurns>, opts: CtxOptions = {}) {
  const summary = {
    goal: "do the thing",
    outcome: "resolved",
    facts: [{ content: "the thing was done", topicKey: "the-thing", confidence: 0.9 }],
    decisions: [],
    strategies: [],
    llmTokensUsed: 10,
  };
  const embed: Record<string, unknown> = {
    id: opts.semantic === false ? "hash-stub-embed" : "llm-provider-embed",
    embed: async (xs: string[]) => orthogonalEmbeddings(xs),
  };
  if (opts.semantic !== undefined) embed.semantic = opts.semantic;

  return {
    config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
    embed,
    vector: { search: async () => [] },
    llm: {
      generate: async () => ({
        content: JSON.stringify(summary),
        tokensUsed: { input: 10, output: 10 },
      }),
    },
    cache: null,
    outbox: { append: async () => {} },
    storage: {
      getSession: async () => ({
        id: "s1",
        workspaceId: "ws",
        agentId: "agent-x",
        status: "active",
        turnCount: turns.length,
        tokenCount: 50,
        openedAt: new Date(0),
        metadata: {},
      }),
      listTurns: async () => turns,
      createFact: async (inp: Record<string, unknown>) => ({ id: "f-1", ...inp }),
      // P125: collapse now routes a topicKey'd fact through the upsert before
      // inserting. `null` = nothing to merge into, i.e. this double keeps its
      // previous create-everything behaviour; it is here so the double covers
      // the port method the code actually calls.
      mergeFactByTopicKey: async () => null,
      createDecision: async () => ({ id: "d" }),
      createStrategy: async () => ({ id: "st" }),
      createRelation: async () => ({ id: "r" }),
      createEpisode: async () => ({ id: "ep-1" }),
      linkSessionFactsToEpisode: async () => 0,
      closeSession: opts.closeSession ?? (async () => {}),
      ...(opts.archiveSession ? { archiveSession: opts.archiveSession } : {}),
    },
  };
}

const makeCtx = (turns: ReturnType<typeof makeTurns>, opts: CtxOptions = {}) =>
  makeDeps(turns, opts) as unknown as CoreContext;

describe("P115 — RecMem gate boundaries", () => {
  it("keeps a thrown collapse active for retry, then closes it after success", async () => {
    const deps = makeDeps(makeTurns(5), { semantic: true });
    let status = "active";
    let attempts = 0;
    let fail = true;
    deps.embed.embed = async (xs: string[]) => {
      if (fail) throw new Error("Titan rejected input");
      return xs.map(() => [1, 0]);
    };
    deps.storage.closeSession = vi.fn(async () => {
      status = "collapsed";
    });
    const storage = {
      ...deps.storage,
      recordCollapseFailure: vi.fn(async () => {
        attempts++;
      }),
    };
    const core = createCore({ ...deps, storage } as never);
    const args = { sessionId: "s1", workspaceId: "ws", reason: "inactivity" as const };

    await expect(core.collapseSession(args, auth)).rejects.toThrow("Titan rejected input");
    expect(status).toBe("active");
    expect(attempts).toBe(1);
    expect(storage.recordCollapseFailure).toHaveBeenCalledWith("s1", "ws", "Titan rejected input");
    expect(deps.storage.closeSession).not.toHaveBeenCalled();

    fail = false;
    await core.collapseSession(args, auth);
    expect(status).toBe("collapsed");
  });

  it("preserves an active session and records a retry when LLM extraction returns 403", async () => {
    const deps = makeDeps(makeTurns(5));
    const closeSession = vi.fn(async () => {});
    const recordCollapseFailure = vi.fn(async () => {});
    deps.llm.generate = async () => {
      throw new Error("LLM 403");
    };
    const core = createCore({
      ...deps,
      storage: { ...deps.storage, closeSession, recordCollapseFailure },
    } as never);

    await expect(
      core.collapseSession({ sessionId: "s1", workspaceId: "ws", reason: "explicit" }, auth)
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(closeSession).not.toHaveBeenCalled();
    expect(recordCollapseFailure).toHaveBeenCalledWith("s1", "ws", "llm_unavailable");
  });
  it("still skips an AUTOMATIC collapse when real vectors show no recurrence", async () => {
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", reason: "inactivity" },
      makeCtx(makeTurns(5), { semantic: true }),
      auth
    );

    // The saving the gate exists for is intact. Removing the gate was never the fix.
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("low_recurrence_signal");
    expect(result.llmTokensUsed).toBe(0);
  });

  it("does NOT skip an EXPLICIT collapse, even with the same low-recurrence vectors", async () => {
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", reason: "explicit" },
      makeCtx(makeTurns(5), { semantic: true }),
      auth
    );

    // Identical input to the test above; only the reason changed. Somebody asked
    // for this session to become knowledge — the heuristic does not get a vote.
    expect(result.status).toBe("completed");
    expect(result.factsCreated).toBeGreaterThan(0);
  });

  it("does NOT skip when the embedder is flagged non-semantic", async () => {
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", reason: "inactivity" },
      makeCtx(makeTurns(5), { semantic: false }),
      auth
    );

    // With MNEMO_EMBED_STUB the cosines are SHA-256 noise: on a live stack two
    // sessions about one topic scored 0.58 and 0.50, the more repetitive one
    // LOWER. Nothing may be discarded on that basis.
    expect(result.status).toBe("completed");
  });

  it("treats an embedder that does not declare `semantic` as semantic", async () => {
    // Back-compat: every adapter predating the flag is a real provider.
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", reason: "inactivity" },
      makeCtx(makeTurns(5)),
      auth
    );

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("low_recurrence_signal");
  });
});

describe("P115 — a skip must be honest about itself", () => {
  it("ARCHIVES the session on a skip instead of marking it collapsed", async () => {
    const archiveSession = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const core = createCore(
      makeDeps(makeTurns(5), { semantic: true, archiveSession, closeSession }) as never
    );

    await core.collapseSession({ sessionId: "s1", workspaceId: "ws" }, auth);

    // closeSession writes status='collapsed', which asserts knowledge was
    // extracted. Nothing was. archiveSession is the existing state for "closed
    // WITHOUT collapse" and equally keeps the session out of the sweep.
    expect(archiveSession).toHaveBeenCalledWith("s1", "ws");
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("falls back to closeSession when the adapter has no archiveSession", async () => {
    const closeSession = vi.fn(async () => {});
    const core = createCore(makeDeps(makeTurns(5), { semantic: true, closeSession }) as never);

    await core.collapseSession({ sessionId: "s1", workspaceId: "ws" }, auth);

    // archiveSession is optional on the port. Leaving the session active would
    // be worse than a wrong label: the sweep would re-embed and re-skip it every
    // five minutes, forever.
    expect(closeSession).toHaveBeenCalledWith("s1", "ws");
  });

  it("returns status and skipReason to the caller rather than swallowing them", async () => {
    const core = createCore(
      makeDeps(makeTurns(5), { semantic: true, archiveSession: vi.fn(async () => {}) }) as never
    );

    const outcome = await core.collapseSession({ sessionId: "s1", workspaceId: "ws" }, auth);

    // The facade used to return only {turnsProcessed, anticipationAccuracy}, so
    // the route could not distinguish a discard from an extraction and answered
    // accepted:true for both.
    expect(outcome.status).toBe("skipped");
    expect(outcome.skipReason).toBe("low_recurrence_signal");
  });

  it("reports status 'completed' when the collapse actually ran", async () => {
    const core = createCore(makeDeps(makeTurns(5), { semantic: false }) as never);

    const outcome = await core.collapseSession(
      { sessionId: "s1", workspaceId: "ws", strategy: "explicit" },
      auth
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.skipReason).toBeUndefined();
  });
});
