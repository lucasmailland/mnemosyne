import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildLogRecallInsert } from "../../recall-log-sql.js";
import { RecallRepository } from "../../repositories/RecallRepository.js";
import { FactRepository } from "../../repositories/FactRepository.js";

describe("buildLogRecallInsert — C4", () => {
  it("writes fact_id as TEXT (no ::uuid cast), and both activation_score + recall_score", () => {
    const { text, params } = buildLogRecallInsert(
      "11111111-1111-1111-1111-111111111111",
      "fact-abc",
      0.42
    );
    expect(text).not.toMatch(/fact_id[^,]*::uuid/i);
    expect(text).toMatch(/activation_score/);
    expect(text).toMatch(/recall_score/);
    expect(params).toContain("fact-abc");
  });
});

const WS = "11111111-1111-1111-1111-111111111111";
const req = (o: Record<string, unknown> = {}) =>
  ({
    workspaceId: WS,
    requestId: "r1",
    sessionId: "s1",
    trafficOrigin: "production",
    status: "ok",
    queryHash: "h",
    totalDurationMs: 12.4,
    ...o,
  }) as any;
const hit = (primitiveKind: string, memoryId: string, rank: number) =>
  ({ workspaceId: WS, requestId: "r1", primitiveKind, memoryId, rank, score: 0.5 }) as any;

function run(failOn?: string) {
  const dialect = new PgDialect();
  const committed: Array<{ text: string; params: unknown[] }> = [];
  const seen = new Map<string, string>(); // request id -> status
  const db = {
    async transaction(fn: (tx: unknown) => Promise<void>) {
      const stmts: Array<{ text: string; params: unknown[] }> = [];
      const tx = {
        async execute(q: any) {
          const { sql: text, params } = dialect.sqlToQuery(q);
          if (failOn && text.includes(failOn)) throw new Error("boom");
          stmts.push({ text, params });
          if (text.includes("mnemo_recall_request")) {
            const id = String(params[1]);
            const status = String(params[4]);
            const prior = seen.get(id);
            // Emulates the ON CONFLICT clause actually present in the SQL.
            const upgrades =
              /DO UPDATE[\s\S]*status = 'error' AND EXCLUDED\.status <> 'error'/.test(text);
            if (prior !== undefined && !(upgrades && prior === "error" && status !== "error"))
              return [];
            seen.set(id, status);
            return [{ request_id: id }];
          }
          return [];
        },
      };
      await fn(tx);
      committed.push(...stmts);
    },
  };
  return { repo: new RecallRepository(db as any, {} as any), committed };
}

