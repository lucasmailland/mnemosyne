import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { HealthSnapshot, RecallPrecisionReport } from "@mnemo-ai/types";
import { RECALL_PRECISION_METHODOLOGY_NOTE } from "@mnemo-ai/types";
import { getAuthCtx, type AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toIso } from "../schemas.js";
import { resolveCeiling } from "../rbac.js";

/**
 * GET /admin/stats — composite workspace operational statistics.
 *
 * Relocated verbatim from `admin.ts` (docs/archive/openspec/decompose-admin-routes) — pure
 * file-level split, no schema, path, or handler-logic change. No `emitAudit`
 * call — `admin.ts` never emitted audit here; none is added by this move.
 */

// ─── Zod schemas ────────────────────────────────────────────────────────────

const AdminStatsSchema = z
  .object({
    workspaceId: z.string(),
    generatedAt: z.iso.datetime(),
    facts: z.object({
      live: z.number().int(),
      closed: z.number().int(),
      pinned: z.number().int(),
      archived: z.number().int().nullable(),
      // Admin-only fields (withZeroHits, byScopeRef, embeddings, snapshot, recall.precision*)
      // are omitted for callers without memory:admin.
      withZeroHits: z.number().int().nullable().optional(),
      byScopeRef: z.array(z.object({ scopeRef: z.string(), count: z.number().int() })).optional(),
    }),
    decisions: z.object({ active: z.number().int().nullable() }),
    // Live, under the caller's ceiling (the pairs GET /conflicts can list);
    // null only when the count could not be read.
    relations: z.object({ conflicts: z.number().int().nullable() }),
    embeddings: z.object({ indexed: z.number().int(), pending: z.number().int() }).optional(),
    // Requirement 5 (make-primitives-recallable): the four counts above are
    // derived from `snapshot`, which may be absent (cold start) or stale. A
    // `?? 0` fallback would silently report "the snapshot says zero" the same
    // as "there is no usable snapshot" — this block lets a consumer tell them
    // apart, matching the `recall.hitRate30d … ?? null` idiom below.
    snapshot: z
      .object({
        at: z.iso.datetime().nullable(),
        ageSeconds: z.number().nullable(),
        available: z.boolean(),
      })
      .optional(),
    recall: z.object({
      hitRate30d: z.number().nullable(),
      lastRecallAt: z.iso.datetime().nullable(),
      // harden-hooks-and-measure-precision (Slice 4, A2-read, Requirement 5/6):
      // precision-at-k over data already persisted by recordRecall + collapse's
      // TD(λ) propagation. See RecallPrecisionReport / design.md.
      precisionAtK: z
        .array(
          z.object({
            k: z.number().int(),
            precision: z.number().nullable(),
            sampleSize: z.number().int(),
          })
        )
        .optional(),
      precisionTotalHits: z.number().int().optional(),
      precisionPendingHits: z.number().int().optional(),
      precisionInsufficientData: z.boolean().optional(),
      /**
       * P133 — true when the precision read itself could not run (as opposed to
       * running and finding nothing). Without this the two are byte-identical,
       * which is how a query that threw on every call for its entire life read
       * as "not enough history yet".
       */
      precisionUnavailable: z.boolean().optional(),
      precisionMethodologyNote: z.string().optional(),
      /** p50/p95 over the last 7 days of recall-log rows; null when there are no samples. */
      latencyP50Ms7d: z.number().nullable().optional(),
      latencyP95Ms7d: z.number().nullable().optional(),
    }),
    /**
     * APP-015 — context economy, last 7 days. servedChars* is the memory text
     * recall actually put in front of a caller (per call); liveFactChars is
     * every live plaintext fact, what a flat memory file would inject on every
     * turn. Null when the read is unavailable, never a fabricated 0.
     */
    context: z
      .object({
        recalls7d: z.number().int().nullable(),
        servedCharsAvg7d: z.number().nullable(),
        servedCharsP95_7d: z.number().nullable(),
        liveFacts: z.number().int().nullable(),
        liveFactChars: z.number().int().nullable(),
        methodology: z.string(),
      })
      .optional(),
    /** Facts created per UTC day, 14 entries ending today, oldest first. */
    writesPerDay14d: z.array(z.object({ day: z.string(), count: z.number().int() })).optional(),
    lastWriteAt: z.iso.datetime().nullable(),
  })
  .openapi("AdminStats");

