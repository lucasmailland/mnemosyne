import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgVectorAdapter } from "../PgVectorAdapter.js";

// ─── postgres.js mock ─────────────────────────────────────────────────────────
//
// The PgVectorAdapter calls sql() in two modes:
//   1. Identifier mode:  this.sql('table_name')  → returns a fragment string
//   2. Template mode:    this.sql`SELECT ...`     → returns a Promise<Row[]>
//
// We distinguish the two by checking whether the first argument is an Array
// with a `.raw` property (which TemplateStringsArray always has).
//
// mockTemplateQuery is what tests assert on; mockSqlFn delegates to it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTemplateQuery = vi.fn() as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTxTemplateQuery = vi.fn() as ReturnType<typeof vi.fn>;
/** Every standalone `tx.unsafe("SET LOCAL ...")` string, in call order. */
const txUnsafeCalls: string[] = [];

function isTemplateStringsArray(v: unknown): v is TemplateStringsArray {
  return Array.isArray(v) && "raw" in (v as object);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSqlFn = Object.assign(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.fn((...args: any[]) => {
    if (isTemplateStringsArray(args[0])) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
      return (mockTemplateQuery as (...a: unknown[]) => unknown)(...args);
    }
    return `"${String(args[0])}"`;
  }),
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    begin: vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = Object.assign(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (...args: any[]) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
          if (isTemplateStringsArray(args[0]))
            return (mockTxTemplateQuery as (...a: unknown[]) => unknown)(...args);
          return `"${String(args[0])}"`;
        },
        // PgVectorAdapter calls tx.unsafe() two ways:
        //   1. Standalone + awaited, e.g. `await tx.unsafe('SET LOCAL ...')`
        //      (GUC params can't use parameterized placeholders in Postgres).
        //   2. Nested inside a tagged template, e.g.
        //      `${tx.unsafe(this.halfvecCastType)}` — real postgres.js splices
        //      this in as a raw-SQL fragment (type modifiers like `halfvec(N)`
        //      can't be bound as query parameters either). We return a
        //      resolved Promise (so case 1 still awaits fine) tagged with the
        //      raw string via a `__rawSql` property, so case 2 lets tests
        //      assert on exactly what raw SQL text was spliced in — mirroring
        //      how a real postgres.js Query object is both thenable and
        //      carries its own `.strings`.
        {
          unsafe: vi.fn((str: string) => {
            txUnsafeCalls.push(str);
            const p = Promise.resolve(undefined);
            return Object.assign(p, { __rawSql: str });
          }),
        }
      );
      return cb(tx);
    }),
    end: vi.fn().mockResolvedValue(undefined),
  }
);

