import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { ServiceUnavailableError } from "../errors.js";
import { resolveProvenance } from "../provenance.js";
import { resolveCeiling } from "../rbac.js";

/**
 * Dashboard aggregates: one GROUP BY each, workspace-scoped, bounded windows.
 *
 * GET /recall/metrics?days=  recall calls, zero-hit share and latency per UTC day.
 * GET /facts/stats           live facts by kind, sensitivity and memory type, under the ceiling.
 * GET /graph/stats           the graph the caller can read: nodes, relations, conflicts, hubs.
 * GET /session/stats?days=   sessions started per day by status, episodes and their topics.
 * GET /health/snapshots?days= the workspace's daily health snapshots, as shares and rates.
 * GET /audit/stats?days=     the undo log (user forgets, system archives) per day.
 * GET /me/activity?days=     the caller's own audit-log entries per day and by action.
 *
 * Mount before mountFacts: GET /facts/{id} would otherwise answer /facts/stats.
 */

const nullableShare = z.number().min(0).max(1).nullable();
const RecallMetricsWindowSchema = z.object({
  queries: z.number().int(),
  zeroHitShare: nullableShare,
  p50Ms: z.number().int().nullable(),
  p95Ms: z.number().int().nullable(),
});

const RecallMetricsSchema = z
  .object({
    days: z.array(RecallMetricsWindowSchema.extend({ day: z.string() })),
    totals: RecallMetricsWindowSchema,
  })
  .openapi("RecallMetrics");

const RecallMetricsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(7)
    .max(90)
    .default(30)
    .openapi({
      param: { name: "days", in: "query" },
      description: "UTC days ending today, 7 to 90.",
    }),
});

const count = z.number().int();
const FactStatsSchema = z
  .object({
    live: count,
    pinned: count,
    neverRecalled: count,
    lastWriteAt: z.string().nullable(),
    byKind: z.array(z.object({ kind: z.string(), count })),
    bySensitivity: z.array(
      z.object({
        sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
        count,
      })
    ),
    byMemoryType: z.array(z.object({ memoryType: z.string(), count })),
  })
  .openapi("FactStats");

const GraphStatsSchema = z
  .object({
    entities: count,
    decisions: count,
    episodes: count,
    relations: count,
    conflicts: count,
    isolated: count,
    entitiesByKind: z.array(z.object({ kind: z.string(), count })),
    relationsByType: z.array(z.object({ relation: z.string(), count })),
    hubs: z.array(z.object({ id: z.string(), label: z.string(), degree: count })),
  })
  .openapi("GraphStats");

const SessionStatsSchema = z
  .object({
    days: z.array(z.object({ day: z.string(), active: count, collapsed: count, archived: count })),
    totals: z.object({
      sessions: count,
      collapsed: count,
      avgTurns: z.number().nullable(),
      episodes: count,
      factsPerEpisode: z.number().nullable(),
    }),
    topics: z.array(z.object({ topic: z.string(), count })),
  })
  .openapi("SessionStats");

const nullableNumber = z.number().nullable();
const HealthSnapshotsSchema = z
  .object({
    days: z.array(
      z.object({
        day: z.string(),
        recallHitRate30d: nullableShare,
        zeroHitShare: nullableShare,
        embeddedShare: nullableShare,
        failedJobs7d: nullableNumber,
      })
    ),
  })
  .openapi("HealthSnapshots");

const AuditFeedStatsSchema = z
  .object({
    days: z.array(z.object({ day: z.string(), user: count, system: count })),
    totals: z.object({ user: count, system: count }),
  })
  .openapi("AuditFeedStats");

const AuditActivitySchema = z
  .object({
    days: z.array(z.object({ day: z.string(), count })),
    byAction: z.array(z.object({ action: z.string(), count })),
    lastAt: z.string().nullable(),
  })
  .openapi("OwnActivity");

