// PgVectorAdapter — HNSW cosine search via pgvector halfvec
// Implements the VectorAdapter port against mnemo_fact.embedding, an
// unconstrained (dimensionless) halfvec column as of migration 0009 — this
// adapter's `dimensions` config (default 1536) is what pins it to a single
// dimension at the application layer.
// This adapter owns a separate postgres.js pool, so every workspace operation
// establishes its own transaction-local role and GUC before touching mnemo_fact.

import postgres from "postgres";
import { pgSessionTimeoutParams, resolvePgSessionTimeouts } from "@mnemo-ai/types";
import type {
  VectorAdapter,
  VectorSearchInput,
  VectorSearchHit,
  VectorFilter,
  HealthStatus,
} from "@mnemo-ai/types";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface PgVectorAdapterConfig {
  connectionString: string;
  /** Configured vector dimension for the active space. Default: 1536 */
  dimensions?: number;
  /** HNSW ef_search parameter at query time. Default: 100 */
  efSearch?: number;
  /** Table that stores embeddings. Default: 'mnemo_fact' */
  table?: string;
  /** Primary key column. Default: 'id' */
  idColumn?: string;
  /** halfvec column. Default: 'embedding' */
  embeddingColumn?: string;
  /** Workspace isolation column. Default: 'workspace_id' */
  workspaceColumn?: string;
  /** Give up connecting after this many seconds. Default: 10. */
  connectTimeoutSeconds?: number;
  /**
   * Q-2: use `hnsw.iterative_scan` (pgvector >= 0.8) so the workspace / owner /
   * kind filters, applied after the index returns its candidates, cannot
   * starve the result. `false` forces the pre-0.8 fallback (a raised
   * `ef_search`). Default: true when the installed pgvector supports it.
   */
  iterativeScan?: boolean;
  /** `hnsw.max_scan_tuples` for iterative scans. Default: 20000 (pgvector's own). */
  maxScanTuples?: number;
}

/** Highest `hnsw.ef_search` pgvector accepts; used by the pre-0.8 fallback. */
const MAX_EF_SEARCH = 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** `process.env`, read structurally: this package builds without Node typings. */
function runtimeEnv(): Readonly<Record<string, string | undefined>> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/**
 * Converts a Float32Array to the `[a,b,c,...]` string literal that Postgres
 * expects for halfvec/vector casts.
 */
function toHalfvec(vector: Float32Array): string {
  return `[${Array.from(vector).join(",")}]`;
}

/**
 * Extracts the primitive-kind scope from an open VectorSearchInput.filter.
 * Reads `primitiveKind` (canonical, matching VectorFilter) then `kind` (alias).
 * Returns the string to match against the `kind` column, or undefined when no
 * usable kind scope is present. Non-string values are ignored rather than
 * coerced, so a malformed filter degrades to an unfiltered search instead of
 * throwing or silently matching nothing.
 */