vi.mock("postgres", () => ({
  default: vi.fn(() => mockSqlFn),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeVector(fill = 0.1): Float32Array {
  return new Float32Array(1536).fill(fill);
}

function makeAdapter(
  overrides: Partial<{
    efSearch: number;
    dimensions: number;
    iterativeScan: boolean;
    maxScanTuples: number;
  }> = {}
): PgVectorAdapter {
  return new PgVectorAdapter({
    connectionString: "postgres://test:test@localhost:5432/test",
    ...overrides,
  });
}

/**
 * Extracts every raw-SQL fragment string spliced into a captured
 * `mockTxTemplateQuery` call via `tx.unsafe(...)` — see the `unsafe` mock
 * above. Used to assert the search query casts to the expected
 * `halfvec(N)` type modifier, and that the `vector_dims(...) = N` comparand
 * is spliced as a literal (`"N"`) rather than bound as a parameter.
 */
function rawSqlFragments(call: unknown[] | undefined): string[] {
  if (!call) return [];
  return call
    .filter(
      (v): v is { __rawSql: string } => typeof v === "object" && v !== null && "__rawSql" in v
    )
    .map((v) => v.__rawSql);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PgVectorAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txUnsafeCalls.length = 0;
    mockTemplateQuery.mockReset();
    mockTemplateQuery.mockResolvedValue([{ v: "0.8.0" }]);
  });

  // ── Constructor / metadata ───────────────────────────────────────────────────

  it("exposes correct id and dimensions", () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe("pgvector");
    expect(adapter.dimensions).toBe(1536);
  });

  // ── search() ────────────────────────────────────────────────────────────────

  it("search: throws on wrong dimension", async () => {
    await expect(
      makeAdapter().search({ workspaceId: "ws1", vector: new Float32Array(512), limit: 10 })
    ).rejects.toThrow("Vector dimension mismatch");
  });

  it("search: returns mapped hits with correct shapes", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "fact_001", score: 0.9, primitive_kind: "preference", metadata: { x: 1 } },
        { id: "fact_002", score: 0.7, primitive_kind: null, metadata: null },
      ]);

    const hits = await makeAdapter({ efSearch: 200 }).search({
      workspaceId: "ws1",
      vector: makeVector(),
      limit: 5,
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ id: "fact_001", score: 0.9, primitiveKind: "preference" });
    expect(hits[0]!.metadata).toEqual({ x: 1 });
    // null primitive_kind → primitiveKind omitted
    expect(hits[1]).toMatchObject({ id: "fact_002", score: 0.7 });
    expect(hits[1]!.primitiveKind).toBeUndefined();
  });

  it("search: opens a transaction for ef_search isolation", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await makeAdapter().search({ workspaceId: "ws1", vector: makeVector(), limit: 10 });
    expect(mockSqlFn.begin).toHaveBeenCalledOnce();
  });

  it("search: sets the transaction-local workspace scope before querying", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await makeAdapter().search({ workspaceId: "ws1", vector: makeVector(), limit: 10 });

    expect(mockTxTemplateQuery).toHaveBeenCalledTimes(3);
    expect(mockTxTemplateQuery.mock.calls[1]?.[1]).toBe("ws1");
  });

  it("search: respects minSimilarity filter", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await makeAdapter().search({
      workspaceId: "ws1",
      vector: makeVector(),
      limit: 10,
      minSimilarity: 0.8,
    });
    expect(mockTxTemplateQuery).toHaveBeenCalledTimes(3);
  });

  // ── search(): dimension-typed casts (dimension-scoped HNSW indexes) ────────────

  it("search: casts to halfvec(1536) by default and splices the vector_dims comparand as a literal", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await makeAdapter().search({ workspaceId: "ws1", vector: makeVector(), limit: 10 });

    const searchCall = mockTxTemplateQuery.mock.calls[2] as unknown[];
    const [strings] = searchCall as [TemplateStringsArray, ...unknown[]];
    const queryText = strings.join(" ");

    expect(queryText).toContain("vector_dims");
    expect(queryText).toMatch(/public\.vector_dims/);
    // Both the cast type modifier AND the vector_dims(...) comparand are
    // spliced via tx.unsafe(...) fragments, not literal template text or a
    // bound parameter — assert on those directly. The comparand must be a
    // raw literal ("1536"), not a bound ${this.dimensions} value: under
    // plan_cache_mode=auto a bound comparand can't be proven against the
    // partial index's WHERE clause once Postgres switches to a generic plan
    // (see the constructor/search() comments), silently losing the index.
    const fragments = rawSqlFragments(searchCall);
    const castFragments = fragments.filter((f) => f === "halfvec(1536)");
    const dimsLiteralFragments = fragments.filter((f) => f === "1536");
    expect(castFragments.length).toBeGreaterThan(0);
    // One vector_dims(...) = <literal> comparand per query variant executed.
    expect(dimsLiteralFragments.length).toBe(1);
    // No fragment should be anything other than these two known shapes.
    // "" is the empty ownership clause (WP-3): no owner filter, no SQL.
    expect(fragments.every((f) => f === "halfvec(1536)" || f === "1536" || f === "")).toBe(true);
  });

  it("search: casts to halfvec(1024) and splices vector_dims=1024 as a literal when constructed with dimensions: 1024", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const adapter = makeAdapter({ dimensions: 1024 });
    expect(adapter.dimensions).toBe(1024);

    await adapter.search({
      workspaceId: "ws1",
      vector: new Float32Array(1024).fill(0.1),
      limit: 10,
    });

    const searchCall = mockTxTemplateQuery.mock.calls[2] as unknown[];
    const fragments = rawSqlFragments(searchCall);
    const castFragments = fragments.filter((f) => f === "halfvec(1024)");
    const dimsLiteralFragments = fragments.filter((f) => f === "1024");
    expect(castFragments.length).toBeGreaterThan(0);
    expect(dimsLiteralFragments.length).toBe(1);
    // "" is the empty ownership clause (WP-3): no owner filter, no SQL.
    expect(fragments.every((f) => f === "halfvec(1024)" || f === "1024" || f === "")).toBe(true);
  });

  it("search: kind-filtered variant also casts to the configured dimension and splices vector_dims as a literal", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await makeAdapter().search({
      workspaceId: "ws1",
      vector: makeVector(),
      limit: 10,
      filter: { primitiveKind: "preference" },
    });

    const searchCall = mockTxTemplateQuery.mock.calls[2] as unknown[];
    const [strings] = searchCall as [TemplateStringsArray, ...unknown[]];
    const queryText = strings.join(" ");

    expect(queryText).toContain("vector_dims");
    const fragments = rawSqlFragments(searchCall);
    const castFragments = fragments.filter((f) => f === "halfvec(1536)");
    const dimsLiteralFragments = fragments.filter((f) => f === "1536");
    expect(castFragments.length).toBeGreaterThan(0);
    expect(dimsLiteralFragments.length).toBe(1);
  });

  it("search: an ownership filter becomes a bound WHERE clause before LIMIT (WP-3, RECALL-6)", async () => {
    mockTemplateQuery.mockResolvedValue([{ v: "0.8.0" }]); // pgvector version
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }]) // pg_has_role
      .mockResolvedValueOnce([]) // set_config
      .mockReturnValueOnce(undefined) // the ownership fragment
      .mockResolvedValueOnce([]); // the search

    await makeAdapter().search({
      workspaceId: "ws1",
      vector: makeVector(),
      limit: 10,
      filter: { scopeOwner: "user:u1" },
    });

    const ownerCall = mockTxTemplateQuery.mock.calls[2] as unknown[];
    const [ownerStrings, ownerValue] = ownerCall as [TemplateStringsArray, unknown];
    expect(ownerStrings.join("?")).toBe("AND scope_owner = ?");
    expect(ownerValue).toBe("user:u1");
    const searchCall = mockTxTemplateQuery.mock.calls[3] as unknown[];
    expect((searchCall[0] as TemplateStringsArray).join(" ")).toContain("vector_dims");
  });

  // ── Q-2: iterative scan on every filtered vector query ────────────────────

  it("search: pgvector >= 0.8 enables strict_order iterative scan with a scan cap, before the query", async () => {
    mockTemplateQuery.mockResolvedValue([{ v: "0.8.1" }]);
    mockTxTemplateQuery.mockResolvedValue([{ m: true }]);
    await makeAdapter({ efSearch: 40 }).search({
      workspaceId: "ws1",
      vector: makeVector(),
      limit: 10,
    });
    expect(txUnsafeCalls).toContain("SET LOCAL hnsw.ef_search = 40");
    expect(txUnsafeCalls).toContain("SET LOCAL hnsw.iterative_scan = strict_order");
    expect(txUnsafeCalls).toContain("SET LOCAL hnsw.max_scan_tuples = 20000");
  });

  it("search: pgvector < 0.8 falls back to the largest ef_search and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockTemplateQuery.mockResolvedValue([{ v: "0.7.4" }]);
    mockTxTemplateQuery.mockResolvedValue([{ m: true }]);
    const adapter = makeAdapter();
    await adapter.search({ workspaceId: "ws1", vector: makeVector(), limit: 10 });
    await adapter.search({ workspaceId: "ws1", vector: makeVector(), limit: 10 });
    expect(txUnsafeCalls.some((c) => c.includes("iterative_scan"))).toBe(false);
    expect(txUnsafeCalls.filter((c) => c === "SET LOCAL hnsw.ef_search = 1000")).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("pgvector 0.7.4");
    warn.mockRestore();
  });

  it("search: detects the pgvector version once, not per query", async () => {
    mockTemplateQuery.mockResolvedValue([{ v: "0.8.0" }]);
    mockTxTemplateQuery.mockResolvedValue([{ m: true }]);
    const adapter = makeAdapter();
    await adapter.search({ workspaceId: "ws1", vector: makeVector(), limit: 10 });
    await adapter.search({ workspaceId: "ws1", vector: makeVector(), limit: 10 });
    expect(mockTemplateQuery).toHaveBeenCalledTimes(1);
  });

  it("search: iterativeScan: false forces the fallback without asking the server", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockTxTemplateQuery.mockResolvedValue([{ m: true }]);
    await makeAdapter({ iterativeScan: false }).search({
      workspaceId: "ws1",
      vector: makeVector(),
      limit: 10,
    });
    expect(mockTemplateQuery).not.toHaveBeenCalled();
    expect(txUnsafeCalls.some((c) => c.includes("iterative_scan"))).toBe(false);
    warn.mockRestore();
  });

  it("constructor: rejects non-integer dimensions", () => {
    expect(() => makeAdapter({ dimensions: 1536.5 })).toThrow(
      "dimensions must be a positive integer"
    );
  });

  it("constructor: rejects non-positive dimensions", () => {
    expect(() => makeAdapter({ dimensions: 0 })).toThrow("dimensions must be a positive integer");
    expect(() => makeAdapter({ dimensions: -1 })).toThrow("dimensions must be a positive integer");
  });

  it("constructor: rejects dimensions above the pgvector halfvec ceiling", () => {
    expect(() => makeAdapter({ dimensions: 16_001 })).toThrow(
      "dimensions must be a positive integer <= 16000"
    );
    // A wildly out-of-range value must fail loudly at construction, not as a
    // confusing SQL syntax error at query time.
    expect(() => makeAdapter({ dimensions: 1e21 })).toThrow(
      "dimensions must be a positive integer <= 16000"
    );
  });

  it("constructor: accepts dimensions exactly at the ceiling", () => {
    expect(() => makeAdapter({ dimensions: 16_000 })).not.toThrow();
  });

  it("constructor: rejects invalid efSearch", () => {
    expect(() => makeAdapter({ efSearch: 0 })).toThrow("efSearch must be a positive integer");
    expect(() => makeAdapter({ efSearch: -5 })).toThrow("efSearch must be a positive integer");
    expect(() => makeAdapter({ efSearch: 12.5 })).toThrow("efSearch must be a positive integer");
    expect(() => makeAdapter({ efSearch: Number.NaN })).toThrow(
      "efSearch must be a positive integer"
    );
  });

  it("constructor: accepts a valid efSearch override", () => {
    expect(() => makeAdapter({ efSearch: 200 })).not.toThrow();
  });

  // ── upsert() ─────────────────────────────────────────────────────────────────

  it("upsert: throws on wrong dimension", async () => {
    await expect(makeAdapter().upsert("fact_001", new Float32Array(512))).rejects.toThrow(
      "Vector dimension mismatch"
    );
  });

  it("upsert: without metadata executes an UPDATE", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ count: 1 });
    await makeAdapter().upsert("fact_001", makeVector(), { workspaceId: "ws1" });
    expect(mockSqlFn.begin).toHaveBeenCalledOnce();
  });

  it("upsert: with model metadata also executes UPDATE (embedding_model path)", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ count: 1 });
    await makeAdapter().upsert("fact_001", makeVector(), {
      model: "text-embedding-3-small",
      workspaceId: "ws1",
    });
    expect(mockSqlFn.begin).toHaveBeenCalledOnce();
  });

  // ── delete() ────────────────────────────────────────────────────────────────

  it("delete: nullifies embedding for the given id", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ count: 1 });
    await makeAdapter().delete("fact_001", "ws1");
    expect(mockSqlFn.begin).toHaveBeenCalledOnce();
  });

  // ── deleteByFilter() ─────────────────────────────────────────────────────────

  it("deleteByFilter: returns 0 with empty filter (no-op)", async () => {
    const count = await makeAdapter().deleteByFilter({});
    expect(count).toBe(0);
    expect(mockTemplateQuery).not.toHaveBeenCalled();
  });

  it("deleteByFilter: returns 0 for empty ids array (no-op)", async () => {
    const count = await makeAdapter().deleteByFilter({ ids: [] });
    expect(count).toBe(0);
    expect(mockTemplateQuery).not.toHaveBeenCalled();
  });

  it("deleteByFilter: filters by workspaceId only", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ count: 42 });
    const count = await makeAdapter().deleteByFilter({ workspaceId: "ws1" });
    expect(count).toBe(42);
    expect(mockSqlFn.begin).toHaveBeenCalledOnce();
  });

  it("deleteByFilter: rejects unscoped ids", async () => {
    const count = await makeAdapter().deleteByFilter({ ids: ["a", "b", "c"] });
    expect(count).toBe(0);
    expect(mockTemplateQuery).not.toHaveBeenCalled();
  });

  it("deleteByFilter: combines workspaceId + ids", async () => {
    mockTxTemplateQuery
      .mockResolvedValueOnce([{ m: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ count: 2 });
    const count = await makeAdapter().deleteByFilter({ workspaceId: "ws1", ids: ["a", "b"] });
    expect(count).toBe(2);
    expect(mockSqlFn.begin).toHaveBeenCalledOnce();
  });

  // ── healthCheck() ────────────────────────────────────────────────────────────

  it("healthCheck: returns ok when the table, privilege and extension are present", async () => {
    mockTemplateQuery.mockResolvedValueOnce([
      { has_table: true, can_read: true, has_vector: true },
    ]);
    const result = await makeAdapter().healthCheck();
    expect(result.status).toBe("ok");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // CHAOS-9: the probe must not read tenant rows (the RLS policy throws on an
  // empty workspace GUC left behind by an earlier SET LOCAL on the connection).
  it("healthCheck: probes the catalog, never rows of the RLS-protected table", async () => {
    mockTemplateQuery.mockResolvedValueOnce([
      { has_table: true, can_read: true, has_vector: true },
    ]);
    await makeAdapter().healthCheck();
    const strings = (mockTemplateQuery.mock.calls.at(-1)?.[0] as TemplateStringsArray).join("?");
    expect(strings).toContain("to_regclass");
    expect(strings).not.toMatch(/FROM\s+\?/);
  });

  it.each([
    [{ has_table: false, can_read: null, has_vector: true }, "not found"],
    [{ has_table: true, can_read: false, has_vector: true }, "privilege"],
    [{ has_table: true, can_read: true, has_vector: false }, "pgvector"],
  ])("healthCheck: returns down when a requirement is missing (%o)", async (row, detail) => {
    mockTemplateQuery.mockResolvedValueOnce([row]);
    const result = await makeAdapter().healthCheck();
    expect(result.status).toBe("down");
    expect(result.detail).toContain(detail);
  });

  it("healthCheck: returns down when query throws", async () => {
    mockTemplateQuery.mockRejectedValueOnce(new Error("connection refused"));
    const result = await makeAdapter().healthCheck();
    expect(result.status).toBe("down");
    expect(result.detail).toContain("connection refused");
  });

  // ── close() ──────────────────────────────────────────────────────────────────

  it("close: calls sql.end()", async () => {
    await makeAdapter().close();
    expect(mockSqlFn.end).toHaveBeenCalledOnce();
  });
});
