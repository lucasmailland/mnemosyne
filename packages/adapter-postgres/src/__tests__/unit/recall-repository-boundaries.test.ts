import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FactRepository } from "../../repositories/FactRepository.js";
import { RecallRepository } from "../../repositories/RecallRepository.js";

const WS = "11111111-1111-1111-1111-111111111111";

function sqlAsText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .flatMap((chunk) => {
      const value = (chunk as { value?: unknown[] }).value;
      if (Array.isArray(value))
        return value.filter((part): part is string => typeof part === "string");
      return [sqlAsText(chunk)];
    })
    .join(" ");
}

function makeRepository() {
  const events: string[] = [];
  const executedSql: string[] = [];
  const tx = {
    execute: vi.fn(async (query: unknown) => {
      events.push("execute");
      executedSql.push(sqlAsText(query));
      return [];
    }),
    select: vi.fn(() => {
      events.push("select");
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
          })),
        })),
      };
    }),
    update: vi.fn(() => {
      events.push("update");
      return { set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) };
    }),
  };
  const db = { transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
  return {
    repository: new RecallRepository(db as never, db as never),
    events,
    executedSql,
  };
}

/**
 * Same harness as makeRepository, but `execute` returns each element of
 * `results` in sequence (one per call) instead of always `[]` — needed for
 * getRecallPrecision, whose second `execute` call is the aggregate query.
 */