describe("RecallRepository.recordRecallObservation", () => {
  it("sets workspace GUC, inserts request, and hits with text ids for ranks 0..3", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req(), [
      hit("fact", "f-1", 0),
      hit("decision", "d-1", 1),
      hit("episode", "mepi_9", 2),
      hit("entity", "e-1", 3),
    ]);
    expect(committed[0]!.text).toMatch(/mnemo_set_workspace/);
    expect(committed[1]!.text).toMatch(/ON CONFLICT \(workspace_id, request_id\) DO UPDATE/);
    const hits = committed.slice(2);
    expect(hits.map((h) => h.params.includes("mepi_9"))).toEqual([false, false, true, false]);
    expect(hits[2]!.text).not.toMatch(/::uuid.*memory_id/);
    expect(hits[0]!.text).toMatch(/hit_count = hit_count \+ 1/);
    expect(hits[1]!.text).not.toMatch(/mnemo_fact/);
  });

  it("records empty and error requests with no hits", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req({ requestId: "e1", status: "empty" }), []);
    await repo.recordRecallObservation(req({ requestId: "e2", status: "error" }), []);
    expect(
      committed.filter((c) => c.text.includes("INSERT INTO mnemosyne.mnemo_recall_request"))
    ).toHaveLength(2);
    expect(committed.some((c) => c.text.includes("mnemo_recall_log"))).toBe(false);
  });

  it("does not reinforce synthetic hits", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req({ trafficOrigin: "synthetic" }), [
      hit("fact", "f-1", 0),
    ]);
    expect(committed.some((c) => c.text.includes("mnemo_recall_log"))).toBe(true);
    expect(committed.some((c) => c.text.includes("mnemo_fact"))).toBe(false);
  });

  it("replayed request does not insert hits or increment", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req(), [hit("fact", "f-1", 0)]);
    const n = committed.length;
    await repo.recordRecallObservation(req(), [hit("fact", "f-1", 0)]);
    expect(committed.length).toBe(n + 2); // GUC + conflicting request insert only
  });

  it("a successful retry after an error-only attempt still records its hits", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req({ status: "error" }), []);
    await repo.recordRecallObservation(req(), [hit("fact", "f-1", 0)]);
    const logs = committed.filter((c) => c.text.includes("mnemo_recall_log"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.text).toMatch(/hit_count = hit_count \+ 1/);
    // ...but a later error never downgrades nor duplicates the completed one.
    const n = committed.length;
    await repo.recordRecallObservation(req({ status: "error" }), []);
    await repo.recordRecallObservation(req(), [hit("fact", "f-1", 0)]);
    expect(committed.length).toBe(n + 4);
  });

  it("writes the request latency into latency_ms (metacognition trends)", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req({ totalDurationMs: 12.4 }), [hit("fact", "f-1", 0)]);
    const log = committed.find((c) => c.text.includes("mnemo_recall_log"))!;
    expect(log.text).toMatch(/latency_ms/);
    expect(log.params).toContain(12);
  });

  it("persists the raw hit similarity apart from the ranking score", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req(), [
      { ...hit("fact", "f-1", 0), score: 0.5, similarity: 0.83 },
      hit("episode", "mepi_1", 1),
    ]);
    const logs = committed.filter((c) => c.text.includes("mnemo_recall_log"));
    expect(logs[0]!.text).toMatch(/recall_score, similarity,/);
    expect(logs[0]!.params).toContain(0.83);
    // A hit without a measured similarity stores NULL, never the ranking score.
    expect(logs[1]!.params).toContain(null);
  });

  it("rolls back when a hit insert fails", async () => {
    const { repo, committed } = run("mnemo_recall_log");
    await expect(repo.recordRecallObservation(req(), [hit("fact", "f-1", 0)])).rejects.toThrow(
      "boom"
    );
    expect(committed).toHaveLength(0);
  });
});

describe("RecallRepository.recordRecallObservation — TD credit and workspace isolation", () => {
  it("writes the fact hit's TD(λ) credit instead of a constant 0", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req(), [{ ...hit("fact", "f-1", 1), tdCredit: 0.7 }]);
    const log = committed.find((c) => c.text.includes("mnemo_recall_log"))!;
    expect(log.params).toContain("0.7");
  });

  it("never writes a hit that belongs to another workspace (RLS would abort the whole tx)", async () => {
    const { repo, committed } = run();
    const other = { ...hit("fact", "f-x", 1), workspaceId: "22222222-2222-2222-2222-222222222222" };
    await repo.recordRecallObservation(req(), [hit("fact", "f-1", 0), other]);
    const logs = committed.filter((c) => c.text.includes("mnemo_recall_log"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.params).not.toContain("f-x");
  });
});

