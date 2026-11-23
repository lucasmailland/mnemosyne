/// <reference types="node" />
/**
 * W7 CUP migration battle-test.
 *
 * Exercises the full migration pipeline at synthetic scale (50 000 rows):
 *   - All 8 v2 memory_type → v3 type mappings (TypeMapper coverage)
 *   - Keyset cursor correctness: cursor args verified at each batch boundary
 *   - Resumability: migrated count inherits from saved cursor row
 *   - Batch boundary: last page exactly batchSize → needs an empty terminator
 *   - Error isolation at scale: per-row failures don't stop the batch
 *   - pendingRelation insertion for "relational" type with entity_id
 *
 * Uses the same mock pattern as migrate.test.ts (no shared state between
 * files — each file is an independent module with its own vi.mock hoisting).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runMigration } from "../migrate.js";
import type { V2Memory } from "../TypeMapper.js";

// ─── Postgres mock ────────────────────────────────────────────────────────────

type SqlMock = ReturnType<typeof buildSqlMock>;

function buildSqlMock() {
  const fn = vi.fn();
  const mock = Object.assign(fn, {
    end: vi.fn().mockResolvedValue(undefined),
    json: vi.fn((v: unknown) => v),
    // Simulate postgres.begin(): execute the callback with a transaction mock.
    // SET LOCAL calls (ROLE, set_config) resolve to undefined without delegating
    // to the parent fn — tests count only data INSERTs via fn, not infra calls.
    begin: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      let infraCallsDone = 0;
      const tx = Object.assign(
        vi.fn((...args: unknown[]) => {
          // First 2 calls per transaction are SET LOCAL statements (infra, not data)
          if (infraCallsDone < 2) { infraCallsDone++; return Promise.resolve([]); }
          return fn(...args);
        }),
        { json: mock.json },
      );
      return await cb(tx);
    }),
  });
  return mock;
}

let srcSql: SqlMock;
let dstSql: SqlMock;
let callCount = 0;

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    callCount++;
    if (callCount === 1) return srcSql;
    return dstSql;
  }),
}));

// ─── V2 fixture helpers ───────────────────────────────────────────────────────

function makeRow(
  id: string,
  type: string,
  createdAtMs: number,
  opts: { entityId?: string } = {},
): V2Memory {
  const ts = new Date(createdAtMs).toISOString();
  return {
    id,
    workspace_id: "ws-battle",
    agent_id: "agent-battle",
    actor_id: undefined,
    session_id: undefined,
    memory_type: type,
    content: `Content for ${id}`,
    subject: `Subject ${id}`,
    confidence: 0.8,
    entity_id: opts.entityId,
    created_at: ts,
    updated_at: ts,
    metadata: {},
  };
}

// Cycles through all 8 v2 types in order.
const V2_TYPES = [
  "factual",
  "semantic",
  "procedural",
  "working",
  "contextual",
  "relational",
  "preference",
  "episodic",
] as const;

/** Generate `size` rows starting at global offset `startIdx`. */
function generateBatch(startIdx: number, size: number): V2Memory[] {
  return Array.from({ length: size }, (_, j) => {
    const rowIdx = startIdx + j;
    const type = V2_TYPES[rowIdx % V2_TYPES.length]!;
    return makeRow(
      `mem-${String(rowIdx).padStart(8, "0")}`,
      type,
      // 60 000 ms apart so created_at is strictly monotone
      Date.UTC(2024, 0, 1) + rowIdx * 60_000,
      { entityId: type === "relational" ? `ent-${rowIdx}` : undefined },
    );
  });
}

// ─── Shared test opts ─────────────────────────────────────────────────────────

const BASE = {
  srcUrl: "postgres://src",
  dstUrl: "postgres://dst",
  workspaceId: "ws-battle",
  batchSize: 100,
  dryRun: false,
} as const;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  callCount = 0;
  srcSql = buildSqlMock();
  dstSql = buildSqlMock();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. ALL 8 v2 MEMORY_TYPE MAPPINGS
// ─────────────────────────────────────────────────────────────────────────────

