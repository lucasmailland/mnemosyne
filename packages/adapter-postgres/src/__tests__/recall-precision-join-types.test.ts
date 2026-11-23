/**
 * P133 — the precision report's join compared two columns of different types,
 * so it threw on every call it ever made.
 *
 * `mnemo_recall_log.workspace_id` is declared `uuid`. `mnemo_session.workspace_id`
 * and `mnemo_fact.workspace_id` are declared `text`. The join wrote
 * `s.workspace_id = rl.workspace_id`, which Postgres answers with
 * `operator does not exist: text = uuid`.
 *
 * WHY IT WENT UNNOTICED FOR ITS ENTIRE LIFE, which is the part worth keeping:
 *
 *   1. `GET /admin/stats` wraps the call in `catch { precision = null }`, and
 *      the null path renders as `insufficientData: true` with `sampleSize: 0`.
 *      A read that could not run and a workspace with no history produced
 *      byte-identical responses — and the field was named "insufficient data",
 *      so the broken one sounded deliberate.
 *   2. Slice 4's tests exercise the InMemoryStorageAdapter, which has no SQL
 *      types at all. Every assertion passed against a double that cannot
 *      reproduce the only failure mode this query has.
 *
 * Found by driving the credit chain by hand for P62: raw SQL over the same
 * predicate returned 50 qualifying hits while the endpoint reported 0.
 *
 * This test is therefore deliberately about TYPES, not behaviour — it reads the
 * source, because the behavioural test already exists and already passes
 * against a double that cannot fail this way.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { RecallRepository } from "../repositories/RecallRepository.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

function recallRepositorySource(): string {
  return readFileSync(join(REPO, "src", "repositories", "RecallRepository.ts"), "utf8");
}

/** Column type as the migrations declare it, read from the SQL rather than assumed. */
function declaredType(table: string, column: string): string | null {
  const dir = join(REPO, "migrations", "baseline");
  for (const file of readdirSync(dir).sort().reverse()) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const createIdx = sql.indexOf(`CREATE TABLE mnemosyne.${table}`);
    if (createIdx === -1) continue;
    const body = sql.slice(createIdx, sql.indexOf(");", createIdx));
    const line = body.split("\n").find((l) => l.trim().startsWith(`${column} `));
    if (!line) continue;
    return line.trim().split(/\s+/)[1]!.replace(/,$/, "").toLowerCase();
  }
  return null;
}

describe("P133 — recall_log and session disagree on workspace_id's type", () => {
  it("the two columns really are different types — the premise, verified", () => {
    // If a later migration ever aligns them, this fails and the cast below can
    // go. Asserting the premise keeps the fix from outliving its reason.
    expect(declaredType("mnemo_recall_log", "workspace_id")).toBe("uuid");
    expect(declaredType("mnemo_session", "workspace_id")).toBe("text");
  });

  it("the join casts, so the query can actually run", () => {
    const src = recallRepositorySource();
    const query = src.slice(src.indexOf("async getRecallPrecision"));
    const join = query.slice(0, query.indexOf("WHERE rl.workspace_id"));

    // The bare comparison is the bug. Anything that reintroduces it fails here.
    expect(join).toContain("rl.workspace_id::text");
    expect(join).not.toMatch(/s\.workspace_id\s*=\s*rl\.workspace_id\s*$/m);
  });

  it("the session-id comparison is NOT cast — both sides are already text", () => {
    // Casting everything "to be safe" would hide the next genuine mismatch and
    // cost an index. The point is that exactly one comparison needed it.
    expect(declaredType("mnemo_recall_log", "session_id")).toBe("text");
    expect(declaredType("mnemo_session", "id")).toBe("text");

    const src = recallRepositorySource();
    const query = src.slice(src.indexOf("async getRecallPrecision"));
    expect(query).toContain("ON s.id = rl.session_id");
    expect(query).not.toContain("rl.session_id::text");
  });
});

describe("P133 — an unavailable read is distinguishable from an empty one", () => {
  it("/admin/stats reports precisionUnavailable separately from insufficientData", () => {
    // The catch stays — an unavailable precision read must not fail the whole
    // stats call — but it can no longer masquerade. Before this, the ONLY
    // observable difference between "the query threw" and "no history yet" was
    // nothing at all.
    const route = readFileSync(
      join(REPO, "..", "server", "src", "routes", "admin-stats.ts"),
      "utf8"
    );

    expect(route).toContain("precisionUnavailable");
    expect(route).toMatch(/precisionUnavailable:\s*precision === null/);
    // And the failure has to be audible, not just representable.
    expect(route).toContain("admin_stats.precision_failed");
  });
});