describe("activation history excludes synthetic/test observations", () => {
  function reader() {
    const dialect = new PgDialect();
    const texts: string[] = [];
    const db = {
      async transaction(fn: (tx: unknown) => Promise<unknown>) {
        return fn({
          async execute(q: any) {
            texts.push(dialect.sqlToQuery(q).sql);
            return [];
          },
        });
      },
    };
    return { repo: new RecallRepository(db as any, {} as any), texts };
  }
  const guard =
    /NOT EXISTS[\s\S]*mnemo_recall_request[\s\S]*trafficOrigin'\s*IN \('synthetic', 'test'\)/;

  it("getRecallLog filters out rows of synthetic/test requests", async () => {
    const { repo, texts } = reader();
    await repo.getRecallLog(WS, "f-1", 10);
    expect(texts.find((t) => t.includes("FROM mnemosyne.mnemo_recall_log"))).toMatch(guard);
  });

  it("getRecallLogs filters out rows of synthetic/test requests", async () => {
    const { repo, texts } = reader();
    await repo.getRecallLogs(WS, ["f-1"], 10);
    expect(texts.find((t) => t.includes("FROM mnemosyne.mnemo_recall_log"))).toMatch(guard);
  });
});

describe("organic fact hits persist against the real column types (review r1)", () => {
  it("compares mnemo_fact.workspace_id (TEXT) without a ::uuid cast", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req(), [hit("fact", "f-1", 0)]);
    const log = committed.find((c) => c.text.includes("mnemo_recall_log"))!;
    const update = log.text.slice(log.text.indexOf("UPDATE mnemosyne.mnemo_fact"));
    expect(update).toMatch(/workspace_id = \$\d+::text/);
    expect(update).not.toMatch(/::uuid/);
  });
});

describe("query_text keeps feeding replay and conditional anticipation (review r1)", () => {
  const QUERY = "how do we deploy";
  const logsOf = (c: Array<{ text: string; params: unknown[] }>) =>
    c.filter((x) => x.text.includes("mnemo_recall_log"));

  it("writes the query onto organic fact hit rows only", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req({ queryText: QUERY }), [
      hit("fact", "f-1", 0),
      hit("episode", "mepi_1", 1),
    ]);
    const [fact, episode] = logsOf(committed);
    expect(fact!.text).toMatch(/query_text/);
    expect(fact!.params).toContain(QUERY);
    expect(episode!.params).not.toContain(QUERY);
  });

  it("never stores the raw query in the request row", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req({ queryText: QUERY }), [hit("fact", "f-1", 0)]);
    const request = committed.find((c) => c.text.includes("INTO mnemosyne.mnemo_recall_request"))!;
    expect(JSON.stringify(request.params)).not.toContain(QUERY);
  });

  it("synthetic/test fact hits carry no query text", async () => {
    const { repo, committed } = run();
    await repo.recordRecallObservation(req({ queryText: QUERY, trafficOrigin: "test" }), [
      hit("fact", "f-1", 0),
    ]);
    expect(logsOf(committed)[0]!.params).not.toContain(QUERY);
  });
});

describe("session-learning readers exclude synthetic/test observations (review r1)", () => {
  const dialect = new PgDialect();
  const guard =
    /NOT EXISTS[\s\S]*mnemo_recall_request[\s\S]*trafficOrigin'\s*IN \('synthetic', 'test'\)/;
  function capture() {
    const wheres: string[] = [];
    const where = (w: any) => {
      wheres.push(dialect.sqlToQuery(w).sql);
      return Object.assign(Promise.resolve([]), {
        orderBy: () => ({ limit: async () => [] }),
      });
    };
    const tx = {
      execute: async () => [],
      select: () => ({ from: () => ({ where }) }),
      selectDistinct: () => ({ from: () => ({ where }) }),
    };
    const db = { transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
    return { db, wheres };
  }

  it("getRecalledFactIds (session feedback, governance) filters synthetic/test rows", async () => {
    const { db, wheres } = capture();
    await new FactRepository(db as any, db as any).getRecalledFactIds(WS, "s1");
    expect(wheres[0]).toMatch(guard);
  });

  it("getTdPredecessors filters synthetic/test rows", async () => {
    const { db, wheres } = capture();
    await new RecallRepository(db as any, db as any).getTdPredecessors(WS, "s1", "f-0");
    expect(wheres[0]).toMatch(guard);
  });
});