function makeRepositoryWithExecuteResults(results: unknown[][]) {
  const executedSql: string[] = [];
  let call = 0;
  const tx = {
    execute: vi.fn(async (query: unknown) => {
      executedSql.push(sqlAsText(query));
      const result = results[call] ?? [];
      call += 1;
      return result;
    }),
  };
  const db = { transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
  return {
    repository: new RecallRepository(db as never, db as never),
    executedSql,
  };
}

describe("RecallRepository boundaries", () => {
  it("sets workspace context before updating worth", async () => {
    const { repository, events, executedSql } = makeRepository();

    await repository.updateWorth("fact-1", WS, "fact", {
      success: 1,
      failure: 0,
      creditWeight: 1,
    });

    expect(events.indexOf("execute")).toBeLessThan(events.indexOf("update"));
    expect(executedSql.join(" ")).toContain("mnemo_set_workspace");
  });

  it("sets workspace context before reading TD predecessors", async () => {
    const { repository, events, executedSql } = makeRepository();

    await repository.getTdPredecessors(WS, "session-1", "fact-1");

    expect(events.indexOf("execute")).toBeLessThan(events.indexOf("select"));
    expect(executedSql.join(" ")).toContain("mnemo_set_workspace");
  });

  // harden-hooks-and-measure-precision (Slice 4, A2-read, Requirement 5/6).
  describe("getRecallPrecision", () => {
    it("sets workspace context and joins mnemo_recall_log to mnemo_session", async () => {
      const { repository, executedSql } = makeRepositoryWithExecuteResults([[], []]);

      await repository.getRecallPrecision(WS);

      expect(executedSql[0]).toContain("mnemo_set_workspace");
      const joined = executedSql.join(" ");
      expect(joined).toContain("mnemo_recall_log");
      expect(joined).toContain("mnemo_session");
      expect(joined).toMatch(/hit_rank\s+IS\s+NOT\s+NULL/);
      expect(joined).toMatch(/session_id\s+IS\s+NOT\s+NULL/);
      // Requirement 5's coarse-credit definition: gated on both collapse and
      // fact_count > 0, capped at the 20-most-recently-recalled window.
      expect(joined).toContain("collapsed_at");
      expect(joined).toContain("fact_count");
      expect(joined).toMatch(/<=\s*20/);
    });

    it("computes precision-at-k from an aggregate row", async () => {
      const { repository } = makeRepositoryWithExecuteResults([
        [],
        [
          {
            total_hits: "10",
            pending_hits: "2",
            denom_k1: "4",
            num_k1: "2",
            denom_k3: "8",
            num_k3: "5",
            denom_k5: "8",
            num_k5: "5",
          },
        ],
      ]);

      const report = await repository.getRecallPrecision(WS);

      expect(report.workspaceId).toBe(WS);
      expect(report.totalHits).toBe(10);
      expect(report.pendingHits).toBe(2);
      expect(report.precisionAtK).toEqual([
        { k: 1, sampleSize: 4, precision: 0.5 },
        { k: 3, sampleSize: 8, precision: 0.625 },
        { k: 5, sampleSize: 8, precision: 0.625 },
      ]);
      expect(report.insufficientData).toBe(false);
      expect(report.methodologyNote).toMatch(/coarse/i);
    });

    it("returns insufficient-data (null precision, zero sample size), never a fabricated number", async () => {
      const { repository } = makeRepositoryWithExecuteResults([[], []]);

      const report = await repository.getRecallPrecision(WS);

      expect(report.insufficientData).toBe(true);
      for (const entry of report.precisionAtK) {
        expect(entry.precision).toBeNull();
        expect(entry.sampleSize).toBe(0);
      }
    });
  });

  it("sets workspace context before reading the consolidation lock", async () => {
    const { repository, executedSql } = makeRepository();

    await repository.isConsolidationLocked(WS);

    expect(executedSql[0]).toContain("mnemo_set_workspace");
    expect(executedSql.join(" ")).toContain("mnemo_consolidation_lock");
  });

  it("does not import application core from the infrastructure adapter", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../repositories/RecallRepository.ts", import.meta.url)),
      "utf8"
    );

    expect(source).not.toMatch(/from ["']@mnemosyne\/core/);
  });

  it("only decays open procedural skills", async () => {
    const { repository, executedSql } = makeRepository();

    await repository.decayKind(WS, "procedural", 173);

    const skillUpdate = executedSql.find((text) => text.includes("mnemo_skill"));
    expect(skillUpdate).toMatch(/valid_to\s+IS\s+NULL/);
  });

  it("ranks standalone FTS through the shared dual-language helpers before limiting", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../repositories/RecallRepository.ts", import.meta.url)),
      "utf8"
    );
    const method = source.slice(
      source.indexOf("async ftsCandidates"),
      source.indexOf("// ─── Consolidation rollback")
    );
    // P131 B1 then B3: the config is no longer spelled inline, and there are now
    // TWO arms — English and Spanish, ORed. Asserting the shared helper rather
    // than a literal is the point: an inline literal is the drift
    // fts-config-is-single-sourced.test.ts rejects, and a single arm is the
    // drift fts-spanish-arm.test.ts rejects.
    expect(method).toMatch(/ftsRankEither|ftsMatchesEither/);
    // P131 B3: ts_rank moved INSIDE the shared helper, so asserting it here
    // would only re-check where the string lives. What matters at this call
    // site is that ranking happens through the helper at all — and
    // fts-spanish-arm.test.ts pins that the helper takes GREATEST of both arms.
    expect(method.indexOf("orderBy")).toBeLessThan(method.indexOf(".limit(query.limit)"));
  });

  it("delegates the exact FTS query contract from DrizzleStorageAdapter", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../DrizzleStorageAdapter.ts", import.meta.url)),
      "utf8"
    );
    expect(source).toMatch(
      /ftsCandidates\(query: Omit<PointerCandidateQuery, ['"]bands['"]>\): Promise<FtsCandidate\[\]>/
    );
  });

  // make-primitives-recallable (PR3 — Phase 5, task 5.2/5.5).
  describe("recallableCandidates", () => {
    it("kinds without 'decision' issues no query at all (no transaction opened)", async () => {
      const db = { transaction: vi.fn() };
      const repo = new RecallRepository(db as never, db as never);

      const result = await repo.recallableCandidates({
        workspaceId: WS,
        kinds: ["fact"],
        limit: 10,
        embedding: [0.1, 0.2, 0.3],
      });

      expect(result).toEqual([]);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("empty kinds array issues no query at all", async () => {
      const db = { transaction: vi.fn() };
      const repo = new RecallRepository(db as never, db as never);

      const result = await repo.recallableCandidates({
        workspaceId: WS,
        kinds: [],
        limit: 10,
        embedding: [0.1, 0.2, 0.3],
        terms: ["postgres"],
      });

      expect(result).toEqual([]);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("neither embedding nor terms supplied issues no query at all", async () => {
      const db = { transaction: vi.fn() };
      const repo = new RecallRepository(db as never, db as never);

      const result = await repo.recallableCandidates({
        workspaceId: WS,
        kinds: ["decision"],
        limit: 10,
      });

      expect(result).toEqual([]);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("sets workspace context before the semantic (cosine) arm runs", async () => {
      const { repository, events, executedSql } = makeRepository();

      await repository.recallableCandidates({
        workspaceId: WS,
        kinds: ["decision"],
        limit: 10,
        embedding: [0.1, 0.2, 0.3],
        minSimilarity: 0.35,
      });

      expect(events.indexOf("execute")).toBeGreaterThanOrEqual(0);
      const joined = executedSql.join(" ");
      expect(joined).toContain("mnemo_set_workspace");
      expect(joined).toContain("mnemo_decision");
      expect(joined).toContain("halfvec");
    });

    it("runs the lexical arm with the shared plainto_tsquery config over text_lemmatized when terms are supplied", async () => {
      const { repository, events } = makeRepository();

      await repository.recallableCandidates({
        workspaceId: WS,
        kinds: ["decision"],
        limit: 10,
        terms: ["caching", "strategy"],
      });

      // P65: the lexical arm moved from a drizzle `.select()` chain to raw SQL,
      // because the liveness predicate now differs per kind and expressing it
      // twice (once per arm) would let the two halves disagree about which rows
      // exist. This used to assert `execute` came before `select`; there is no
      // `select` any more, so it asserts what actually matters — the workspace
      // GUC is set before any workspace-scoped query, which RLS requires.
      const guc = events.indexOf("execute");
      expect(guc).toBeGreaterThanOrEqual(0);
      expect(events.lastIndexOf("execute")).toBeGreaterThan(guc);
    });

    it("source: lexical arm uses the shared dual-language helpers and ts_rank, ordered before limiting", () => {
      const source = readFileSync(
        fileURLToPath(new URL("../../repositories/RecallRepository.ts", import.meta.url)),
        "utf8"
      );
      const method = source.slice(
        source.indexOf("async recallableCandidates"),
        source.indexOf("// ─── Consolidation admin lock")
      );
      // P131 B1: the config is no longer spelled inline. Asserting the shared
      // helper instead of a literal is the point — an inline literal here is the
      // very drift fts-config-is-single-sourced.test.ts exists to reject.
      // P131 B1 then B3: through the shared dual-language helpers, never an
      // inline config and never a single arm.
      expect(method).toMatch(/ftsRankEither|ftsMatchesEither/);
      expect(method).toContain("mnemo_set_workspace");
      // Ordering before limiting, asserted against the SQL itself rather than
      // the drizzle chain that used to build it: `ORDER BY rank DESC` must
      // precede `LIMIT`, or the arm returns an arbitrary slice of the matches
      // instead of the best ones.
      expect(method.indexOf("ORDER BY rank DESC")).toBeGreaterThanOrEqual(0);
      expect(method.indexOf("ORDER BY rank DESC")).toBeLessThan(
        method.indexOf("LIMIT ${query.limit}\n          `", method.indexOf("ORDER BY rank DESC"))
      );
    });

    it("delegates the exact recallableCandidates contract from DrizzleStorageAdapter", () => {
      const source = readFileSync(
        fileURLToPath(new URL("../../DrizzleStorageAdapter.ts", import.meta.url)),
        "utf8"
      );
      expect(source).toMatch(
        /recallableCandidates\(query: PrimitiveCandidateQuery\): Promise<PrimitiveCandidate\[\]>/
      );
    });
  });
});

describe("FactRepository boundaries", () => {
  function makeFactRepository(recalled: Array<{ factId: string | null }> = []) {
    const events: string[] = [];
    const executedSql: string[] = [];
    const selectDistinct = vi.fn(() => {
      events.push("select");
      return {
        from: vi.fn(() => ({
          where: vi.fn(async () => recalled),
        })),
      };
    });
    const tx = {
      execute: vi.fn(async (query: unknown) => {
        events.push("execute");
        executedSql.push(sqlAsText(query));
        return [];
      }),
      selectDistinct,
    };
    const db = {
      selectDistinct,
      transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
    };
    return {
      repository: new FactRepository(db as never, db as never),
      events,
      executedSql,
    };
  }

  it("never returns non-fact (null fact_id) recall rows as provenance terminals", async () => {
    const { repository, executedSql } = makeFactRepository([
      { factId: "fact-1" },
      { factId: null },
    ]);
    const ids = await repository.getRecalledFactIds(WS, "session-1");
    expect(ids).toEqual(["fact-1"]);
    // And credit propagation tolerates a stray null terminal instead of throwing.
    await expect(
      repository.getProvenanceCredit(WS, [null as unknown as string, "fact-1"], 0.7, 5)
    ).resolves.toEqual([]);
    expect(executedSql.find((t) => t.includes("WITH RECURSIVE"))).toBeDefined();
  });

  it("sets workspace context before reading recalled fact ids", async () => {
    const { repository, events, executedSql } = makeFactRepository();

    await repository.getRecalledFactIds(WS, "session-1");

    expect(events.indexOf("execute")).toBeLessThan(events.indexOf("select"));
    expect(executedSql.join(" ")).toContain("mnemo_set_workspace");
  });

  it("uses the relation column when traversing provenance", async () => {
    const { repository, executedSql } = makeFactRepository();

    await repository.getProvenanceCredit(WS, ["fact-1"], 0.7, 5);

    const query = executedSql.find((text) => text.includes("WITH RECURSIVE"));
    expect(query).toContain("r.relation");
    expect(query).not.toContain("r.verb");
  });
});
