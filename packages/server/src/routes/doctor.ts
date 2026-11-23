/**
 * GET /doctor — operational preflight diagnostics.
 *
 * Runs 6 server-side checks via Promise.allSettled (each individually
 * caught so one failing check never blocks the rest). Returns a
 * DoctorReport with an overall worst-of status.
 *
 * Auth: standard workspace bearer token (same as all other v1 routes).
 * No auto-remediation — report only.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { listMigrationFilenames } from "@mnemo-ai/adapter-postgres/migrate";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const DoctorCheckSchema = z
  .object({
    name: z.string(),
    status: z.enum(["ok", "warn", "error", "unknown"]),
    message: z.string(),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("DoctorCheck");

const DoctorReportSchema = z
  .object({
    status: z.enum(["ok", "warn", "error", "unknown"]),
    checks: z.array(DoctorCheckSchema),
    timestamp: z.iso.datetime(),
  })
  .openapi("DoctorReport");

// ─── Internal types ───────────────────────────────────────────────────────────

type CheckStatus = "ok" | "warn" | "error" | "unknown";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: Record<string, unknown>;
}

/** Compute the worst-of status across a list of check results. */
function worstOf(checks: CheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === "error")) return "error";
  if (checks.some((c) => c.status === "warn")) return "warn";
  if (checks.some((c) => c.status === "unknown")) return "unknown";
  return "ok";
}

// ─── Check implementations ────────────────────────────────────────────────────

/**
 * Check 1 — connectivity: delegate to deps.storage.healthCheck() (v3 port).
 *
 * flatten-legacy-dual-core PR6: ported off the legacy core's `ping()` — the same
 * `SELECT 1` round-trip, now via `StorageAdapter.healthCheck()`
 * (`DrizzleStorageAdapter.healthCheck()`, already implemented and already
 * used as the primary path for `GET /health/ready`'s per-dependency probe,
 * see `routes/health.ts`). `deps.storage` is optional on `ServerDeps` for
 * test-fixture flexibility only — every real boot wires it unconditionally
 * (`packages/server/src/index.ts`).
 */
async function checkConnectivity(deps: ServerDeps): Promise<CheckResult> {
  if (!deps.storage) {
    return {
      name: "connectivity",
      status: "unknown",
      message: "No storage adapter available — cannot verify connectivity.",
    };
  }
  try {
    const status = await deps.storage.healthCheck();
    if (status.status !== "ok") {
      return {
        name: "connectivity",
        status: "error",
        message: `Postgres unreachable: ${status.status}.`,
      };
    }
    return { name: "connectivity", status: "ok", message: "Postgres reachable." };
  } catch (err) {
    return {
      name: "connectivity",
      status: "error",
      message: `Postgres unreachable: ${(err as Error).message}`,
    };
  }
}

/** Check 2 — app_user_grants: verify USAGE privilege on mnemosyne schema. */
async function checkAppUserGrants(deps: ServerDeps): Promise<CheckResult> {
  if (!deps.metricsPgClient) {
    return {
      name: "app_user_grants",
      status: "unknown",
      message: "No pg client available — cannot verify grants.",
    };
  }
  try {
    const rows = await deps.metricsPgClient`
      SELECT has_schema_privilege('app_user', 'mnemosyne', 'USAGE') AS granted
    `;
    const granted = rows[0]?.granted;
    if (granted === true) {
      return {
        name: "app_user_grants",
        status: "ok",
        message: "app_user has USAGE on mnemosyne schema.",
      };
    }
    return {
      name: "app_user_grants",
      status: "error",
      message: "app_user lacks GRANT USAGE on mnemosyne schema.",
    };
  } catch {
    // Permission denied to run the privilege check — role probably exists but
    // the connected superuser can't check. Treat as unknown (not error).
    return {
      name: "app_user_grants",
      status: "unknown",
      message: "unknown (role may not exist or privilege check denied).",
    };
  }
}

/** Tables the legacy (public) migration stream creates; see packages/core/migrations. */
const LEGACY_PUBLIC_TABLES: ReadonlySet<string> = new Set([
  "mnemo_api_keys",
  "mnemo_citation",
  "mnemo_cron_schedule",
  "mnemo_decision",
  "mnemo_entity",
  "mnemo_episode",
  "mnemo_extraction_job",
  "mnemo_fact",
  "mnemo_fact_archive",
  "mnemo_health",
  "mnemo_org_fact_view",
  "mnemo_pointer",
  "mnemo_query_cache",
  "mnemo_relation",
  "mnemo_review_queue",
  "mnemo_semantic_neighbor",
  "mnemo_summary",
  "mnemo_unresolved_mention",
]);