describe("0058 — recall_log nullable fact_id and text memory_id readers", () => {
  it("declares recallRequestTable and aligns recallLogTable columns and nullable fact_id FK", () => {
    const reqCfg = getTableConfig(schema.recallRequestTable);
    expect(reqCfg.name).toBe("mnemo_recall_request");
    expect(reqCfg.primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      "workspace_id",
      "request_id",
    ]);

    const logCfg = getTableConfig(schema.recallLogTable);
    const byName = new Map(logCfg.columns.map((c) => [c.name, c]));
    expect(byName.get("fact_id")?.notNull).toBe(false);
    expect(byName.get("memory_id")?.getSQLType()).toBe("text");
    expect(byName.get("request_id")?.getSQLType()).toBe("text");
    expect(byName.get("primitive_kind")?.getSQLType()).toBe("text");
    expect(
      logCfg.foreignKeys.some((fk) => fk.reference().columns.some((c) => c.name === "fact_id"))
    ).toBe(true);
  });

  it("excludes non-fact rows from TD/precision/replay, reads text memory_id without UUID cast, preserves global ranks and legacy fact rows", async () => {
    const src = recallRepositorySource();
    const td = src.slice(
      src.indexOf("async getTdPredecessors"),
      src.indexOf("async getRecallPrecision")
    );
    const prec = src.slice(
      src.indexOf("async getRecallPrecision"),
      src.indexOf("async getRecallLog(")
    );
    const singleLog = src.slice(
      src.indexOf("async getRecallLog("),
      src.indexOf("async getRecallLogs(")
    );
    const batchLog = src.slice(
      src.indexOf("async getRecallLogs("),
      src.indexOf("async getRecentQueriesForFacts")
    );
    const replay = src.slice(
      src.indexOf("async getRecentQueriesForFacts"),
      src.indexOf("async recordCoRecallStdp")
    );

    expect(td).toContain("isNotNull(schema.recallLogTable.factId)");
    expect(td).toContain("schema.recallLogTable.primitiveKind");
    expect(prec).toMatch(/rl\.fact_id\s+IS\s+NOT\s+NULL/);
    expect(prec).toMatch(/rl\.primitive_kind\s+IS\s+NULL\s+OR\s+rl\.primitive_kind\s*=\s*'fact'/);
    expect(prec).toContain("rl.hit_rank");
    expect(replay).toMatch(/fact_id\s+IS\s+NOT\s+NULL/);
    expect(replay).toMatch(/primitive_kind\s+IS\s+NULL\s+OR\s+primitive_kind\s*=\s*'fact'/);
    expect(singleLog).toContain("COALESCE(memory_id, fact_id)");
    expect(singleLog).not.toMatch(/memory_id::uuid|\$\{memoryId\}::uuid/);
    expect(batchLog).toContain("COALESCE(memory_id, fact_id)");
    expect(batchLog).toContain("schema.recallLogTable.memoryId");
    expect(batchLog).not.toMatch(/memory_id::uuid/);

    const ts = new Date("2026-11-16T00:00:00Z");
    const rows = [
      { factId: null, tdCredit: "0.5", recalledAt: ts },
      { factId: "fact-legacy", tdCredit: "0.25", recalledAt: ts },
    ];
    const tx = {
      execute: vi.fn(async () => [
        { id: "1", memory_id: "mepi_01", recalled_at: ts.toISOString(), recall_score: "0.8" },
      ]),
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }),
      })),
    };
    const repo = new RecallRepository(
      { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never,
      {} as never
    );
    expect(
      await repo.getTdPredecessors("11111111-1111-1111-1111-111111111111", "s1", "f0")
    ).toEqual([{ factId: "fact-legacy", tdCredit: 0.25, recalledAt: ts }]);
    expect(
      (await repo.getRecallLogs("11111111-1111-1111-1111-111111111111", ["mepi_01"], 5))[0]
        ?.memoryId
    ).toBe("mepi_01");
  });
});