describe("W7: all 8 v2 memory_type mappings", () => {
  // Expected v3 counters after migrating one row of each v2 type.
  const cases: Array<{
    type: (typeof V2_TYPES)[number];
    facts: number;
    episodes: number;
    skills: number;
    relations: number;
    entityId?: string;
  }> = [
    { type: "factual",    facts: 1, episodes: 0, skills: 0, relations: 0 },
    { type: "semantic",   facts: 1, episodes: 0, skills: 0, relations: 0 },
    { type: "procedural", facts: 0, episodes: 0, skills: 1, relations: 0 },
    { type: "working",    facts: 1, episodes: 0, skills: 0, relations: 0 },
    { type: "contextual", facts: 0, episodes: 1, skills: 0, relations: 0 },
    { type: "relational", facts: 1, episodes: 0, skills: 0, relations: 1, entityId: "ent-999" },
    { type: "preference", facts: 1, episodes: 0, skills: 0, relations: 0 },
    { type: "episodic",   facts: 0, episodes: 1, skills: 0, relations: 0 },
  ];

  for (const c of cases) {
    it(`"${c.type}" → correct v3 counter increments`, async () => {
      const row = makeRow("m1", c.type, Date.UTC(2024, 0, 1), { entityId: c.entityId });

      srcSql.mockResolvedValueOnce([{ count: "1" }]);
      srcSql.mockResolvedValueOnce([row]);
      srcSql.mockResolvedValueOnce([]);
      dstSql.mockResolvedValue(undefined);

      const s = await runMigration({ ...BASE, batchSize: 100, dryRun: false });

      expect(s.migrated).toBe(1);
      expect(s.errors).toBe(0);
      expect(s.facts).toBe(c.facts);
      expect(s.episodes).toBe(c.episodes);
      expect(s.skills).toBe(c.skills);
      expect(s.relations).toBe(c.relations);

      // Both connections are always closed.
      expect(srcSql.end).toHaveBeenCalledOnce();
      expect(dstSql.end).toHaveBeenCalledOnce();
    });
  }

  it('"relational" without entity_id → fact inserted, NO relation', async () => {
    const row = makeRow("m1", "relational", Date.UTC(2024, 0, 1)); // no entityId

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce([row]);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const s = await runMigration({ ...BASE, dryRun: false });

    expect(s.facts).toBe(1);
    expect(s.relations).toBe(0);
  });

  it("unknown v2 type → mapped to errors counter, not migrated", async () => {
    const bad = makeRow("bad", "unknown_alien_type", Date.UTC(2024, 0, 1));
    const good = makeRow("ok", "factual", Date.UTC(2024, 0, 2));

    srcSql.mockResolvedValueOnce([{ count: "2" }]);
    srcSql.mockResolvedValueOnce([bad, good]);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const s = await runMigration({ ...BASE, dryRun: false });

    expect(s.errors).toBe(1);
    expect(s.migrated).toBe(1);
    expect(s.facts).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 50k-ROW VOLUME TEST
// ─────────────────────────────────────────────────────────────────────────────

describe("W7: 50 000-row volume", () => {
  it("migrates 50 000 rows in 500 batches with correct per-type tallies", async () => {
    const TOTAL = 50_000;
    const BATCH = 100;
    const BATCHES = TOTAL / BATCH; // 500

    let srcCallIdx = 0;
    srcSql.mockImplementation(() => {
      const idx = srcCallIdx++;
      if (idx === 0) return Promise.resolve([{ count: String(TOTAL) }]); // countTotal
      const batchIdx = idx - 1;
      if (batchIdx < BATCHES) return Promise.resolve(generateBatch(batchIdx * BATCH, BATCH));
      return Promise.resolve([]); // empty terminator
    });
    dstSql.mockResolvedValue(undefined);

    const s = await runMigration({ ...BASE, batchSize: BATCH, dryRun: false });

    expect(s.total).toBe(TOTAL);
    expect(s.migrated).toBe(TOTAL);
    expect(s.errors).toBe(0);

    // Types distribute evenly in cycles of 8 across 50 000 rows (50 000 / 8 = 6 250 each).
    const PER_TYPE = TOTAL / V2_TYPES.length; // 6 250
    expect(s.facts).toBe(PER_TYPE * 5);    // factual + semantic + working + relational + preference
    expect(s.episodes).toBe(PER_TYPE * 2); // episodic + contextual
    expect(s.skills).toBe(PER_TYPE * 1);   // procedural
    expect(s.relations).toBe(PER_TYPE * 1); // relational (all have entity_id in generateBatch)

    // 1 countTotal + 500 data batches + 1 empty terminator = 502 src calls
    expect(srcSql).toHaveBeenCalledTimes(BATCHES + 2);

    expect(srcSql.end).toHaveBeenCalledOnce();
    expect(dstSql.end).toHaveBeenCalledOnce();
  }, 30_000); // 50k rows × begin() mock overhead — generous CI budget

  it("dry-run across 50 000 rows: no dst writes, correct tallies", async () => {
    const TOTAL = 50_000;
    const BATCH = 100;
    const BATCHES = TOTAL / BATCH;

    let srcCallIdx = 0;
    srcSql.mockImplementation(() => {
      const idx = srcCallIdx++;
      if (idx === 0) return Promise.resolve([{ count: String(TOTAL) }]);
      const batchIdx = idx - 1;
      if (batchIdx < BATCHES) return Promise.resolve(generateBatch(batchIdx * BATCH, BATCH));
      return Promise.resolve([]);
    });

    const s = await runMigration({ ...BASE, batchSize: BATCH, dryRun: true });

    expect(s.total).toBe(TOTAL);
    expect(s.migrated).toBe(TOTAL);
    expect(s.dryRun).toBe(true);
    expect(s.errors).toBe(0);

    // In dry-run mode postgres is only called ONCE (src only — no dst connection).
    expect(callCount).toBe(1);
    expect(srcSql.end).toHaveBeenCalledOnce();
  }, 20_000); // 50k rows dry-run — generous CI budget
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. KEYSET CURSOR CORRECTNESS
// ─────────────────────────────────────────────────────────────────────────────

describe("W7: keyset cursor correctness", () => {
  it("cursor args advance to last row of each batch on subsequent pages", async () => {
    // 6 rows, batchSize=2 → 3 data batches + 1 empty terminator
    const batch1 = [
      makeRow("m01", "factual", Date.UTC(2024, 0, 1)),
      makeRow("m02", "factual", Date.UTC(2024, 0, 2)),
    ];
    const batch2 = [
      makeRow("m03", "factual", Date.UTC(2024, 0, 3)),
      makeRow("m04", "factual", Date.UTC(2024, 0, 4)),
    ];
    const batch3 = [
      makeRow("m05", "factual", Date.UTC(2024, 0, 5)),
      makeRow("m06", "factual", Date.UTC(2024, 0, 6)),
    ];

    srcSql.mockResolvedValueOnce([{ count: "6" }]);
    srcSql.mockResolvedValueOnce(batch1);
    srcSql.mockResolvedValueOnce(batch2);
    srcSql.mockResolvedValueOnce(batch3);
    srcSql.mockResolvedValueOnce([]);

    // Use dry-run so we only track one postgres instance (no dst complication).
    const s = await runMigration({ ...BASE, batchSize: 2, dryRun: true });

    expect(s.migrated).toBe(6);
    // countTotal(1) + 3 data batches + 1 empty = 5 src calls
    expect(srcSql).toHaveBeenCalledTimes(5);

    // Tagged-template calls: srcSql.mock.calls[n] = [templateStrings, ...values]
    //
    // First fetchBatch (no cursor) — call index 1:
    //   WHERE workspace_id = $1 ORDER BY ... LIMIT $2
    //   → values = [workspaceId, limit]
    const firstFetch = srcSql.mock.calls[1]!;
    expect(firstFetch[1]).toBe("ws-battle");   // workspaceId
    expect(firstFetch[2]).toBe(2);              // limit (batchSize)

    // Second fetchBatch (cursor = last of batch1) — call index 2:
    //   WHERE workspace_id = $1
    //     AND (created_at > $2 OR (created_at = $3 AND id > $4))
    //   ORDER BY ... LIMIT $5
    //   → values = [workspaceId, cursor.lastCreatedAt, cursor.lastCreatedAt, cursor.lastId, limit]
    const secondFetch = srcSql.mock.calls[2]!;
    expect(secondFetch[1]).toBe("ws-battle");
    expect(secondFetch[2]).toEqual(new Date(Date.UTC(2024, 0, 2))); // cursor.lastCreatedAt (m02)
    expect(secondFetch[3]).toEqual(new Date(Date.UTC(2024, 0, 2))); // same Date, second ref
    expect(secondFetch[4]).toBe("m02");                              // cursor.lastId
    expect(secondFetch[5]).toBe(2);                                  // limit

    // Third fetchBatch (cursor = last of batch2) — call index 3:
    const thirdFetch = srcSql.mock.calls[3]!;
    expect(thirdFetch[2]).toEqual(new Date(Date.UTC(2024, 0, 4))); // cursor.lastCreatedAt (m04)
    expect(thirdFetch[4]).toBe("m04");                              // cursor.lastId
  });

  it("batch boundary: last page exactly fills batchSize → empty page terminates", async () => {
    // batchSize=3, 6 rows → 2 full batches then empty terminator
    const batch1 = generateBatch(0, 3);
    const batch2 = generateBatch(3, 3);

    srcSql.mockResolvedValueOnce([{ count: "6" }]);
    srcSql.mockResolvedValueOnce(batch1);
    srcSql.mockResolvedValueOnce(batch2);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const s = await runMigration({ ...BASE, batchSize: 3, dryRun: false });

    expect(s.migrated).toBe(6);
    expect(s.total).toBe(6);
    // countTotal + 2 data batches + 1 empty terminator = 4 src calls
    expect(srcSql).toHaveBeenCalledTimes(4);
  });

  it("single-row batch: cursor advances after the only row", async () => {
    const row = makeRow("only", "semantic", Date.UTC(2024, 6, 15));
    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce([row]);
    srcSql.mockResolvedValueOnce([]);

    const s = await runMigration({ ...BASE, batchSize: 1, dryRun: true });

    expect(s.migrated).toBe(1);
    expect(srcSql).toHaveBeenCalledTimes(3); // countTotal + 1 data + empty
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. RESUMABILITY VIA mnemo_migration_cursor
// ─────────────────────────────────────────────────────────────────────────────

describe("W7: resumability via mnemo_migration_cursor", () => {
  it("resume: starts migrated count from saved cursor and accumulates correctly", async () => {
    // 250 batches of real (mocked) I/O plus per-row processing at 50k-row
    // scale reliably exceeds vitest's 5000ms default on shared CI runners
    // (observed failing 3/4 runs) — this is CPU/scheduling-bound work, not
    // a hang, so a longer timeout is the correct fix rather than retrying.
    // Prior run saved 25 000 migrated, cursor = row 24 999.
    const DONE_SO_FAR = 25_000;
    const REMAINING = 25_000;
    const TOTAL = 50_000;
    const BATCH = 100;
    const REMAINING_BATCHES = REMAINING / BATCH; // 250

    const savedCursor = {
      last_created_at: new Date(Date.UTC(2024, 0, 1) + (DONE_SO_FAR - 1) * 60_000),
      last_id: `mem-${String(DONE_SO_FAR - 1).padStart(8, "0")}`,
      total_migrated: DONE_SO_FAR,
    };

    // src: countTotal → full 50k (cursor just tells us where to start)
    let srcCallIdx = 0;
    srcSql.mockImplementation(() => {
      const idx = srcCallIdx++;
      if (idx === 0) return Promise.resolve([{ count: String(TOTAL) }]);
      const batchIdx = idx - 1;
      if (batchIdx < REMAINING_BATCHES) {
        return Promise.resolve(generateBatch(DONE_SO_FAR + batchIdx * BATCH, BATCH));
      }
      return Promise.resolve([]);
    });

    // dst: first call is cursor SELECT, everything else is inserts / cursor UPSERTs / status UPDATE
    let dstCallIdx = 0;
    dstSql.mockImplementation(() => {
      const idx = dstCallIdx++;
      if (idx === 0) return Promise.resolve([savedCursor]); // SELECT cursor row
      return Promise.resolve(undefined);                     // inserts / UPSERTs / UPDATE
    });

    const s = await runMigration({
      ...BASE,
      batchSize: BATCH,
      dryRun: false,
      runId: "run-resume-w7",
    });

    // migrated = 25 000 (from cursor) + 25 000 (new rows) = 50 000
    expect(s.migrated).toBe(TOTAL);
    expect(s.total).toBe(TOTAL);
    expect(s.errors).toBe(0);

    // Verify the 25 000 new rows have correct type tallies.
    // Rows 25 000 – 49 999 with 8-way cycle: 25 000 / 8 = 3 125 each type.
    const PER_TYPE = REMAINING / V2_TYPES.length; // 3 125
    expect(s.facts).toBe(PER_TYPE * 5);
    expect(s.episodes).toBe(PER_TYPE * 2);
    expect(s.skills).toBe(PER_TYPE * 1);
    expect(s.relations).toBe(PER_TYPE * 1);
  }, 20_000);

  it("resume: when no cursor row exists (fresh run ID), starts from 0", async () => {
    const row = makeRow("m1", "factual", Date.UTC(2024, 0, 1));

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce([row]);
    srcSql.mockResolvedValueOnce([]);

    // dst: cursor SELECT → empty (no prior run)
    let dstCallIdx = 0;
    dstSql.mockImplementation(() => {
      const idx = dstCallIdx++;
      if (idx === 0) return Promise.resolve([]); // no cursor row
      return Promise.resolve(undefined);
    });

    const s = await runMigration({
      ...BASE,
      dryRun: false,
      runId: "run-brand-new-w7",
    });

    expect(s.migrated).toBe(1);
    expect(s.facts).toBe(1);
  });

  it("resume: missing cursor table is swallowed, migration proceeds from scratch", async () => {
    const row = makeRow("m1", "factual", Date.UTC(2024, 0, 1));

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce([row]);
    srcSql.mockResolvedValueOnce([]);

    let dstCallIdx = 0;
    dstSql.mockImplementation(() => {
      const idx = dstCallIdx++;
      if (idx === 0) {
        return Promise.reject(new Error("relation mnemo_migration_cursor does not exist"));
      }
      return Promise.resolve(undefined);
    });

    const s = await runMigration({
      ...BASE,
      dryRun: false,
      runId: "run-no-table-w7",
    });

    // Must not throw; migrated=1 from fresh start
    expect(s.migrated).toBe(1);
    expect(s.errors).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ERROR ISOLATION AT SCALE
// ─────────────────────────────────────────────────────────────────────────────

describe("W7: error isolation at scale", () => {
  it("every 5th insert failure: correct error + migrated tally", async () => {
    const TOTAL = 100;
    // Use only "factual" rows to avoid relational double-calls that would
    // shift the modulo arithmetic.
    const rows = Array.from({ length: TOTAL }, (_, i) =>
      makeRow(`m${i}`, "factual", Date.UTC(2024, 0, 1) + i * 60_000),
    );

    srcSql.mockResolvedValueOnce([{ count: String(TOTAL) }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);

    let callIdx = 0;
    dstSql.mockImplementation(() => {
      const i = callIdx++;
      // Rows 4, 9, 14, ..., 99 fail (every 5th, 0-based) → 20 failures
      return i % 5 === 4
        ? Promise.reject(new Error("constraint violation"))
        : Promise.resolve(undefined);
    });

    const s = await runMigration({ ...BASE, batchSize: TOTAL, dryRun: false });

    expect(s.errors).toBe(20);
    expect(s.migrated).toBe(80);
    expect(s.facts).toBe(80);

    // Both connections closed despite failures
    expect(srcSql.end).toHaveBeenCalledOnce();
    expect(dstSql.end).toHaveBeenCalledOnce();
  });

  it("all inserts fail: migrated=0, errors=total, no throw", async () => {
    const rows = generateBatch(0, 50);

    srcSql.mockResolvedValueOnce([{ count: "50" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);

    dstSql.mockRejectedValue(new Error("db down"));

    const s = await runMigration({ ...BASE, batchSize: 50, dryRun: false });

    // All 50 rows fail — errors is not necessarily 50 exactly when relational
    // rows also attempt insertRelation; but migrated is 0.
    expect(s.migrated).toBe(0);
    expect(s.errors).toBeGreaterThan(0);
    expect(srcSql.end).toHaveBeenCalledOnce();
  });

  it("mixed batch: some type errors + some insert errors isolated per row", async () => {
    const rows = [
      makeRow("bad",  "unknown_type",   Date.UTC(2024, 0, 1)), // TypeMapper → error
      makeRow("ok1",  "factual",        Date.UTC(2024, 0, 2)), // insert succeeds
      makeRow("fail", "semantic",       Date.UTC(2024, 0, 3)), // insert fails
      makeRow("ok2",  "episodic",       Date.UTC(2024, 0, 4)), // insert succeeds
    ];

    srcSql.mockResolvedValueOnce([{ count: "4" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);

    // Insert calls: ok1 → ok, fail → reject, ok2 → ok
    let dstCallIdx = 0;
    dstSql.mockImplementation(() => {
      const i = dstCallIdx++;
      return i === 1
        ? Promise.reject(new Error("unique_violation"))
        : Promise.resolve(undefined);
    });

    const s = await runMigration({ ...BASE, batchSize: 10, dryRun: false });

    // 1 TypeMapper error + 1 insert error = 2 total errors
    expect(s.errors).toBe(2);
    // 1 fact (ok1) + 1 episode (ok2) = 2 migrated
    expect(s.migrated).toBe(2);
    expect(s.facts).toBe(1);
    expect(s.episodes).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. pendingRelation INSERTION
// ─────────────────────────────────────────────────────────────────────────────

describe("W7: pendingRelation insertion", () => {
  it("relational type with entity_id triggers both insertFact and insertRelation", async () => {
    const row = makeRow("rel1", "relational", Date.UTC(2024, 0, 1), { entityId: "entity-abc" });

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce([row]);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const s = await runMigration({ ...BASE, dryRun: false });

    expect(s.facts).toBe(1);
    expect(s.relations).toBe(1);
    expect(s.migrated).toBe(1);
    // Two dst INSERT calls: insertFact + insertRelation
    expect(dstSql).toHaveBeenCalledTimes(2);
  });

  it("10 relational rows → 10 facts and 10 relations", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow(`r${i}`, "relational", Date.UTC(2024, 0, i + 1), { entityId: `ent-${i}` }),
    );

    srcSql.mockResolvedValueOnce([{ count: "10" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const s = await runMigration({ ...BASE, dryRun: false });

    expect(s.facts).toBe(10);
    expect(s.relations).toBe(10);
    expect(s.migrated).toBe(10);
    // 10 insertFact + 10 insertRelation = 20 dst calls
    expect(dstSql).toHaveBeenCalledTimes(20);
  });

  it("relational row insertFact failure skips insertRelation for that row", async () => {
    const rows = [
      makeRow("fail", "relational", Date.UTC(2024, 0, 1), { entityId: "ent-1" }),
      makeRow("ok",   "relational", Date.UTC(2024, 0, 2), { entityId: "ent-2" }),
    ];

    srcSql.mockResolvedValueOnce([{ count: "2" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);

    // First insertFact fails; everything else succeeds
    dstSql
      .mockRejectedValueOnce(new Error("constraint violation")) // insertFact(fail) → fails
      .mockResolvedValue(undefined);                            // insertFact(ok) + insertRelation(ok)

    const s = await runMigration({ ...BASE, dryRun: false });

    // 1 failed insertFact → 0 insertRelation for that row; 1 success → 1 relation
    expect(s.errors).toBe(1);
    expect(s.migrated).toBe(1);
    expect(s.facts).toBe(1);
    expect(s.relations).toBe(1);
  });
});