/** Check 3 — schema_shadows: detect tables that exist in both public and mnemosyne schemas. */
async function checkSchemaShadows(deps: ServerDeps): Promise<CheckResult> {
  if (!deps.metricsPgClient) {
    return {
      name: "schema_shadows",
      status: "unknown",
      message: "No pg client available — cannot check schema shadows.",
    };
  }
  try {
    const rows = await deps.metricsPgClient`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname IN ('public', 'mnemosyne')
      GROUP BY tablename
      HAVING COUNT(*) > 1
    `;
    const n = rows.length;
    if (n === 0) {
      return { name: "schema_shadows", status: "ok", message: "No schema shadow tables detected." };
    }
    const tables = rows.map((r) => (r as { tablename: string }).tablename);
    // APP-049: the legacy migration stream (packages/core/migrations) runs on
    // every deploy next to the v3 one, so these always exist in both schemas.
    // That is the expected layout, not a shadow worth a warning on every fresh
    // install. Any other table in both schemas still is.
    const unexpected = tables.filter((name) => !LEGACY_PUBLIC_TABLES.has(name));
    if (unexpected.length === 0) {
      return {
        name: "schema_shadows",
        status: "ok",
        message: `${n} legacy table(s) in public alongside their mnemosyne counterparts, as expected.`,
        detail: { shadowCount: n, tables, unexpected },
      };
    }
    return {
      name: "schema_shadows",
      status: "warn",
      message: `${unexpected.length} table(s) exist in both public and mnemosyne schemas (potential shadow).`,
      detail: { shadowCount: n, tables, unexpected },
    };
  } catch (err) {
    return {
      name: "schema_shadows",
      status: "error",
      message: `schema_shadows check failed: ${(err as Error).message}`,
    };
  }
}