// ─── Route definitions ──────────────────────────────────────────────────────

const getStats = createRoute({
  method: "get",
  path: "/admin/stats",
  tags: ["admin"],
  summary: "Composite workspace stats (vitals + drift) for operator dashboards.",
  responses: {
    200: {
      description: "Composite admin stats combining vitals and health snapshot data.",
      content: { "application/json": { schema: AdminStatsSchema } },
    },
  },
});

// ─── Mount ───────────────────────────────────────────────────────────────────

export function mountAdminStats(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // API-4: GET /admin/stats
  app.openapi(getStats, async (c) => {
    const workspaceId = c.get("workspaceId");
    const generatedAt = new Date().toISOString();

    // Fetch vitals — flatten-legacy-dual-core PR12: ported off the legacy
    // core's vitals() onto the v3 StorageAdapter port
    // (packages/types/src/ports.ts's getWorkspaceVitals, added in PR6),
    // same aggregate query, now implemented in adapter-postgres's
    // FactRepository. Response shape unchanged (pinned by
    // parity/admin.parity.test.ts before this swap).
    if (!deps.storage) {
      throw new Error("[admin] deps.storage is required — no storage adapter wired.");
    }
    const vitals = await deps.storage.getWorkspaceVitals(workspaceId);

    // Fetch drift snapshot — flatten-legacy-dual-core Phase 9 (task 9.1):
    // ported off the legacy core's direct `@mnemo-ai/core` `getHealthSnapshot`
    // import (which opened its own `withMnemoTx`) onto the v3 StorageAdapter
    // port (packages/types/src/ports.ts's getHealthSnapshot), same
    // computed-metric definitions, now implemented in adapter-postgres's
    // HealthRepository. Response shape unchanged.
    let snapshot: HealthSnapshot | null = null;
    try {
      snapshot = (await deps.storage?.getHealthSnapshot({ workspaceId, fresh: false })) ?? null;
    } catch {
      // No DB available or cold start — serve best-effort with nulls
    }

    // harden-hooks-and-measure-precision (Slice 4, A2-read): computed live,
    // not persisted — no schema migration, no new write path. Best-effort:
    // an unavailable precision read must not fail the whole /admin/stats call.
    // Empty scopes count as admin only under MNEMO_ALLOW_LEGACY_FULL_SCOPE
    // (legacy full access; the scope guard already let the call in), so only
    // an explicit non-admin scope set gets the trimmed body.
    const { scopes } = getAuthCtx(c);
    const isAdmin = scopes.length === 0 || scopes.includes("memory:admin");

    const readPrecision = async (): Promise<RecallPrecisionReport | null> => {
      if (!isAdmin) return null;
      try {
        return (await deps.storage?.getRecallPrecision(workspaceId)) ?? null;
      } catch (err) {
        // P133 — best-effort, but NOT silent. This catch is why a query that
        // threw on every single call for its whole life looked like
        // `insufficientData: true`: a read that could not run and a workspace
        // with no history produced byte-identical responses, and the field named
        // "insufficient data" made the broken one sound intentional.
        //
        // Swallowing stays (an unavailable precision read must not fail the whole
        // stats call) — what changes is that it now says so.
        // console.warn, matching session.ts's anticipation.preinject_failed —
        // ServerDeps carries no logger, and the pino instance lives in index.ts.
        console.warn(
          {
            operation: "admin_stats.precision_failed",
            workspaceId,
            err: err instanceof Error ? err.message : String(err),
          },
          "recall precision read failed — reported as unavailable, not as insufficient data"
        );
        return null;
      }
    };
    // Best-effort like the reads above: a failed latency or series read must not
    // fail the call. Latency degrades to null, the series to an empty array.
    const noLatency = { p50Ms: null, p95Ms: null };
    const readLatency = async (): Promise<{ p50Ms: number | null; p95Ms: number | null }> => {
      try {
        return (await deps.storage?.getRecallLatency(workspaceId, 7)) ?? noLatency;
      } catch {
        return noLatency;
      }
    };
    const readWritesPerDay = async (): Promise<Array<{ day: string; count: number }>> => {
      try {
        return (await deps.storage?.getWritesPerDay(workspaceId, 14)) ?? [];
      } catch {
        return [];
      }
    };
    // Open conflicts, counted live under the caller's ceiling (the snapshot's
    // count saw every tier). Best-effort: unavailable reads as null.
    const readConflicts = async (): Promise<number | null> => {
      try {
        return (
          (await deps.storage?.countOpenConflicts({
            workspaceId,
            maxSensitivity: resolveCeiling(c),
          })) ?? null
        );
      } catch {
        return null;
      }
    };
    const readEconomy = async () => {
      // Operator figure, like precision: admin only, and sized under the
      // caller's ceiling so it never counts facts the caller cannot read.
      if (!isAdmin) return null;
      try {
        return (await deps.storage?.getContextEconomy?.(workspaceId, 7, resolveCeiling(c))) ?? null;
      } catch {
        return null;
      }
    };
    // Independent reads: run them together.
    const [precision, latency, writesPerDay, conflicts, economy] = await Promise.all([
      readPrecision(),
      readLatency(),
      readWritesPerDay(),
      readConflicts(),
      readEconomy(),
    ]);

    // Requirement 5 (make-primitives-recallable): distinguish "the snapshot
    // says zero" from "there is no usable snapshot" — a `?? 0` fallback over
    // a possibly-absent snapshot is prohibited for these four counts.
    const snapshotAgeSeconds =
      snapshot != null ? Math.max(0, (Date.now() - snapshot.snapshotAt.getTime()) / 1000) : null;

    return c.json(
      {
        workspaceId,
        generatedAt,
        facts: {
          live: vitals.factsLive,
          closed: vitals.factsClosed,
          pinned: vitals.pinnedCount,
          archived: snapshot?.factCountArchived ?? null,
          ...(isAdmin && {
            withZeroHits: snapshot?.factsWithZeroHits ?? null,
            byScopeRef: vitals.factsByScopeRef,
          }),
        },
        decisions: {
          active: snapshot?.decisionCountActive ?? null,
        },
        relations: {
          conflicts,
        },
        ...(isAdmin && {
          embeddings: {
            indexed: vitals.embeddings.indexed,
            pending: vitals.embeddings.pending,
          },
          snapshot: {
            at: snapshot != null ? toIso(snapshot.snapshotAt) : null,
            ageSeconds: snapshotAgeSeconds,
            available: snapshot != null,
          },
        }),
        recall: {
          hitRate30d: snapshot?.recallHitRate30d ?? null,
          lastRecallAt: toIso(vitals.lastRecallAt),
          latencyP50Ms7d: latency.p50Ms,
          latencyP95Ms7d: latency.p95Ms,
          ...(isAdmin && {
            // Falls back to an explicit insufficient-data shape (never a
            // fabricated 0 or 1) when the precision read itself is unavailable —
            // same "unavailability distinguishable from emptiness" discipline
            // as Requirement 4, applied to this report.
            precisionAtK:
              precision?.precisionAtK ??
              [1, 3, 5].map((k) => ({ k, precision: null, sampleSize: 0 })),
            precisionTotalHits: precision?.totalHits ?? 0,
            precisionPendingHits: precision?.pendingHits ?? 0,
            precisionInsufficientData: precision?.insufficientData ?? true,
            // P133: unavailable (read threw) is distinct from insufficient data.
            precisionUnavailable: precision === null,
            precisionMethodologyNote:
              precision?.methodologyNote ?? RECALL_PRECISION_METHODOLOGY_NOTE,
          }),
        },
        ...(isAdmin && {
          context: {
            recalls7d: economy?.recalls ?? null,
            servedCharsAvg7d: economy?.servedCharsAvg ?? null,
            servedCharsP95_7d: economy?.servedCharsP95 ?? null,
            liveFacts: economy?.liveFacts ?? null,
            liveFactChars: economy?.liveFactChars ?? null,
            methodology:
              "servedChars: characters of memory content returned per recall in the last 7 days (after projection and the caller's ceiling). liveFactChars: characters of every live plaintext fact under the caller's ceiling, i.e. what injecting every live fact on each turn would cost. About 4 characters per token.",
          },
        }),
        writesPerDay14d: writesPerDay,
        lastWriteAt: toIso(vitals.lastWriteAt),
      },
      200
    );
  });
}