/** Groups largest first, then by name. */
function tally<T>(rows: T[], key: (r: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

export function mountAggregates(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  const storage = () => {
    if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
    return deps.storage;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/recall/metrics",
      tags: ["recall"],
      summary: "Recall calls, zero-hit share and latency per UTC day.",
      description:
        "`days` UTC days ending today, zero-filled, oldest first, and the same figures over the " +
        "window. `queries` counts recall calls (their audit entries, one per call); " +
        "`zeroHitShare` is the share that returned nothing, over the calls whose audit detail is " +
        "readable (null when none is); `p50Ms`/`p95Ms` are per call, over calls that served a fact.",
      request: { query: RecallMetricsQuerySchema },
      responses: {
        200: {
          description: "Recall activity per day.",
          content: { "application/json": { schema: RecallMetricsSchema } },
        },
        400: { description: "`days` outside 7–90." },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const { days } = c.req.valid("query");
      return c.json(await storage().getRecallMetrics(c.get("workspaceId"), days), 200);
    }
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/facts/stats",
      tags: ["facts"],
      summary: "Counts of the live facts the caller can read.",
      description:
        "Live facts (open, active) at or under the caller's sensitivity ceiling: rows above it " +
        "are not counted. Groups are largest first; empty groups are left out.",
      responses: {
        200: {
          description: "Live fact counts.",
          content: { "application/json": { schema: FactStatsSchema } },
        },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) =>
      c.json(
        await storage().getFactStats({
          workspaceId: c.get("workspaceId"),
          maxSensitivity: resolveCeiling(c),
        }),
        200
      )
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/graph/stats",
      tags: ["graph"],
      summary: "Counts of the graph the caller can read.",
      description:
        "Tallied from the same snapshot GET /graph?includeMentions=true draws, under the caller's " +
        "sensitivity ceiling: canonical entities, active decisions, non-synthetic episodes, open " +
        "typed relations (dismissed ones and semantic neighbours left out). `isolated` counts " +
        "entities with no relation and no mention; `hubs` are the five entities with the most " +
        "links (relations and mentions). `conflicts` counts open fact conflicts, like " +
        "GET /conflicts' total.",
      responses: {
        200: {
          description: "Graph counts.",
          content: { "application/json": { schema: GraphStatsSchema } },
        },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const maxSensitivity = resolveCeiling(c);
      // ponytail: tallies the whole snapshot in memory (one read, the same rows the Graph room
      // draws); a GROUP BY per figure in the repository if a workspace's graph outgrows that.
      const [graph, conflicts] = await Promise.all([
        storage().getGraphSnapshot({ workspaceId, maxSensitivity, includeMentions: true }),
        storage().countOpenConflicts({ workspaceId, maxSensitivity }),
      ]);
      const entities = graph.nodes.filter((n) => n.kind === "entity");
      const typed = graph.edges.filter((e) => e.relation !== "mentions");
      const degree = new Map<string, number>();
      for (const e of graph.edges)
        for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
      return c.json(
        {
          entities: entities.length,
          decisions: graph.nodes.filter((n) => n.kind === "decision").length,
          episodes: graph.nodes.filter((n) => n.kind === "episode").length,
          relations: typed.length,
          conflicts,
          isolated: entities.filter((n) => !degree.has(n.id)).length,
          entitiesByKind: tally(entities, (n) => n.entityKind ?? "other").map(([kind, count]) => ({
            kind,
            count,
          })),
          relationsByType: tally(typed, (e) => e.relation).map(([relation, count]) => ({
            relation,
            count,
          })),
          hubs: entities
            .filter((n) => degree.has(n.id))
            .map((n) => ({ id: n.id, label: n.label, degree: degree.get(n.id)! }))
            .sort((a, b) => b.degree - a.degree || (a.label < b.label ? -1 : 1))
            .slice(0, 5),
        },
        200
      );
    }
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/session/stats",
      tags: ["session"],
      summary: "Sessions and episodes over a window of UTC days.",
      description:
        "`days` UTC days ending today. `days[]` counts the sessions started each day by their " +
        "current status (zero-filled, oldest first). `totals.collapsed` counts the window's " +
        "sessions collapsed into memory, `avgTurns` their mean turn count. `episodes` counts the " +
        "non-synthetic episodes that occurred in the window at or under the caller's ceiling, " +
        "`factsPerEpisode` the mean of their linked facts the caller can read, and `topics` the " +
        "five topics most of them carry.",
      request: { query: RecallMetricsQuerySchema },
      responses: {
        200: {
          description: "Session activity.",
          content: { "application/json": { schema: SessionStatsSchema } },
        },
        400: { description: "`days` outside 7–90." },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const { days } = c.req.valid("query");
      return c.json(
        await storage().getSessionStats({
          workspaceId: c.get("workspaceId"),
          days,
          maxSensitivity: resolveCeiling(c),
        }),
        200
      );
    }
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/health/snapshots",
      tags: ["health"],
      summary: "The workspace's daily health snapshots, as shares and rates.",
      description:
        "`days` UTC days ending today, oldest first: each day's latest persisted snapshot " +
        "(`mnemo_health`), every figure null on a day without one. A snapshot covers every " +
        "sensitivity tier, so only shares and rates are returned, never row counts. Requires memory:admin.",
      request: { query: RecallMetricsQuerySchema },
      responses: {
        200: {
          description: "Snapshot history.",
          content: { "application/json": { schema: HealthSnapshotsSchema } },
        },
        400: { description: "`days` outside 7–90." },
        401: { description: "Missing or invalid bearer token." },
        403: { description: "memory:admin scope required." },
      },
    }),
    async (c) => {
      const { days } = c.req.valid("query");
      return c.json(
        { days: await storage().getHealthSnapshots({ workspaceId: c.get("workspaceId"), days }) },
        200
      );
    }
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/audit/stats",
      tags: ["audit"],
      summary: "The undo log counted per UTC day.",
      description:
        "GET /audit's entries counted, not listed: `days` UTC days ending today, zero-filled, " +
        "oldest first, each with the day's user forgets and system archives, and the totals " +
        "over the window. Facts above the caller's sensitivity ceiling are not counted.",
      request: { query: RecallMetricsQuerySchema },
      responses: {
        200: {
          description: "Undo-log counts.",
          content: { "application/json": { schema: AuditFeedStatsSchema } },
        },
        400: { description: "`days` outside 7–90." },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const { days } = c.req.valid("query");
      return c.json(
        await storage().getAuditFeedStats({
          workspaceId: c.get("workspaceId"),
          days,
          maxSensitivity: resolveCeiling(c),
        }),
        200
      );
    }
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/me/activity",
      tags: ["keys"],
      summary: "The caller's own audit-log entries in this workspace.",
      description:
        "Entries whose actor is the caller (the signed-in person, or the key): `days` UTC days " +
        "ending today, zero-filled, oldest first; the window's entries by action, largest " +
        "first; and the caller's latest entry ever (null when none).",
      request: { query: RecallMetricsQuerySchema },
      responses: {
        200: {
          description: "Own activity.",
          content: { "application/json": { schema: AuditActivitySchema } },
        },
        400: { description: "`days` outside 7–90." },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const { days } = c.req.valid("query");
      const actor = resolveProvenance(c).actorId;
      const activity = await storage().getAuditActivity({
        workspaceId: c.get("workspaceId"),
        days,
        actorIds: [actor],
      });
      return c.json(
        {
          days: activity.days,
          byAction: activity.byAction,
          lastAt: activity.lastAt[actor] ?? null,
        },
        200
      );
    }
  );
}