/** Check 4 — migration_version: report latest applied migration filename. */
async function checkMigrationVersion(deps: ServerDeps): Promise<CheckResult> {
  if (!deps.metricsPgClient) {
    return {
      name: "migration_version",
      status: "unknown",
      message: "No pg client available — cannot query schema_migrations.",
    };
  }
  try {
    const [rows, expected] = await Promise.all([
      deps.metricsPgClient<{ filename: string; applied_at: Date | string }[]>`
        SELECT filename, applied_at FROM mnemosyne.schema_migrations ORDER BY applied_at DESC
      `,
      listMigrationFilenames(),
    ]);

    // Drift check: migrations/ bundled with THIS build is the source of truth
    // for what should be applied. If the newest migration this build knows
    // about was never applied, the DB is silently behind — exactly the gap
    // that let our own migrate image go stale unnoticed (schema_migrations
    // topped out at an old migration while the server ran newer code against
    // it, and this check used to just report "latest applied" with no
    // comparison, so it always said "ok" regardless).
    const applied = new Set(rows.map((r) => r.filename));
    const expectedLatest = expected[expected.length - 1];
    if (expectedLatest && !applied.has(expectedLatest)) {
      const missing = expected.filter((f) => !applied.has(f));
      return {
        name: "migration_version",
        status: "error",
        message: `Database is missing ${missing.length} migration(s) this build expects, up to ${expectedLatest}. Run the migrate job.`,
        detail: { expectedLatest, missing },
      };
    }

    if (rows.length === 0) {
      return {
        name: "migration_version",
        status: "ok",
        message: "No migrations found in mnemosyne.schema_migrations.",
      };
    }
    const row = rows[0]!;
    const appliedAt =
      row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at);
    return {
      name: "migration_version",
      status: "ok",
      message: `Latest: ${row.filename} applied at ${appliedAt}.`,
      detail: { filename: row.filename, appliedAt },
    };
  } catch (err) {
    return {
      name: "migration_version",
      status: "error",
      message: `migration_version check failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Check 5 — embedding_backlog: count live facts missing an embedding.
 *
 * mnemo_fact has FORCE ROW LEVEL SECURITY. Under the non-superuser role a
 * hardened deployment runs as (see docker/README.md's role-provisioning
 * section), a query with no mnemosyne.workspace_id GUC set sees zero rows —
 * not an error, just silently empty — so this check would always report
 * "ok" no matter how large the real backlog is. /doctor is a per-request
 * workspace-scoped endpoint (standard workspace bearer token, same as
 * checkWorkspaceIdValid below), so the fix is to scope the query to the
 * caller's own workspace and set the GUC for it, not to bypass RLS.
 */
async function checkEmbeddingBacklog(deps: ServerDeps, workspaceId: string): Promise<CheckResult> {
  if (!deps.metricsPgClient) {
    return {
      name: "embedding_backlog",
      status: "unknown",
      message: "No pg client available — cannot count embedding backlog.",
    };
  }
  try {
    const rows = await deps.metricsPgClient.begin(async (tx) => {
      await tx`SELECT mnemosyne.mnemo_set_workspace(${workspaceId}::uuid)`;
      return tx`
        SELECT COUNT(*) AS backlog
        FROM mnemosyne.mnemo_fact
        WHERE (embedding IS NULL OR embedding_stale = true)
          AND valid_to IS NULL
          AND status = 'active'
          AND workspace_id = ${workspaceId}
      `;
    });
    const backlog = Number(rows[0]?.backlog ?? 0);
    if (backlog === 0) {
      return {
        name: "embedding_backlog",
        status: "ok",
        message: "All live facts have up-to-date embeddings.",
      };
    }
    return {
      name: "embedding_backlog",
      status: "warn",
      message: `${backlog} live fact(s) are missing or have stale embeddings.`,
      detail: { backlog },
    };
  } catch (err) {
    return {
      name: "embedding_backlog",
      status: "error",
      message: `embedding_backlog check failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Check 6 — workspace_id_valid: validate workspaceId UUID format from auth context.
 *
 * Exported for direct unit testing only. In practice this "error" branch is
 * unreachable through the real HTTP route: the API-key lookup
 * (packages/core/src/api-key-lookup.ts) filters malformed workspace_ids out
 * of listActive()/findByLookupHash() before auth even runs, and auth.ts's
 * own isWorkspaceId() gate (packages/server/src/auth.ts:235 and :366 — the
 * exact same regex as UUID_RE below) rejects with 400 before this route's
 * handler ever executes. See
 * packages/server/src/__tests__/integration/doctor-nonsuperuser.integration.test.ts
 * for an empirical proof.
 */
export function checkWorkspaceIdValid(workspaceId: string): CheckResult {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_RE.test(workspaceId)) {
    return {
      name: "workspace_id_valid",
      status: "ok",
      message: "workspace_id is a well-formed UUID.",
    };
  }
  return {
    name: "workspace_id_valid",
    status: "error",
    message: `workspace_id does not match UUID format: "${workspaceId}".`,
  };
}

// ─── Route mount ──────────────────────────────────────────────────────────────

export function mountDoctor(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/doctor",
      tags: ["diagnostics"],
      summary: "Run operational preflight diagnostic checks.",
      description:
        "Runs 6 server-side diagnostic checks (connectivity, app_user_grants, " +
        "schema_shadows, migration_version, embedding_backlog, workspace_id_valid) " +
        "and returns a structured DoctorReport. " +
        "The memory_doctor MCP tool also appends 2 client-side checks before " +
        "presenting the merged report. Requires a valid workspace bearer token.",
      responses: {
        200: {
          description: "Diagnostic report (always 200 — check `status` and `checks[]` for issues).",
          content: { "application/json": { schema: DoctorReportSchema } },
        },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");

      // Run all 6 checks in parallel; allSettled ensures one failure does not
      // block the others.
      const settled = await Promise.allSettled([
        checkConnectivity(deps),
        checkAppUserGrants(deps),
        checkSchemaShadows(deps),
        checkMigrationVersion(deps),
        checkEmbeddingBacklog(deps, workspaceId),
        // workspace_id_valid is synchronous but wrapped to fit the pattern.
        Promise.resolve(checkWorkspaceIdValid(workspaceId)),
      ]);

      const checks: CheckResult[] = settled.map((result, i) => {
        if (result.status === "fulfilled") return result.value;
        // Rejected promise — surface as an error check.
        const names = [
          "connectivity",
          "app_user_grants",
          "schema_shadows",
          "migration_version",
          "embedding_backlog",
          "workspace_id_valid",
        ] as const;
        return {
          name: names[i] ?? `check_${i}`,
          status: "error" as const,
          message: `Check threw unexpectedly: ${(result.reason as Error | undefined)?.message ?? String(result.reason)}`,
        };
      });

      const overall = worstOf(checks);

      return c.json(
        {
          status: overall,
          checks,
          timestamp: new Date().toISOString(),
        },
        200
      );
    }
  );
}

/** Test hook for the schema_shadows check. */
export const checkSchemaShadowsForTests = checkSchemaShadows;