function readKindFilter(filter: Record<string, unknown> | undefined): string | undefined {
  if (!filter) return undefined;
  const raw = filter.primitiveKind ?? filter.kind;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * WP-3 (RECALL-6): the ownership label to restrict a search to, from
 * `filter.scopeOwner`. Applied in SQL before LIMIT — post-filtering a
 * truncated window starves a personal-only recall. Non-strings are ignored.
 */
function readOwnerFilter(filter: Record<string, unknown> | undefined): string | undefined {
  const raw = filter?.scopeOwner;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

async function setWorkspaceContext(
  tx: postgres.TransactionSql,
  workspaceId: string
): Promise<void> {
  const memberRows = await tx<Array<{ m: boolean }>>`
    SELECT pg_has_role(current_user, 'app_user', 'member') AS m
  `;
  if (memberRows[0]?.m) {
    await tx.unsafe("SET LOCAL ROLE app_user");
    await tx.unsafe("SET LOCAL search_path TO mnemosyne, public");
  } else {
    const roleRows = await tx<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    const role = roleRows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error("[SECURITY] Unsafe database role cannot enforce workspace RLS");
    }
  }
  await tx`SELECT set_config('mnemosyne.workspace_id', ${workspaceId}, true)`;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class PgVectorAdapter implements VectorAdapter {
  readonly id = "pgvector";
  readonly dimensions: number;

  private readonly sql: postgres.Sql;
  private readonly efSearch: number;
  private readonly iterativeScanWanted: boolean;
  private readonly maxScanTuples: number;
  /** Resolved once, on first use (or `init()`): does this server have iterative scans? */
  private iterativeScanSupport: Promise<boolean> | undefined;
  private readonly table: string;
  private readonly idColumn: string;
  private readonly embeddingColumn: string;
  private readonly workspaceColumn: string;
  /**
   * `halfvec(N)` type-modifier text, precomputed once from the
   * constructor-validated `dimensions` integer. Postgres type modifiers
   * (the `(N)` in `halfvec(N)`) cannot be bound as query parameters —
   * `halfvec($1)` is a syntax error — so this raw string is spliced into
   * search queries via `tx.unsafe(...)` nested inside a tagged template
   * (see `search()` below). Never built from request input.
   */
  private readonly halfvecCastType: string;
  /**
   * `this.dimensions` as a raw-SQL literal string, spliced the same way as
   * `halfvecCastType` — see that field's doc, and the `vector_dims(...)`
   * predicate in `search()` for why the comparand needs this treatment too
   * (not just the type-modifier casts).
   */
  private readonly dimensionsLiteral: string;

  /** pgvector's practical halfvec dimension ceiling. */
  private static readonly MAX_DIMENSIONS = 16_000;

  constructor(config: PgVectorAdapterConfig) {
    this.sql = postgres(config.connectionString, {
      max: 10,
      // CHAOS-10: postgres.js waits 30 s by default for an unreachable host.
      connect_timeout: config.connectTimeoutSeconds ?? 10,
      connection: {
        // Tables live in mnemosyne.* schema; set search_path so unqualified names resolve
        search_path: "mnemosyne,public",
        // PG-TIMEOUTS: same statement/lock/idle-in-transaction limits as the
        // storage pools (MNEMO_PG_*_TIMEOUT_MS). Throws on an invalid value.
        ...pgSessionTimeoutParams(resolvePgSessionTimeouts(runtimeEnv())),
      },
    });
    const dimensions = Number(config.dimensions ?? 1536);
    if (
      !Number.isSafeInteger(dimensions) ||
      dimensions <= 0 ||
      dimensions > PgVectorAdapter.MAX_DIMENSIONS
    ) {
      throw new Error(
        `PgVectorAdapter: dimensions must be a positive integer <= ${PgVectorAdapter.MAX_DIMENSIONS}, got ${config.dimensions}`
      );
    }
    this.dimensions = dimensions;
    this.halfvecCastType = `halfvec(${this.dimensions})`;
    this.dimensionsLiteral = String(this.dimensions);

    const efSearch = Number(config.efSearch ?? 100);
    if (!Number.isSafeInteger(efSearch) || efSearch <= 0) {
      throw new Error(
        `PgVectorAdapter: efSearch must be a positive integer, got ${config.efSearch}`
      );
    }
    this.efSearch = efSearch;
    this.iterativeScanWanted = config.iterativeScan ?? true;
    const maxScanTuples = Number(config.maxScanTuples ?? 20_000);
    if (!Number.isSafeInteger(maxScanTuples) || maxScanTuples <= 0) {
      throw new Error(
        `PgVectorAdapter: maxScanTuples must be a positive integer, got ${config.maxScanTuples}`
      );
    }
    this.maxScanTuples = maxScanTuples;

    this.table = config.table ?? "mnemo_fact";
    this.idColumn = config.idColumn ?? "id";
    this.embeddingColumn = config.embeddingColumn ?? "embedding";
    this.workspaceColumn = config.workspaceColumn ?? "workspace_id";
  }

  // ── iterative scan capability ──────────────────────────────────────────────

  /**
   * Q-2: detects the installed pgvector once and caches the answer. Call it at
   * boot to log the fallback early; `search()` calls it lazily otherwise.
   * Iterative scans need pgvector >= 0.8. Below that (or when disabled by
   * config, or when the version cannot be read) filtered searches fall back to
   * `ef_search = 1000`, which only narrows the starvation window: production
   * should run pgvector >= 0.8.
   */
  init(): Promise<boolean> {
    this.iterativeScanSupport ??= this.detectIterativeScan();
    return this.iterativeScanSupport;
  }

  private async detectIterativeScan(): Promise<boolean> {
    if (!this.iterativeScanWanted) {
      console.warn(
        "[adapter-vector] hnsw.iterative_scan disabled by config; using ef_search fallback"
      );
      return false;
    }
    let version: string | null = null;
    try {
      const rows = await this.sql<Array<{ v: string | null }>>`
        SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'
      `;
      version = rows[0]?.v ?? null;
    } catch {
      // fall through: unknown version
    }
    const [major = 0, minor = 0] = (version ?? "0.0").split(".").map(Number);
    if (major > 0 || minor >= 8) return true;
    console.warn(
      `[adapter-vector] pgvector ${version ?? "unknown"} has no hnsw.iterative_scan (needs >= 0.8): ` +
        `workspace-filtered vector searches fall back to hnsw.ef_search=${MAX_EF_SEARCH} and can still ` +
        "return fewer than topK hits when other workspaces are denser. Upgrade pgvector to >= 0.8."
    );
    return false;
  }

  // ── search ─────────────────────────────────────────────────────────────────

  async search(input: VectorSearchInput): Promise<VectorSearchHit[]> {
    if (input.vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${input.vector.length}`
      );
    }
    const halfvecLiteral = toHalfvec(input.vector);
    const minSim = input.minSimilarity ?? 0;

    // VectorSearchInput.filter is an open record (ports.ts). We honour the
    // primitive-kind scope so a caller can restrict a search to a single kind
    // (e.g. filter:{ kind:"episode" } for delta-episode formation). The
    // canonical field is `primitiveKind` (VectorFilter); `kind` is accepted as
    // an ergonomic alias. Both map to the `kind` column projected as
    // primitive_kind below. Any other filter keys are ignored — workspaceId and
    // minSimilarity remain dedicated inputs and are NOT read from `filter`.
    const kindFilter = readKindFilter(input.filter);
    const ownerFilter = readOwnerFilter(input.filter);
    const iterative = await this.init();

    // We run SET LOCAL inside an explicit transaction so the hnsw.ef_search
    // GUC applies to this query only and is automatically rolled back at the
    // end of the begin() block.
    //
    // The kind-scoped and unscoped variants are written as two complete queries
    // (rather than a spliced-in fragment) mirroring deleteByFilter below — this
    // keeps each a single flat postgres.js template and emits a query identical
    // to the pre-filter behaviour when no kind scope is supplied.
    const rows = await this.sql.begin<
      Array<{
        id: string;
        score: number;
        primitive_kind: string | null;
        metadata: unknown;
      }>
    >(async (tx) => {
      // GUC settings don't accept parameterized values ($1, $2…) in PostgreSQL.
      // efSearch is a constructor-time integer — safe to inline.
      // Q-2: the HNSW index is global and every row is then filtered by
      // workspace (RLS + the explicit predicate), so a workspace that is not
      // the densest near the query would get fewer than LIMIT rows, or none.
      // strict_order keeps scanning past ef_search until LIMIT survivors are
      // found (bounded by max_scan_tuples) and keeps ORDER BY exact; the
      // faster relaxed_order may return slightly out-of-order rows. Before
      // pgvector 0.8 the best available lever is the largest ef_search.
      if (iterative) {
        await tx.unsafe(`SET LOCAL hnsw.ef_search = ${this.efSearch}`);
        await tx.unsafe("SET LOCAL hnsw.iterative_scan = strict_order");
        await tx.unsafe(`SET LOCAL hnsw.max_scan_tuples = ${this.maxScanTuples}`);
      } else {
        await tx.unsafe(`SET LOCAL hnsw.ef_search = ${Math.max(this.efSearch, MAX_EF_SEARCH)}`);
      }
      await setWorkspaceContext(tx, input.workspaceId);
      // WP-3 (RECALL-6): ownership is a WHERE clause before LIMIT, built once
      // here (no nested template inside the query text below).
      const ownerClause = ownerFilter ? tx`AND scope_owner = ${ownerFilter}` : tx.unsafe("");

      // postgres.js doesn't support raw SQL identifiers in typed template
      // literals for column/table names directly, so we use sql() helper for
      // identifiers and unsafe() for the halfvec cast expression.
      //
      // Search-side casts are dimension-typed (`::halfvec(N)`, not the bare
      // `::halfvec` the write side uses) so the expression matches migration
      // 0010's partial HNSW indexes
      // (idx_mnemo_fact_embedding_hnsw_1536 / _1024), which are defined on
      // `(embedding::halfvec(N))`. The `vector_dims(embedding) = N` predicate
      // matches the indexes' partial-index WHERE clause, which is required
      // (in addition to the expression match) for the planner to consider
      // them. Side effect worth knowing when debugging "recall can't see
      // this fact": this predicate also silently filters OUT any row whose
      // embedding is a different dimension than this adapter instance is
      // configured for — previously (dimensionless `<=>`) a mixed-dimension
      // comparison instead raised a hard "different halfvec dimensions"
      // runtime error, so a caller misconfigured for the wrong dimension now
      // gets an empty/partial result set rather than a loud failure.
      // `tx.unsafe(this.halfvecCastType)` nests a raw-SQL fragment for
      // just the `halfvec(N)` type modifier — type modifiers can't be bound
      // as query parameters ($1) — using the same fragment-splicing
      // mechanism postgres.js itself relies on internally; `this.dimensions`
      // is a constructor-validated integer, never caller/request input.
      // The `vector_dims(embedding) = N` comparand is spliced the same way
      // (`tx.unsafe(this.dimensionsLiteral)`, not bound as `${this.dimensions}`)
      // — not because it's a type modifier, but because postgres.js prepares
      // statements, and under plan_cache_mode=auto Postgres may switch a
      // repeatedly-executed prepared statement to a generic plan after ~5
      // executions. A generic plan cannot prove a parameterized comparand
      // against the partial index's WHERE clause, so a bound `= $N` here
      // would silently regress to a sequential scan after the query had run
      // a few times — defeating the entire point of these casts. A spliced
      // literal is visible to the planner on every plan, generic or custom.
      // Write-side casts (upsert(), below) intentionally stay dimensionless
      // `::halfvec` so writes never reject during a dimension transition.
      if (kindFilter !== undefined) {
        return tx`
          SELECT
            ${tx(this.idColumn)} AS id,
            (1 - ((${tx(this.embeddingColumn)}::${tx.unsafe(this.halfvecCastType)}) <=> ${halfvecLiteral}::${tx.unsafe(this.halfvecCastType)}))::float8 AS score,
            kind AS primitive_kind,
            metadata
          FROM ${tx(this.table)}
          WHERE ${tx(this.workspaceColumn)} = ${input.workspaceId}
            AND ${tx(this.embeddingColumn)} IS NOT NULL
            AND (embedding_stale IS NULL OR embedding_stale = false)
            AND kind = ${kindFilter}
            ${ownerClause}
            AND public.vector_dims(${tx(this.embeddingColumn)}) = ${tx.unsafe(this.dimensionsLiteral)}
            AND (1 - ((${tx(this.embeddingColumn)}::${tx.unsafe(this.halfvecCastType)}) <=> ${halfvecLiteral}::${tx.unsafe(this.halfvecCastType)})) >= ${minSim}
          ORDER BY (${tx(this.embeddingColumn)}::${tx.unsafe(this.halfvecCastType)}) <=> ${halfvecLiteral}::${tx.unsafe(this.halfvecCastType)}
          LIMIT ${input.limit}
        `;
      }
      return tx`
        SELECT
          ${tx(this.idColumn)} AS id,
          (1 - ((${tx(this.embeddingColumn)}::${tx.unsafe(this.halfvecCastType)}) <=> ${halfvecLiteral}::${tx.unsafe(this.halfvecCastType)}))::float8 AS score,
          kind AS primitive_kind,
          metadata
        FROM ${tx(this.table)}
        WHERE ${tx(this.workspaceColumn)} = ${input.workspaceId}
          AND ${tx(this.embeddingColumn)} IS NOT NULL
          AND (embedding_stale IS NULL OR embedding_stale = false)
          ${ownerClause}
          AND public.vector_dims(${tx(this.embeddingColumn)}) = ${tx.unsafe(this.dimensionsLiteral)}
          AND (1 - ((${tx(this.embeddingColumn)}::${tx.unsafe(this.halfvecCastType)}) <=> ${halfvecLiteral}::${tx.unsafe(this.halfvecCastType)})) >= ${minSim}
        ORDER BY (${tx(this.embeddingColumn)}::${tx.unsafe(this.halfvecCastType)}) <=> ${halfvecLiteral}::${tx.unsafe(this.halfvecCastType)}
        LIMIT ${input.limit}
      `;
    });

    return rows.map((row) => {
      const hit: VectorSearchHit = {
        id: row.id,
        score: row.score,
      };
      if (row.primitive_kind != null) {
        hit.primitiveKind = row.primitive_kind;
      }
      if (row.metadata != null) {
        hit.metadata = row.metadata as Record<string, unknown>;
      }
      return hit;
    });
  }

  // ── upsert ─────────────────────────────────────────────────────────────────

  async upsert(
    id: string,
    vector: Float32Array,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
      );
    }
    const halfvecLiteral = toHalfvec(vector);
    const revision = metadata?.revision == null ? null : Number(metadata.revision);
    const workspaceId = metadata?.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new Error("PgVectorAdapter.upsert requires metadata.workspaceId");
    }

    // PRIM-4 — both branches are fenced on the row still being open. A job
    // that arrives after its fact was forgotten must not put a vector back on
    // a closed row; the restore enqueues its own, revision-tagged job.
    await this.sql.begin(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      if (metadata?.model != null) {
        await tx`
          UPDATE ${tx(this.table)}
          SET
            ${tx(this.embeddingColumn)} = ${halfvecLiteral}::halfvec,
            embedding_model = ${metadata.model as string},
            embedding_stale = false
          WHERE ${tx(this.idColumn)} = ${id}
            AND ${tx(this.workspaceColumn)} = ${workspaceId}
            AND (${revision}::integer IS NULL OR revision_count = ${revision})
            AND valid_to IS NULL
            AND status = 'active'
        `;
      } else {
        await tx`
          UPDATE ${tx(this.table)}
          SET
            ${tx(this.embeddingColumn)} = ${halfvecLiteral}::halfvec,
            embedding_stale = false
          WHERE ${tx(this.idColumn)} = ${id}
            AND ${tx(this.workspaceColumn)} = ${workspaceId}
            AND (${revision}::integer IS NULL OR revision_count = ${revision})
            AND valid_to IS NULL
            AND status = 'active'
        `;
      }
    });
  }

  // ── delete ─────────────────────────────────────────────────────────────────

  async delete(id: string, workspaceId: string): Promise<void> {
    // PRIM-4 — only a CLOSED row loses its vector. Every producer of
    // `vector_delete` closes (or removes) the fact first, so this changes
    // nothing for them; what it stops is a forget's delete, processed after a
    // restore, wiping the vector the restore just paid to rebuild.
    await this.sql.begin(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      await tx`
        UPDATE ${tx(this.table)}
        SET ${tx(this.embeddingColumn)} = NULL
        WHERE ${tx(this.idColumn)} = ${id}
          AND ${tx(this.workspaceColumn)} = ${workspaceId}
          AND (valid_to IS NOT NULL OR status <> 'active')
      `;
    });
  }

  // ── deleteByFilter ──────────────────────────────────────────────────────────

  async deleteByFilter(filter: VectorFilter): Promise<number> {
    // Build the WHERE clause conditionally.
    // We always need at least one condition; both workspaceId and ids are
    // optional per the type, so we fall back to a no-op when neither is given.

    if (filter.workspaceId == null) return 0;
    const workspaceId = filter.workspaceId;
    const result = await this.sql.begin(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      if (filter.ids != null && filter.ids.length > 0) {
        return tx`
          UPDATE ${tx(this.table)}
          SET ${tx(this.embeddingColumn)} = NULL
          WHERE ${tx(this.workspaceColumn)} = ${workspaceId}
            AND ${tx(this.idColumn)} = ANY(${filter.ids})
        `;
      }
      return tx`
        UPDATE ${tx(this.table)}
        SET ${tx(this.embeddingColumn)} = NULL
        WHERE ${tx(this.workspaceColumn)} = ${workspaceId}
      `;
    });

    return result.count;
  }

  // ── healthCheck ─────────────────────────────────────────────────────────────

  // CHAOS-9: the probe used to read a row of the (RLS-protected) table outside
  // any workspace transaction. On a pooled connection where a search had set
  // the workspace GUC locally, the GUC reads back as '' and the policy's
  // `::uuid` cast throws, so readiness reported `vector: "down"` for good while
  // vector search worked. The probe now checks, without tenant data, what this
  // adapter needs: the database answers, the table exists and this role may
  // read it, and the pgvector extension is installed.
  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const [row] = await this.sql<
        Array<{ has_table: boolean; can_read: boolean | null; has_vector: boolean }>
      >`
        SELECT to_regclass(${this.table}) IS NOT NULL AS has_table,
               has_table_privilege(to_regclass(${this.table}), 'SELECT') AS can_read,
               EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector
      `;
      const missing = !row?.has_table
        ? `table ${this.table} not found`
        : !row.can_read
          ? `no SELECT privilege on ${this.table}`
          : !row.has_vector
            ? "pgvector extension not installed"
            : null;
      if (missing) {
        return { status: "down", latencyMs: Date.now() - start, detail: missing };
      }
      return {
        status: "ok",
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: "down",
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── close ───────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.sql.end();
  }
}
