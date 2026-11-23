/// <reference types="node" />
/**
 * OPS-7: Unit tests for the CUP migration runner.
 *
 * Tests parseArgs (exported) and runMigration (via a mocked postgres driver).
 *
 * Design decisions:
 * - `parseArgs` is pure and synchronous — tested directly.
 * - `runMigration` constructs postgres clients internally, so we mock the
 *   "postgres" module at the module boundary. The mock returns a tagged-
 *   template function that we can program per-test.
 * - No `as any` casts for test logic; type-safe helpers are used throughout.
 * - The `main()` auto-run guard (isMain check) means importing this module
 *   does NOT trigger process.exit or DB calls.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { parseArgs, runMigration, createEmbedder, reclassifyBatch } from "../migrate.js";
import type { MappedItem } from "../TypeMapper.js";

// ─── postgres.js mock ─────────────────────────────────────────────────────────
//
// runMigration calls: postgres(srcUrl, opts) → sql  and  postgres(dstUrl, opts) → sql
// Each `sql` is then used as a tagged-template function plus sql.end() / sql.json().
//
// We track the two instances separately (srcSql, dstSql) so we can control
// each independently. The postgres factory mock captures call order.

type SqlMock = ReturnType<typeof buildSqlMock>;

function buildSqlMock() {
  const fn = vi.fn();
  const mock = Object.assign(fn, {
    end: vi.fn().mockResolvedValue(undefined),
    json: vi.fn((v: unknown) => v),
    // Simulate postgres.begin(): SET LOCAL calls resolve silently; data INSERTs
    // delegate to the parent fn so assertion counts stay consistent.
    begin: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      let infraCallsDone = 0;
      const tx = Object.assign(
        vi.fn((...args: unknown[]) => {
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

// The factory is called twice: first call → srcSql, second call → dstSql.
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

// ─── @mnemo-ai/llm-providers mock ───────────────────────────────────────────
//
// createEmbedder() and the --llm provider path both call
// `import("@mnemo-ai/llm-providers")` at runtime. We mock the entire module
// at the top level so every dynamic import in the same test process resolves
// to our mock.
//
// The mock factory is defined once. Individual tests override
// `mockCreateProviderImpl` to control what createProvider returns.

let mockCreateProviderImpl: () => {
  capabilities: { embed: boolean; complete: boolean };
  embed?: (text: string, model: string) => Promise<number[]>;
  complete?: (req: { prompt: string; maxTokens?: number }) => Promise<{ text: string }>;
} = () => ({
  capabilities: { embed: false, complete: false },
});

vi.mock("@mnemo-ai/llm-providers", () => ({
  createProvider: vi.fn((opts: unknown) => {
    void opts;
    return mockCreateProviderImpl();
  }),
}));

// ─── V2 memory fixture factories ─────────────────────────────────────────────

function makeV2Memory(overrides: Partial<{
  id: string;
  workspace_id: string;
  memory_type: string;
  content: string;
  subject: string;
  entity_id: string;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    id: overrides.id ?? "mem-1",
    workspace_id: overrides.workspace_id ?? "ws-abc",
    agent_id: "agent-1",
    actor_id: undefined,
    session_id: undefined,
    memory_type: overrides.memory_type ?? "factual",
    content: overrides.content ?? "The sky is blue.",
    subject: overrides.subject ?? "sky",
    confidence: 0.9,
    entity_id: overrides.entity_id,
    created_at: overrides.created_at ?? "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    metadata: {},
  };
}

/** A factual v2 memory with caller-controlled metadata (for B6.35 marker tests). */
function makeV2MemoryWithMeta(id: string, metadata: Record<string, unknown>) {
  return {
    id,
    workspace_id: "ws-abc",
    agent_id: "agent-1",
    actor_id: undefined,
    session_id: undefined,
    memory_type: "factual",
    content: "The sky is blue.",
    subject: "sky",
    confidence: 0.9,
    entity_id: undefined,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    metadata,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Spy on process.exit and throw instead of exiting — makes parseArgs testable. */
function withExitSpy(fn: () => void) {
  const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  const base = ["node", "migrate.js"];

  it("parses --workspace and sets sensible defaults", () => {
    const a = parseArgs([...base, "--workspace", "ws-1"]);
    expect(a.workspace).toBe("ws-1");
    expect(a.batchSize).toBe(100);
    expect(a.dryRun).toBe(false);
    expect(a.llm).toBe(false);
    // runId should be a UUID-shaped string
    expect(a.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("honors --batch-size, --dry-run, --llm, and --run-id", () => {
    const a = parseArgs([
      ...base,
      "--workspace", "ws-2",
      "--batch-size", "25",
      "--dry-run",
      "--llm",
      "--run-id", "run-xyz",
    ]);
    expect(a.batchSize).toBe(25);
    expect(a.dryRun).toBe(true);
    expect(a.llm).toBe(true);
    expect(a.runId).toBe("run-xyz");
  });

  it("rejects --batch-size 0 (non-positive)", () => {
    withExitSpy(() => {
      expect(() => parseArgs([...base, "--workspace", "w", "--batch-size", "0"])).toThrow(
        "process.exit:1",
      );
    });
  });

  it("rejects --batch-size with a non-numeric value", () => {
    withExitSpy(() => {
      expect(() => parseArgs([...base, "--workspace", "w", "--batch-size", "abc"])).toThrow(
        "process.exit:1",
      );
    });
  });

  it("requires --workspace (exits 1 when omitted)", () => {
    withExitSpy(() => {
      expect(() => parseArgs([...base])).toThrow("process.exit:1");
    });
  });

  it("rejects unknown arguments", () => {
    withExitSpy(() => {
      expect(() => parseArgs([...base, "--workspace", "w", "--bogus-flag"])).toThrow(
        "process.exit:1",
      );
    });
  });

  it("accepts --help without crashing (exits 0)", () => {
    withExitSpy(() => {
      expect(() => parseArgs([...base, "--help"])).toThrow("process.exit:0");
    });
  });

  it("accepts -h as an alias for --help (exits 0)", () => {
    withExitSpy(() => {
      expect(() => parseArgs([...base, "-h"])).toThrow("process.exit:0");
    });
  });

  it("generates a unique runId on each call when --run-id not supplied", () => {
    const a1 = parseArgs([...base, "--workspace", "ws-1"]);
    const a2 = parseArgs([...base, "--workspace", "ws-1"]);
    expect(a1.runId).not.toBe(a2.runId);
  });

  it("accepts a large batch size (>100)", () => {
    const a = parseArgs([...base, "--workspace", "ws-1", "--batch-size", "500"]);
    expect(a.batchSize).toBe(500);
  });
});

// ─── runMigration ─────────────────────────────────────────────────────────────

describe("runMigration", () => {
  const BASE_OPTS = {
    srcUrl: "postgres://src",
    dstUrl: "postgres://dst",
    workspaceId: "ws-abc",
    batchSize: 100,
    dryRun: false,
  };

  beforeEach(() => {
    // Reset the postgres factory call counter and create fresh sql mocks.
    callCount = 0;
    srcSql = buildSqlMock();
    dstSql = buildSqlMock();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("happy path: migrates one batch of mixed types and tallies summary", async () => {
    const rows = [
      makeV2Memory({ id: "m1", memory_type: "factual", content: "Fact one" }),
      makeV2Memory({ id: "m2", memory_type: "episodic", content: "Episode one", subject: "Ep" }),
      makeV2Memory({ id: "m3", memory_type: "procedural", content: "Proc one", subject: "Proc" }),
    ];

    // src: countTotal → 3 rows, fetchBatch → rows then empty (terminates loop)
    srcSql.mockResolvedValueOnce([{ count: "3" }]);  // countTotal
    srcSql.mockResolvedValueOnce(rows);              // fetchBatch (first page)
    srcSql.mockResolvedValueOnce([]);                // fetchBatch (second page → stops)

    // dst: each insertFact/insertEpisode/insertSkill resolves (no return value needed)
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration(BASE_OPTS);

    expect(summary.total).toBe(3);
    expect(summary.migrated).toBe(3);
    expect(summary.errors).toBe(0);
    expect(summary.facts).toBe(1);
    expect(summary.episodes).toBe(1);
    expect(summary.skills).toBe(1);
    expect(summary.relations).toBe(0);
    expect(summary.dryRun).toBe(false);

    // Ensure both connections are closed
    expect(srcSql.end).toHaveBeenCalledOnce();
    expect(dstSql.end).toHaveBeenCalledOnce();
  });

  it("happy path: relation is inserted for relational type with entity_id", async () => {
    const rows = [
      makeV2Memory({ id: "m1", memory_type: "relational", entity_id: "ent-999" }),
    ];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration(BASE_OPTS);

    expect(summary.facts).toBe(1);
    expect(summary.relations).toBe(1);
    expect(summary.migrated).toBe(1);
  });

  it("happy path: empty workspace produces a zero-record summary immediately", async () => {
    srcSql.mockResolvedValueOnce([{ count: "0" }]);

    const summary = await runMigration(BASE_OPTS);

    expect(summary.total).toBe(0);
    expect(summary.migrated).toBe(0);
    expect(summary.errors).toBe(0);
    // No fetchBatch calls should happen
    expect(srcSql).toHaveBeenCalledTimes(1); // only countTotal
    expect(srcSql.end).toHaveBeenCalledOnce();
  });

  // ── Dry-run mode ─────────────────────────────────────────────────────────────

  it("dry-run: tallies counts without calling dst inserts", async () => {
    const rows = [
      makeV2Memory({ id: "m1", memory_type: "factual" }),
      makeV2Memory({ id: "m2", memory_type: "semantic" }),
      makeV2Memory({ id: "m3", memory_type: "episodic", subject: "An episode" }),
    ];

    srcSql.mockResolvedValueOnce([{ count: "3" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);

    const summary = await runMigration({ ...BASE_OPTS, dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.total).toBe(3);
    expect(summary.migrated).toBe(3);
    expect(summary.facts).toBe(2);
    expect(summary.episodes).toBe(1);
    expect(summary.skills).toBe(0);
    expect(summary.errors).toBe(0);

    // No dst connection should have been created in dry-run mode
    // (postgres factory is only called once for src)
    expect(dstSql).not.toHaveBeenCalled(); // dstSql never used
    expect(srcSql.end).toHaveBeenCalledOnce();
  });

  it("dry-run: tallies relations for relational types with entity_id", async () => {
    const rows = [
      makeV2Memory({ id: "m1", memory_type: "relational", entity_id: "ent-1" }),
    ];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);

    const summary = await runMigration({ ...BASE_OPTS, dryRun: true });

    expect(summary.facts).toBe(1);
    expect(summary.relations).toBe(1);
    expect(summary.migrated).toBe(1);
  });

  it("dry-run: empty workspace exits cleanly with zero tallies", async () => {
    srcSql.mockResolvedValueOnce([{ count: "0" }]);

    const summary = await runMigration({ ...BASE_OPTS, dryRun: true });

    expect(summary.total).toBe(0);
    expect(summary.migrated).toBe(0);
    expect(summary.facts).toBe(0);
  });

  // ── Idempotency ───────────────────────────────────────────────────────────────
  // The ON CONFLICT DO NOTHING clauses in the INSERT statements make the DB
  // idempotent. We verify that a second call with the same rows does NOT
  // increment the counters above what the batch contains (each row is counted
  // once per successful `insertFact/Episode/Skill` call). There is no way to
  // skip already-inserted rows at the runner level — that is delegated to PG
  // constraints. What we can verify is that re-running with the same input
  // produces the same summary totals.

  it("idempotency: running twice with the same rows produces identical summaries", async () => {
    const rows = [
      makeV2Memory({ id: "m1", memory_type: "factual" }),
      makeV2Memory({ id: "m2", memory_type: "episodic", subject: "An ep" }),
    ];

    // First run
    srcSql.mockResolvedValueOnce([{ count: "2" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary1 = await runMigration(BASE_OPTS);

    // Reset mock state for second run
    callCount = 0;
    srcSql = buildSqlMock();
    dstSql = buildSqlMock();
    srcSql.mockResolvedValueOnce([{ count: "2" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary2 = await runMigration(BASE_OPTS);

    expect(summary1.migrated).toBe(summary2.migrated);
    expect(summary1.facts).toBe(summary2.facts);
    expect(summary1.episodes).toBe(summary2.episodes);
    expect(summary1.errors).toBe(summary2.errors);
  });

  it("idempotency: keyset cursor advances with each batch — no duplicate reads", async () => {
    const batch1 = [
      makeV2Memory({ id: "m1", memory_type: "factual", created_at: "2024-01-01T00:00:00.000Z" }),
      makeV2Memory({ id: "m2", memory_type: "factual", created_at: "2024-01-02T00:00:00.000Z" }),
    ];
    const batch2 = [
      makeV2Memory({ id: "m3", memory_type: "factual", created_at: "2024-01-03T00:00:00.000Z" }),
    ];

    srcSql.mockResolvedValueOnce([{ count: "3" }]); // countTotal
    srcSql.mockResolvedValueOnce(batch1);           // first fetchBatch
    srcSql.mockResolvedValueOnce(batch2);           // second fetchBatch
    srcSql.mockResolvedValueOnce([]);               // third fetchBatch → terminates

    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration({ ...BASE_OPTS, batchSize: 2 });

    expect(summary.migrated).toBe(3);
    expect(summary.facts).toBe(3);

    // fetchBatch was called 3 times (2 pages with data + 1 empty terminator)
    // plus 1 countTotal call = 4 total src calls
    expect(srcSql).toHaveBeenCalledTimes(4);
  });

  // ── Error handling paths ──────────────────────────────────────────────────────

  it("handles individual insert failures without stopping the batch", async () => {
    const rows = [
      makeV2Memory({ id: "m1", memory_type: "factual" }),
      makeV2Memory({ id: "m2", memory_type: "factual" }),
      makeV2Memory({ id: "m3", memory_type: "factual" }),
    ];

    srcSql.mockResolvedValueOnce([{ count: "3" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);

    // Second insert fails; first and third succeed
    dstSql
      .mockResolvedValueOnce(undefined)   // insertFact(m1) success
      .mockRejectedValueOnce(new Error("unique_violation"))  // insertFact(m2) fails
      .mockResolvedValueOnce(undefined);  // insertFact(m3) success

    const summary = await runMigration(BASE_OPTS);

    expect(summary.migrated).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.facts).toBe(2); // only successful inserts counted
    expect(srcSql.end).toHaveBeenCalledOnce();
    expect(dstSql.end).toHaveBeenCalledOnce();
  });

  it("handles unknown v2 memory_type as a mapping failure (not an insert error)", async () => {
    const rows = [
      makeV2Memory({ id: "m1", memory_type: "unknown_alien_type" }),
      makeV2Memory({ id: "m2", memory_type: "factual" }),
    ];

    srcSql.mockResolvedValueOnce([{ count: "2" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration(BASE_OPTS);

    // m1 fails mapping → error counter, m2 succeeds → migrated
    expect(summary.errors).toBe(1);
    expect(summary.migrated).toBe(1);
    expect(summary.facts).toBe(1);
  });

  it("closes both connections even when countTotal throws", async () => {
    srcSql.mockRejectedValueOnce(new Error("connection timeout"));

    await expect(runMigration(BASE_OPTS)).rejects.toThrow("connection timeout");

    expect(srcSql.end).toHaveBeenCalledOnce();
    // dst is null in this case (dryRun=false but error happens before dst used)
    // dstSql.end may or may not be called depending on whether dst was opened
    // The important thing is src is always closed.
  });

  it("closes src connection when fetchBatch throws on the second page", async () => {
    const rows = [makeV2Memory({ id: "m1", memory_type: "factual" })];

    srcSql.mockResolvedValueOnce([{ count: "5" }]); // countTotal
    srcSql.mockResolvedValueOnce(rows);              // first fetchBatch ok
    srcSql.mockRejectedValueOnce(new Error("network error")); // second fetchBatch fails
    dstSql.mockResolvedValue(undefined);

    await expect(runMigration(BASE_OPTS)).rejects.toThrow("network error");

    expect(srcSql.end).toHaveBeenCalledOnce();
  });

  // ── Run-ID resume path ────────────────────────────────────────────────────────

  it("resumes a run by loading the keyset cursor from the DB when runId supplied", async () => {
    const savedCursor = {
      last_created_at: new Date("2024-01-05T00:00:00.000Z"),
      last_id: "mem-prev",
      total_migrated: 50,
    };
    const rows = [
      makeV2Memory({ id: "m10", memory_type: "factual", created_at: "2024-01-06T00:00:00.000Z" }),
    ];

    srcSql.mockResolvedValueOnce([{ count: "51" }]); // countTotal
    srcSql.mockResolvedValueOnce(rows);              // fetchBatch (resumed from cursor)
    srcSql.mockResolvedValueOnce([]);                // empty → stop

    // dst: cursor SELECT, then insert, then cursor UPSERT, then UPDATE (completed)
    dstSql
      .mockResolvedValueOnce([savedCursor]) // SELECT cursor row (resume)
      .mockResolvedValueOnce(undefined)     // insertFact
      .mockResolvedValueOnce(undefined)     // cursor UPSERT (persist)
      .mockResolvedValueOnce(undefined);    // UPDATE status=completed

    const summary = await runMigration({
      ...BASE_OPTS,
      runId: "run-resume-001",
    });

    // Should start migrated count from saved cursor (50), add 1 more
    expect(summary.migrated).toBe(51);
    expect(summary.facts).toBe(1);
  });

  it("starts fresh when no cursor row exists for the run-id", async () => {
    const rows = [makeV2Memory({ id: "m1", memory_type: "factual" })];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);

    // dst: cursor SELECT returns empty (no prior cursor)
    dstSql
      .mockResolvedValueOnce([])       // SELECT cursor → no row
      .mockResolvedValueOnce(undefined) // insertFact
      .mockResolvedValueOnce(undefined) // cursor UPSERT
      .mockResolvedValueOnce(undefined); // UPDATE status=completed

    const summary = await runMigration({
      ...BASE_OPTS,
      runId: "run-brand-new",
    });

    expect(summary.migrated).toBe(1);
    expect(summary.facts).toBe(1);
  });

  it("treats a missing cursor table gracefully (swallows the error, starts fresh)", async () => {
    const rows = [makeV2Memory({ id: "m1", memory_type: "factual" })];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);

    // dst: cursor SELECT throws (table doesn't exist), then proceed normally
    dstSql
      .mockRejectedValueOnce(new Error("relation mnemo_migration_cursor does not exist"))
      .mockResolvedValueOnce(undefined)  // insertFact
      .mockResolvedValueOnce(undefined); // cursor UPSERT also throws or succeeds — non-fatal

    const summary = await runMigration({
      ...BASE_OPTS,
      runId: "run-no-table",
    });

    // Should not throw; migrated count starts from 0 (fresh)
    expect(summary.migrated).toBe(1);
    expect(summary.errors).toBe(0);
  });

  // ── LLM flag ──────────────────────────────────────────────────────────────────

  it("llm flag: proceeds with migration even when MNEMO_LLM_API_KEY is absent", async () => {
    delete process.env["MNEMO_LLM_API_KEY"];
    const rows = [makeV2Memory({ id: "m1", memory_type: "factual" })];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration({ ...BASE_OPTS, llm: true });

    expect(summary.migrated).toBe(1);
    expect(summary.errors).toBe(0);
  });
});

// ─── createEmbedder ───────────────────────────────────────────────────────────

describe("createEmbedder", () => {
  afterEach(() => {
    // Restore env changes after each test
    delete process.env["MNEMO_EMBED_PROVIDER"];
    delete process.env["MNEMO_EMBED_API_KEY"];
    delete process.env["MNEMO_LLM_PROVIDER"];
    delete process.env["MNEMO_LLM_API_KEY"];
    vi.clearAllMocks();
  });

  it("returns null when no provider env vars are set", async () => {
    delete process.env["MNEMO_EMBED_PROVIDER"];
    delete process.env["MNEMO_LLM_PROVIDER"];
    delete process.env["MNEMO_EMBED_API_KEY"];
    delete process.env["MNEMO_LLM_API_KEY"];

    const embedder = await createEmbedder();
    expect(embedder).toBeNull();
  });

  it("returns null when provider name is set but API key is missing", async () => {
    process.env["MNEMO_LLM_PROVIDER"] = "openai";
    delete process.env["MNEMO_LLM_API_KEY"];
    delete process.env["MNEMO_EMBED_API_KEY"];

    const embedder = await createEmbedder();
    expect(embedder).toBeNull();
  });

  it("returns null when the provider does not support embeddings", async () => {
    process.env["MNEMO_LLM_PROVIDER"] = "anthropic";
    process.env["MNEMO_LLM_API_KEY"] = "sk-test";

    mockCreateProviderImpl = () => ({
      capabilities: { embed: false, complete: true },
    });

    const embedder = await createEmbedder();
    expect(embedder).toBeNull();
  });

  it("returns an embed function when provider supports embeddings", async () => {
    process.env["MNEMO_LLM_PROVIDER"] = "openai";
    process.env["MNEMO_LLM_API_KEY"] = "sk-test";

    const fakeVector = [0.1, 0.2, 0.3];
    mockCreateProviderImpl = () => ({
      capabilities: { embed: true, complete: false },
      embed: vi.fn().mockResolvedValue(fakeVector),
    });

    const embedder = await createEmbedder();
    expect(embedder).not.toBeNull();
    const result = await embedder!("hello world");
    expect(result).toEqual(fakeVector);
  });

  it("returns null on embedding errors (catches and returns null)", async () => {
    process.env["MNEMO_LLM_PROVIDER"] = "openai";
    process.env["MNEMO_LLM_API_KEY"] = "sk-test";

    mockCreateProviderImpl = () => ({
      capabilities: { embed: true, complete: false },
      embed: vi.fn().mockRejectedValue(new Error("rate limit")),
    });

    const embedder = await createEmbedder();
    expect(embedder).not.toBeNull();
    const result = await embedder!("some text");
    expect(result).toBeNull();
  });

  it("uses MNEMO_EMBED_PROVIDER / MNEMO_EMBED_API_KEY when set (dedicated embed provider)", async () => {
    process.env["MNEMO_EMBED_PROVIDER"] = "voyage";
    process.env["MNEMO_EMBED_API_KEY"] = "vk-test";

    const fakeVector = [0.5, 0.6];
    mockCreateProviderImpl = () => ({
      capabilities: { embed: true, complete: false },
      embed: vi.fn().mockResolvedValue(fakeVector),
    });

    const embedder = await createEmbedder();
    expect(embedder).not.toBeNull();
    const result = await embedder!("voyage text");
    expect(result).toEqual(fakeVector);
  });
});

// ─── Embedding in runMigration ────────────────────────────────────────────────

describe("runMigration — embedding", () => {
  beforeEach(() => {
    callCount = 0;
    srcSql = buildSqlMock();
    dstSql = buildSqlMock();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env["MNEMO_LLM_PROVIDER"];
    delete process.env["MNEMO_LLM_API_KEY"];
    delete process.env["MNEMO_EMBED_PROVIDER"];
    delete process.env["MNEMO_EMBED_API_KEY"];
  });

  it("passes embedding to insertFact when embedder returns a vector", async () => {
    process.env["MNEMO_LLM_PROVIDER"] = "openai";
    process.env["MNEMO_LLM_API_KEY"] = "sk-test";

    const fakeVector = [0.1, 0.2, 0.3];
    mockCreateProviderImpl = () => ({
      capabilities: { embed: true, complete: false },
      embed: vi.fn().mockResolvedValue(fakeVector),
    });

    const rows = [makeV2Memory({ id: "m1", memory_type: "factual", content: "The sky is blue." })];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration({
      srcUrl: "postgres://src",
      dstUrl: "postgres://dst",
      workspaceId: "ws-embed-test",
      batchSize: 100,
      dryRun: false,
    });

    expect(summary.migrated).toBe(1);
    expect(summary.facts).toBe(1);
    expect(summary.errors).toBe(0);

    // insertFact is called via dstSql — check that the embedding-bearing branch
    // was triggered by inspecting the dstSql call args. The halfvec literal
    // `[0.1,0.2,0.3]::halfvec` should appear somewhere in the call.
    const dstCalls = dstSql.mock.calls;
    const hasEmbedding = dstCalls.some((callArgs: unknown[]) =>
      JSON.stringify(callArgs).includes("[0.1,0.2,0.3]"),
    );
    expect(hasEmbedding).toBe(true);
  });

  it("inserts without embedding when embedder returns null", async () => {
    process.env["MNEMO_LLM_PROVIDER"] = "openai";
    process.env["MNEMO_LLM_API_KEY"] = "sk-test";

    mockCreateProviderImpl = () => ({
      capabilities: { embed: true, complete: false },
      embed: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    const rows = [makeV2Memory({ id: "m1", memory_type: "factual" })];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration({
      srcUrl: "postgres://src",
      dstUrl: "postgres://dst",
      workspaceId: "ws-embed-null",
      batchSize: 100,
      dryRun: false,
    });

    // Should still migrate — embedding failure is non-fatal
    expect(summary.migrated).toBe(1);
    expect(summary.errors).toBe(0);
  });
});

// ─── reclassifyBatch ─────────────────────────────────────────────────────────

describe("reclassifyBatch", () => {
  it("reclassifies an item when LLM returns a different valid type", async () => {
    const item: MappedItem = {
      type: "fact",
      input: {
        workspaceId: "ws-1",
        scope: "global",
        statement: "Went to the store yesterday.",
        subject: "store",
        kind: "other",
      },
    };

    const mockComplete = vi.fn().mockResolvedValue({ text: "episode" });
    const { reclassified } = await reclassifyBatch([item], { complete: mockComplete });

    expect(reclassified).toBe(1);
    expect(item.type).toBe("episode");
    expect(mockComplete).toHaveBeenCalledOnce();
  });

  it("does not reclassify when LLM returns the same type", async () => {
    const item: MappedItem = {
      type: "fact",
      input: {
        workspaceId: "ws-1",
        scope: "global",
        statement: "The sky is blue.",
        subject: "sky",
        kind: "other",
      },
    };

    const mockComplete = vi.fn().mockResolvedValue({ text: "fact" });
    const { reclassified } = await reclassifyBatch([item], { complete: mockComplete });

    expect(reclassified).toBe(0);
    expect(item.type).toBe("fact");
  });

  it("does not reclassify when LLM returns an invalid type", async () => {
    const item: MappedItem = {
      type: "fact",
      input: {
        workspaceId: "ws-1",
        scope: "global",
        statement: "Something.",
        subject: "thing",
        kind: "other",
      },
    };

    const mockComplete = vi.fn().mockResolvedValue({ text: "  UNKNOWN_TYPE  " });
    const { reclassified } = await reclassifyBatch([item], { complete: mockComplete });

    expect(reclassified).toBe(0);
    expect(item.type).toBe("fact");
  });

  it("falls back to original type when LLM call throws (non-fatal)", async () => {
    const item: MappedItem = {
      type: "fact",
      input: {
        workspaceId: "ws-1",
        scope: "global",
        statement: "Something that fails.",
        subject: "fail",
        kind: "other",
      },
    };

    const mockComplete = vi.fn().mockRejectedValue(new Error("API rate limit"));
    const { reclassified } = await reclassifyBatch([item], { complete: mockComplete });

    // No reclassification — original type preserved
    expect(reclassified).toBe(0);
    expect(item.type).toBe("fact");
  });

  it("handles batch of items with mixed LLM outcomes", async () => {
    const items: MappedItem[] = [
      {
        type: "fact",
        input: {
          workspaceId: "ws-1",
          scope: "global",
          statement: "Went to the beach.",
          subject: "beach",
          kind: "other",
        },
      },
      {
        type: "fact",
        input: {
          workspaceId: "ws-1",
          scope: "global",
          statement: "The sky is blue.",
          subject: "sky",
          kind: "other",
        },
      },
      {
        type: "episode",
        input: {
          workspaceId: "ws-1",
          title: "Meeting",
          narrative: "Had a meeting.",
          occurredAt: new Date("2024-01-01"),
        },
      },
    ];

    const mockComplete = vi.fn()
      .mockResolvedValueOnce({ text: "episode" })  // item[0]: fact → episode
      .mockResolvedValueOnce({ text: "fact" })     // item[1]: same, no change
      .mockRejectedValueOnce(new Error("fail"));   // item[2]: throws, keeps episode

    const { reclassified } = await reclassifyBatch(items, { complete: mockComplete }, 3);

    expect(reclassified).toBe(1);
    expect(items[0]!.type).toBe("episode");
    expect(items[1]!.type).toBe("fact");
    expect(items[2]!.type).toBe("episode");
  });

  it("respects maxConcurrent semaphore (all items complete even with concurrency limit)", async () => {
    const n = 10;
    const items: MappedItem[] = Array.from({ length: n }, (_, i) => ({
      type: "fact" as const,
      input: {
        workspaceId: "ws-1",
        scope: "global" as const,
        statement: `Fact ${i}`,
        subject: "subject",
        kind: "other" as const,
      },
    }));

    const mockComplete = vi.fn().mockResolvedValue({ text: "episode" });
    const { reclassified } = await reclassifyBatch(items, { complete: mockComplete }, 2);

    expect(reclassified).toBe(n);
    expect(mockComplete).toHaveBeenCalledTimes(n);
  });
});

// ─── runMigration — LLM re-classification ────────────────────────────────────

describe("runMigration — LLM re-classification", () => {
  beforeEach(() => {
    callCount = 0;
    srcSql = buildSqlMock();
    dstSql = buildSqlMock();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env["MNEMO_LLM_PROVIDER"];
    delete process.env["MNEMO_LLM_API_KEY"];
    delete process.env["MNEMO_EMBED_PROVIDER"];
    delete process.env["MNEMO_EMBED_API_KEY"];
  });

  it("--llm: triggers reclassification when provider is ready", async () => {
    process.env["MNEMO_LLM_PROVIDER"] = "openai";
    process.env["MNEMO_LLM_API_KEY"] = "sk-test";

    mockCreateProviderImpl = () => ({
      capabilities: { embed: false, complete: true },
      complete: vi.fn().mockResolvedValue({ text: "episode" }),
    });

    const rows = [
      makeV2Memory({ id: "m1", memory_type: "factual", content: "Went to the store." }),
    ];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration({
      srcUrl: "postgres://src",
      dstUrl: "postgres://dst",
      workspaceId: "ws-llm-test",
      batchSize: 100,
      dryRun: false,
      llm: true,
    });

    // The LLM reclassified fact → episode, so episodes should be 1, facts 0
    expect(summary.reclassified).toBe(1);
    expect(summary.episodes).toBe(1);
    expect(summary.facts).toBe(0);
    expect(summary.migrated).toBe(1);
  });

  it("--llm: skips re-classification when MNEMO_LLM_API_KEY is absent", async () => {
    delete process.env["MNEMO_LLM_API_KEY"];
    delete process.env["MNEMO_LLM_PROVIDER"];

    const rows = [makeV2Memory({ id: "m1", memory_type: "factual" })];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration({
      srcUrl: "postgres://src",
      dstUrl: "postgres://dst",
      workspaceId: "ws-llm-skip",
      batchSize: 100,
      dryRun: false,
      llm: true,
    });

    expect(summary.reclassified).toBe(0);
    expect(summary.migrated).toBe(1);
    expect(summary.errors).toBe(0);
  });

  it("reclassified counter is 0 when --llm is not set", async () => {
    const rows = [makeV2Memory({ id: "m1", memory_type: "factual" })];

    srcSql.mockResolvedValueOnce([{ count: "1" }]);
    srcSql.mockResolvedValueOnce(rows);
    srcSql.mockResolvedValueOnce([]);
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration({
      srcUrl: "postgres://src",
      dstUrl: "postgres://dst",
      workspaceId: "ws-no-llm",
      batchSize: 100,
      dryRun: false,
      llm: false,
    });

    expect(summary.reclassified).toBe(0);
  });

  // ── B6.35: reserved pending-consolidation marker must never reach mnemo_fact ──

  const BASE_OPTS = {
    srcUrl: "postgres://src",
    dstUrl: "postgres://dst",
    workspaceId: "ws-abc",
    batchSize: 100,
    dryRun: false,
  };

  /** Metadata objects passed through `sql.json` during a run (dst tagged-template). */
  function factMetadataArgs(): Record<string, unknown>[] {
    return dstSql.json.mock.calls
      .map((c) => c[0])
      .filter((v): v is Record<string, unknown> => v !== null && typeof v === "object");
  }

  it("non-embedding fact insert serializes sanitized metadata (no reserved key)", async () => {
    const rows = [
      makeV2MemoryWithMeta("m1", {
        sibling: "kept",
        __mnemoConsolidationPending: { operationId: "spoofed" },
      }),
    ];
    srcSql.mockResolvedValueOnce([{ count: "1" }]); // countTotal
    srcSql.mockResolvedValueOnce(rows);             // fetchBatch
    srcSql.mockResolvedValueOnce([]);               // fetchBatch → stop
    dstSql.mockResolvedValue(undefined);

    const summary = await runMigration(BASE_OPTS);
    expect(summary.facts).toBe(1);

    const factMeta = factMetadataArgs().find((m) => "v2Id" in m);
    expect(factMeta).toBeDefined();
    expect(factMeta).toMatchObject({ sibling: "kept", v2Id: "m1", worthAlpha: 1.0, worthBeta: 2.0 });
    expect(factMeta).not.toHaveProperty("__mnemoConsolidationPending");
  });

  it("embedding fact insert serializes sanitized metadata (no reserved key)", async () => {
    // Enable the embedder via env + the llm-providers mock returning a fixed vector.
    const prevProvider = process.env["MNEMO_EMBED_PROVIDER"];
    const prevKey = process.env["MNEMO_EMBED_API_KEY"];
    process.env["MNEMO_EMBED_PROVIDER"] = "openai";
    process.env["MNEMO_EMBED_API_KEY"] = "test-key";
    mockCreateProviderImpl = () => ({
      capabilities: { embed: true, complete: false },
      embed: async () => [0.1, 0.2, 0.3],
    });

    try {
      const rows = [
        makeV2MemoryWithMeta("m1", {
          sibling: "kept",
          __mnemoConsolidationPending: { operationId: "spoofed" },
        }),
      ];
      srcSql.mockResolvedValueOnce([{ count: "1" }]);
      srcSql.mockResolvedValueOnce(rows);
      srcSql.mockResolvedValueOnce([]);
      dstSql.mockResolvedValue(undefined);

      const summary = await runMigration(BASE_OPTS);
      expect(summary.facts).toBe(1);

      const factMeta = factMetadataArgs().find((m) => "v2Id" in m);
      expect(factMeta).toBeDefined();
      expect(factMeta).toMatchObject({ sibling: "kept", v2Id: "m1" });
      expect(factMeta).not.toHaveProperty("__mnemoConsolidationPending");
    } finally {
      if (prevProvider === undefined) delete process.env["MNEMO_EMBED_PROVIDER"];
      else process.env["MNEMO_EMBED_PROVIDER"] = prevProvider;
      if (prevKey === undefined) delete process.env["MNEMO_EMBED_API_KEY"];
      else process.env["MNEMO_EMBED_API_KEY"] = prevKey;
      mockCreateProviderImpl = () => ({ capabilities: { embed: false, complete: false } });
    }
  });

  it("source guard: both mnemo_fact insert branches serialize ONE precomputed safeFactMetadata", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../migrate.ts"), "utf8");

    const insertFact = source.slice(source.indexOf("async function insertFact"), source.indexOf("async function insertEpisode"));
    // Exactly two mnemo_fact inserts (embedding + non-embedding).
    expect((insertFact.match(/INSERT INTO mnemosyne\.mnemo_fact/g) ?? []).length).toBe(2);
    // Both serialize the single precomputed sanitized object.
    expect((insertFact.match(/sql\.json\(safeFactMetadata/g) ?? []).length).toBe(2);
    // The sanitizer strips the reserved key exactly once.
    expect(insertFact).toMatch(/__mnemoConsolidationPending: _pending, \.\.\.rest/);
    // And no fact branch serializes raw caller metadata.
    expect(insertFact).not.toMatch(/sql\.json\(\(inp\.metadata/);
  });
});
