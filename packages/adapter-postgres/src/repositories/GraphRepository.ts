import { dbNow } from "./_clock.js";
import {
  eq,
  and,
  or,
  inArray,
  isNull,
  isNotNull,
  ne,
  lte,
  gt,
  desc,
  sql,
  count,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import * as schema from "../schema/index.js";
import { sameWidthAsEachOther } from "./_embedding-width.js";
import { mapRowToRelation, hyperedgeRowToDomain } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type {
  MnemoRelation,
  CreateRelationInput,
  RelationFilter,
  ApplyRelationJudgmentInput,
  MnemoHyperedge,
  CreateHyperedgeInput,
  UpdateHyperedgeInput,
  HyperedgeFilter,
  PaginatedResult,
  GraphSnapshotFilter,
  GraphSnapshot,
  GraphNode,
  GraphEdge,
  Sensitivity,
} from "@mnemo-ai/types";
import {
  assembleGraphSnapshot,
  SENSITIVITY_ORDER,
  tiersAtOrBelow,
  StorageNotFoundError,
  StorageValidationError,
} from "@mnemo-ai/types";

/** Raw row shape of `loadSemanticEdges`' projection (entity-to-entity, deduped). */
interface SemanticEdgeRow {
  sourceId: string;
  targetId: string;
  cosine: number;
}

/** Every primitive table a hyperedge member id can resolve in (hyperedges are not binary endpoints). */
const MEMBER_TABLES = [
  "mnemo_fact",
  "mnemo_decision",
  "mnemo_entity",
  "mnemo_episode",
  "mnemo_strategy",
  "mnemo_workflow",
  "mnemo_skill",
  "mnemo_task",
  "mnemo_event",
  "mnemo_reasoning",
] as const;

/**
 * The rows above the readable tiers that `id` resolves to: in `mnemo_<kind>`
 * when the kind is known (a relation endpoint), in every primitive table
 * otherwise (a hyperedge member). One primary-key lookup per table; the bound
 * values are the kinds and tiers only, so the statement stays the same size
 * however much data there is. An id that resolves to no row matches nothing.
 */
function hiddenRows(id: SQL | AnyColumn, readable: Sensitivity[], kind?: AnyColumn): SQL {
  const tiers = sql.join(
    readable.map((t) => sql`${t}`),
    sql`, `
  );
  const branches = MEMBER_TABLES.map((t) => {
    const ofKind = kind ? sql`${kind} = ${t.slice("mnemo_".length)} AND ` : sql``;
    return sql`SELECT 1 FROM ${sql.raw(`mnemosyne.${t}`)} x WHERE ${ofKind}x.id = ${id} AND x.sensitivity NOT IN (${tiers})`;
  });
  return sql.join(branches, sql` UNION ALL `);
}

/** Null when the ceiling admits every tier (nothing to hide), else the tiers it admits. */
function hiddenTiersExist(ceiling: Sensitivity | undefined): Sensitivity[] | null {
  if (!ceiling) return null;
  const readable = tiersAtOrBelow(ceiling);
  return readable.length < Object.keys(SENSITIVITY_ORDER).length ? readable : null;
}

/** Neither endpoint of the relation row is above the ceiling (no condition when nothing is hidden). */
export function relationReadable(ceiling: Sensitivity | undefined): SQL[] {
  const readable = hiddenTiersExist(ceiling);
  if (!readable) return [];
  const r = schema.relationTable;
  return [
    sql`NOT EXISTS (${hiddenRows(r.sourceId, readable, r.sourceKind)})`,
    sql`NOT EXISTS (${hiddenRows(r.targetId, readable, r.targetKind)})`,
  ];
}

/** No member of the hyperedge row is above the ceiling (no condition when nothing is hidden). */
export function hyperedgeReadable(ceiling: Sensitivity | undefined): SQL[] {
  const readable = hiddenTiersExist(ceiling);
  if (!readable) return [];
  return [
    sql`NOT EXISTS (SELECT 1 FROM unnest(${schema.hyperedgeTable.memberIds}) AS m(id) WHERE EXISTS (${hiddenRows(sql`m.id`, readable)}))`,
  ];
}

// Matches the `FooTx` convention already established by
// FactRepository/SessionRepository/ConsolidationRepository.
type GraphTx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

export class GraphRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  async createRelation(input: CreateRelationInput): Promise<MnemoRelation> {
    // PRIM-13: a node cannot relate to itself (also a CHECK on the table, so a
    // writer that skips this path is still stopped, but with a typed error here).
    if (input.sourceType === input.targetType && input.sourceId === input.targetId) {
      throw new StorageValidationError("A relation cannot link a node to itself");
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(schema.relationTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          sourceKind: input.sourceType,
          sourceId: input.sourceId,
          targetKind: input.targetType,
          targetId: input.targetId,
          relation: input.verb,
          hebbianWeight: input.weight ?? 1.0,
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
          // flatten-legacy-dual-core D6.4 bugfix: previously this ALWAYS
          // wrote `evidence: input.metadata ?? {}` — even pure-Hebbian
          // callers with no judgment intent (co-recall, session collapse)
          // forced a non-null `{}` into the judgment overlay's `evidence`
          // column, clobbering its natural unset (`null`) state. Every
          // judgment field below is now conditionally set so the DB's own
          // defaults (`judgmentStatus: 'pending'`, `markedByKind: 'system'`,
          // `evidence: NULL`, ...) apply when the caller has no judgment
          // data to provide.
          ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
          ...(input.judgmentStatus !== undefined ? { judgmentStatus: input.judgmentStatus } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.markedByUserId !== undefined ? { markedByUserId: input.markedByUserId } : {}),
          ...(input.markedByKind !== undefined ? { markedByKind: input.markedByKind } : {}),
          ...(input.markedByModel !== undefined ? { markedByModel: input.markedByModel } : {}),
          ...(input.markedByPromptVersion !== undefined
            ? { markedByPromptVersion: input.markedByPromptVersion }
            : {}),
          ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
          ...(input.supersededByRelationId !== undefined
            ? { supersededByRelationId: input.supersededByRelationId }
            : {}),
          ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
          ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
        })
        .returning();

      // ENTITY-1 (docs/archive/remediation/2026-07-31-post-audit-followups.md,
      // ported from legacy factory.ts's createRelation by flatten-legacy-
      // dual-core PR9d): a fact->entity `part_of`/`member_of` relation
      // backfills `mnemo_fact.entity_id`, so `memory_entity`'s
      // `linked_facts` (which reads that column, not `mnemo_relation`)
      // becomes reachable via the tool an agent already reaches for to
      // link a fact to an entity. First relation wins: only fires when
      // `entity_id` is still NULL, so a fact already linked to one entity
      // is never silently re-pointed by a later, possibly-unrelated
      // `part_of`/`member_of` relation. Same transaction as the relation
      // insert above — if this fact doesn't exist (or is already linked),
      // the UPDATE affects 0 rows and the relation itself still succeeds;
      // this is deliberately best-effort, not a new failure mode for
      // `memory_relate`. Proven by `__tests__/integration/
      // relate-entity.integration.test.ts`'s ENTITY-VERIFY-1 suite (already
      // exercised deps.core pre-PR9d; runs against this path once
      // routes/relations.ts is ported).
      if (
        input.sourceType === "fact" &&
        input.targetType === "entity" &&
        (input.verb === "part_of" || input.verb === "member_of")
      ) {
        await tx
          .update(schema.factTable)
          .set({ entityId: input.targetId })
          .where(
            and(
              eq(schema.factTable.id, input.sourceId),
              eq(schema.factTable.workspaceId, input.workspaceId),
              isNull(schema.factTable.entityId)
            )
          );
      }

      return mapRowToRelation(rows[0]!);
    });
  }

  async getRelations(filter: RelationFilter): Promise<MnemoRelation[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);

      const conditions = [eq(schema.relationTable.workspaceId, filter.workspaceId)];
      if (filter.sourceId) conditions.push(eq(schema.relationTable.sourceId, filter.sourceId));
      if (filter.targetId) conditions.push(eq(schema.relationTable.targetId, filter.targetId));
      if (filter.sourceIds && filter.sourceIds.length > 0) {
        conditions.push(inArray(schema.relationTable.sourceId, filter.sourceIds));
      }
      if (filter.targetIds && filter.targetIds.length > 0) {
        conditions.push(inArray(schema.relationTable.targetId, filter.targetIds));
      }
      if (filter.verb) conditions.push(eq(schema.relationTable.relation, filter.verb));
      if (filter.verbs && filter.verbs.length > 0) {
        conditions.push(inArray(schema.relationTable.relation, filter.verbs));
      }
      if (filter.judgmentStatus) {
        conditions.push(eq(schema.relationTable.judgmentStatus, filter.judgmentStatus));
      }
      // Current graph by default: a relation closed by DELETE /relations/:id or
      // by a hard delete is history. `validAt` reconstructs a past graph, and
      // an explicit `openOnly: false` reads the history (export, lineage).
      if (filter.openOnly ?? filter.validAt === undefined) {
        conditions.push(isNull(schema.relationTable.validTo));
      }
      if (filter.validAt) {
        conditions.push(lte(schema.relationTable.validFrom, filter.validAt));
        conditions.push(
          or(
            isNull(schema.relationTable.validTo),
            gt(schema.relationTable.validTo, filter.validAt)
          )!
        );
      }
      // Ahead of `limit`, so a capped page is never filled (or cut short) by hidden rows.
      conditions.push(...relationReadable(filter.maxSensitivity));

      // flatten-legacy-dual-core Slice 3c: previously unordered — harmless
      // for callers that consume the full result set, but a real bug for
      // any caller (routes/conflicts.ts's GET /conflicts, "newest first" per
      // its own OpenAPI doc comment) that slices to a limit smaller than the
      // matching row count: without a deterministic order, which rows land
      // in the slice becomes arbitrary. Matches the legacy
      // `CoreLike.listRelations`'s `.orderBy(sql\`created_at DESC\`)`
      // (factory.ts).
      let query = tx
        .select()
        .from(schema.relationTable)
        .where(and(...conditions))
        .orderBy(desc(schema.relationTable.createdAt))
        .$dynamic();
      if (filter.limit) query = query.limit(filter.limit);

      const rows = await query;
      return rows.map(mapRowToRelation);
    });
  }

  /** flatten-legacy-dual-core D6.4 — see `ApplyRelationJudgmentInput`'s doc comment (ports.ts). */
  async applyRelationJudgment(input: ApplyRelationJudgmentInput): Promise<MnemoRelation | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const patch: Partial<typeof schema.relationTable.$inferInsert> = {
        relation: input.relation,
        judgmentStatus: "judged",
        markedByKind: input.markedByKind,
        updatedAt: new Date(),
      };
      if (input.reason !== undefined) patch.reason = input.reason;
      if (input.evidence !== undefined) patch.evidence = input.evidence;
      if (input.confidence !== undefined) patch.confidence = input.confidence;
      if (input.markedByUserId !== undefined) patch.markedByUserId = input.markedByUserId;
      if (input.markedByModel !== undefined) patch.markedByModel = input.markedByModel;
      if (input.markedByPromptVersion !== undefined) {
        patch.markedByPromptVersion = input.markedByPromptVersion;
      }

      const rows = await tx
        .update(schema.relationTable)
        .set(patch)
        .where(
          and(
            eq(schema.relationTable.id, input.id),
            eq(schema.relationTable.workspaceId, input.workspaceId),
            ...relationReadable(input.maxSensitivity)
          )
        )
        .returning();

      return rows[0] ? mapRowToRelation(rows[0]) : null;
    });
  }

  /**
   * flatten-legacy-dual-core PR9f (design.md D6.5 "Graph — assembly-in-
   * adapter, traversal-in-core"). Adapter-side snapshot assembly — mirrors
   * legacy `buildGraphQuery` (`packages/core/src/graph/query.ts`) exactly:
   * canonical entities (`canonicalId IS NULL`), non-synthetic episodes,
   * active decisions, fact stats grouped by `entityId`, and relations
   * excluding `judgmentStatus = 'dismissed'` — bitemporal (`validAt`) or
   * currently-open (`validTo IS NULL`) depending on `filter.asOf`. Shares
   * `assembleGraphSnapshot` (the focus-neighbourhood + meta-count tail) with
   * `InMemoryStorageAdapter` so the two never drift.
   */
  async getGraphSnapshot(filter: GraphSnapshotFilter): Promise<GraphSnapshot> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);
      const asOf = filter.asOf;
      // Tiers the caller may read (null = every tier). Rows above the ceiling
      // are never selected, so they can't become nodes, edge endpoints or
      // fact counts.
      const ceiling = filter.maxSensitivity;
      const readable = ceiling ? tiersAtOrBelow(ceiling) : null;

      const [entityRows, episodeRows, decisionRows, factStatRows, relationRows] = await Promise.all(
        [
          tx
            .select()
            .from(schema.entityTable)
            .where(
              and(
                eq(schema.entityTable.workspaceId, filter.workspaceId),
                isNull(schema.entityTable.canonicalId),
                ...(readable ? [inArray(schema.entityTable.sensitivity, readable)] : []),
                ...(asOf ? [lte(schema.entityTable.createdAt, asOf)] : [])
              )
            ),

          tx
            .select()
            .from(schema.episodeTable)
            .where(
              and(
                eq(schema.episodeTable.workspaceId, filter.workspaceId),
                eq(schema.episodeTable.isSynthetic, false),
                ...(readable ? [inArray(schema.episodeTable.sensitivity, readable)] : []),
                ...(asOf ? [lte(schema.episodeTable.createdAt, asOf)] : [])
              )
            ),

          tx
            .select()
            .from(schema.decisionTable)
            .where(
              and(
                eq(schema.decisionTable.workspaceId, filter.workspaceId),
                eq(schema.decisionTable.status, "active"),
                ...(readable ? [inArray(schema.decisionTable.sensitivity, readable)] : []),
                ...(asOf ? [lte(schema.decisionTable.createdAt, asOf)] : [])
              )
            ),

          tx
            .select({
              entityId: schema.factTable.entityId,
              factCount: sql<number>`cast(count(*) as int)`,
              avgMemoryStrength: sql<number>`coalesce(avg(${schema.factTable.memoryStrength}), 1.0)`,
            })
            .from(schema.factTable)
            .where(
              and(
                eq(schema.factTable.workspaceId, filter.workspaceId),
                eq(schema.factTable.status, "active"),
                isNotNull(schema.factTable.entityId),
                ...(readable ? [inArray(schema.factTable.sensitivity, readable)] : []),
                ...(asOf ? [lte(schema.factTable.createdAt, asOf)] : [])
              )
            )
            .groupBy(schema.factTable.entityId),

          tx
            .select()
            .from(schema.relationTable)
            .where(
              and(
                eq(schema.relationTable.workspaceId, filter.workspaceId),
                ...(asOf
                  ? [
                      lte(schema.relationTable.validFrom, asOf),
                      or(
                        isNull(schema.relationTable.validTo),
                        gt(schema.relationTable.validTo, asOf)
                      )!,
                    ]
                  : [isNull(schema.relationTable.validTo)]),
                ne(schema.relationTable.judgmentStatus, "dismissed")
              )
            ),
        ]
      );

      const factStatsByEntity = new Map(
        factStatRows.filter((s) => s.entityId != null).map((s) => [s.entityId!, s])
      );

      // Episode factCount is the linked-id count minus the linked facts above
      // the ceiling (ids that resolve to no fact still count, as without one).
      // Counted in SQL by unnesting the stored arrays, so the statement binds
      // the same few parameters however many facts the episodes link.
      const hiddenByEpisode = new Map<string, number>();
      // Nothing is hidden when the ceiling admits every tier (or there are no episodes), so the
      // scan is skipped. ponytail: still scans the workspace's episodes when a tier is hidden;
      // restrict to the returned ids with a uuid[] param if that ever shows up in a profile.
      const allTiers = Object.keys(SENSITIVITY_ORDER).length;
      if (readable && readable.length < allTiers && episodeRows.length > 0) {
        const rows = (await tx.execute(sql`
          SELECT ep.id AS "episodeId", count(*)::int AS hidden
          FROM mnemosyne.mnemo_episode ep
          CROSS JOIN LATERAL unnest(ep.linked_fact_ids) AS linked(fact_id)
          JOIN mnemosyne.mnemo_fact f
            ON f.id = linked.fact_id AND f.workspace_id = ep.workspace_id
          WHERE ep.workspace_id = ${filter.workspaceId}
            AND f.sensitivity NOT IN (${sql.join(
              readable.map((t) => sql`${t}`),
              sql`, `
            )})
          GROUP BY ep.id
        `)) as unknown as Array<{ episodeId: string; hidden: number }>;
        for (const r of Array.from(rows)) hiddenByEpisode.set(r.episodeId, r.hidden);
      }

      const entityNodes: GraphNode[] = entityRows.map((e) => {
        const stats = factStatsByEntity.get(e.id);
        return {
          id: e.id,
          kind: "entity",
          entityKind: e.kind as GraphNode["entityKind"],
          label: e.name,
          description: e.description,
          mentionCount: 0, // derived by assembleGraphSnapshot
          factCount: stats?.factCount ?? 0,
          avgMemoryStrength: stats?.avgMemoryStrength ?? 1.0,
          createdAt: e.createdAt,
        };
      });

      const episodeNodes: GraphNode[] = episodeRows.map((ep) => ({
        id: ep.id,
        kind: "episode",
        label: ep.title,
        mentionCount: 0,
        factCount: ep.linkedFactIds.length - (hiddenByEpisode.get(ep.id) ?? 0),
        avgMemoryStrength: 1.0,
        createdAt: ep.createdAt,
      }));

      const decisionNodes: GraphNode[] = decisionRows.map((d) => ({
        id: d.id,
        kind: "decision",
        label: d.title,
        mentionCount: 0,
        factCount: 0,
        avgMemoryStrength: 1.0,
        createdAt: d.createdAt,
      }));

      const nodes = [...entityNodes, ...episodeNodes, ...decisionNodes];
      const nodeIds = new Set(nodes.map((n) => n.id));

      const edges: GraphEdge[] = relationRows
        .filter((r) => nodeIds.has(r.sourceId) && nodeIds.has(r.targetId))
        .map((r) => ({
          id: r.id,
          source: r.sourceId,
          target: r.targetId,
          relation: r.relation,
          confidence: r.confidence ?? 0.7,
          provenance: r.provenance,
        }));

      // Episode → entity through the episode's linked facts the caller can read. Derived per
      // request from the stored arrays; an entity merged into another (not a node) drops out.
      if (filter.includeMentions && episodeRows.length > 0) {
        const tiers = readable
          ? sql` AND f.sensitivity IN (${sql.join(
              readable.map((t) => sql`${t}`),
              sql`, `
            )})`
          : sql``;
        const rows = (await tx.execute(sql`
          SELECT DISTINCT ep.id AS "episodeId", f.entity_id AS "entityId"
          FROM mnemosyne.mnemo_episode ep
          CROSS JOIN LATERAL unnest(ep.linked_fact_ids) AS linked(fact_id)
          JOIN mnemosyne.mnemo_fact f
            ON f.id = linked.fact_id AND f.workspace_id = ep.workspace_id
          WHERE ep.workspace_id = ${filter.workspaceId}
            AND f.status = 'active'
            AND f.entity_id IS NOT NULL${tiers}${asOf ? sql` AND f.created_at <= ${asOf}` : sql``}
        `)) as unknown as Array<{ episodeId: string; entityId: string }>;
        for (const r of Array.from(rows)) {
          if (!nodeIds.has(r.episodeId) || !nodeIds.has(r.entityId)) continue;
          edges.push({
            id: `men:${r.episodeId}:${r.entityId}`,
            source: r.episodeId,
            target: r.entityId,
            relation: "mentions",
            confidence: 1,
            provenance: "episode_facts",
          });
        }
      }

      if (filter.includeSemantic) {
        const semanticEdges = await this.loadSemanticEdges(tx, filter.workspaceId, readable);
        for (const s of semanticEdges) {
          if (!nodeIds.has(s.sourceId) || !nodeIds.has(s.targetId)) continue;
          edges.push({
            id: `sem:${s.sourceId}:${s.targetId}`,
            source: s.sourceId,
            target: s.targetId,
            relation: "semantically_related",
            confidence: s.cosine,
            provenance: "semantic_knn",
          });
        }
      }

      return assembleGraphSnapshot(nodes, edges, { focusEntityId: filter.focusEntityId });
    });
  }

  /** See the port's doc comment: the same count `getGraphSnapshot` derives, for a page of ids. */
  async countEntityMentions(input: {
    workspaceId: string;
    entityIds: string[];
    maxSensitivity?: Sensitivity;
  }): Promise<Record<string, number>> {
    if (input.entityIds.length === 0) return {};
    const readable = hiddenTiersExist(input.maxSensitivity);
    const tiers = readable
      ? sql.join(
          readable.map((t) => sql`${t}`),
          sql`, `
        )
      : null;
    const visible = (alias: string) =>
      tiers ? sql` AND ${sql.raw(alias)}.sensitivity IN (${tiers})` : sql``;
    // The ids travel as ONE text[] parameter (an array literal), so the
    // statement binds the same handful of values for any page size.
    const ids = `{${input.entityIds.map((id) => `"${id.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
    const ws = input.workspaceId;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${ws}::uuid)`);
      // `= ANY(<one array param>)` rather than `IN (SELECT … FROM ids)`, and the
      // endpoint kinds pinned, so the planner probes idx_mnemo_fact_entity and
      // idx_mnemo_rel_source/target instead of scanning every relation.
      const inIds = (col: string) => sql`${sql.raw(col)} = ANY(${ids}::text[])`;
      const rows = (await tx.execute(sql`
        WITH ids AS (SELECT DISTINCT unnest(${ids}::text[]) AS id),
        facts AS (
          SELECT f.entity_id AS id, count(*)::int AS n
          FROM mnemosyne.mnemo_fact f
          WHERE f.workspace_id = ${ws} AND f.status = 'active'
            AND ${inIds("f.entity_id")}${visible("f")}
          GROUP BY f.entity_id
        ),
        links AS (
          SELECT r.source_id AS id, r.target_id AS episode_id
          FROM mnemosyne.mnemo_relation r
          WHERE r.workspace_id = ${ws} AND r.valid_to IS NULL AND r.judgment_status <> 'dismissed'
            AND r.source_kind = 'entity' AND r.target_kind = 'episode' AND ${inIds("r.source_id")}
          UNION ALL
          SELECT r.target_id, r.source_id
          FROM mnemosyne.mnemo_relation r
          WHERE r.workspace_id = ${ws} AND r.valid_to IS NULL AND r.judgment_status <> 'dismissed'
            AND r.target_kind = 'entity' AND r.source_kind = 'episode' AND ${inIds("r.target_id")}
        ),
        episodes AS (
          SELECT l.id, count(DISTINCT l.episode_id)::int AS n
          FROM links l
          JOIN mnemosyne.mnemo_episode ep
            ON ep.id = l.episode_id AND ep.workspace_id = ${ws} AND ep.is_synthetic = false${visible("ep")}
          GROUP BY l.id
        )
        SELECT ids.id, (coalesce(facts.n, 0) + coalesce(episodes.n, 0))::int AS n
        FROM ids LEFT JOIN facts USING (id) LEFT JOIN episodes USING (id)
      `)) as unknown as Array<{ id: string; n: number }>;
      return Object.fromEntries(Array.from(rows).map((r) => [r.id, r.n]));
    });
  }

  /**
   * GraphPort.countOpenConflicts: one COUNT of the pairs GET /conflicts lists —
   * open conflicts_with relations whose two facts are current and, under a
   * ceiling, both readable.
   */
  async countOpenConflicts(input: {
    workspaceId: string;
    maxSensitivity?: Sensitivity;
  }): Promise<number> {
    const readable = hiddenTiersExist(input.maxSensitivity);
    const tiers = readable
      ? sql.join(
          readable.map((t) => sql`${t}`),
          sql`, `
        )
      : null;
    const visible = (alias: string) =>
      tiers ? sql` AND ${sql.raw(alias)}.sensitivity IN (${tiers})` : sql``;
    const ws = input.workspaceId;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${ws}::uuid)`);
      const [row] = (await tx.execute(sql`
        SELECT count(*)::int AS n
        FROM mnemosyne.mnemo_relation r
        JOIN mnemosyne.mnemo_fact a
          ON a.id = r.source_id AND a.workspace_id = ${ws} AND a.valid_to IS NULL${visible("a")}
        JOIN mnemosyne.mnemo_fact b
          ON b.id = r.target_id AND b.workspace_id = ${ws} AND b.valid_to IS NULL${visible("b")}
        WHERE r.workspace_id = ${ws} AND r.relation = 'conflicts_with' AND r.valid_to IS NULL
      `)) as unknown as Array<{ n: number }>;
      return row?.n ?? 0;
    });
  }

  /**
   * GraphPort.findHiddenIds: the ids that resolve, in this workspace, to a row
   * above the ceiling, in any primitive table. The ids travel as one text[]
   * parameter, so the statement binds the same handful of values for any
   * number of ids; each branch is a primary-key probe.
   */
  async findHiddenIds(input: {
    workspaceId: string;
    ids: string[];
    maxSensitivity: Sensitivity;
  }): Promise<string[]> {
    const readable = hiddenTiersExist(input.maxSensitivity);
    if (!readable || input.ids.length === 0) return [];
    const tiers = sql.join(
      readable.map((t) => sql`${t}`),
      sql`, `
    );
    const ids = `{${[...new Set(input.ids)].map((id) => `"${id.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
    const ws = input.workspaceId;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${ws}::uuid)`);
      const branches = MEMBER_TABLES.map(
        (t) =>
          sql`SELECT x.id FROM ${sql.raw(`mnemosyne.${t}`)} x WHERE x.workspace_id = ${ws} AND x.id = ANY(${ids}::text[]) AND x.sensitivity NOT IN (${tiers})`
      );
      const rows = (await tx.execute(sql.join(branches, sql` UNION `))) as unknown as Array<{
        id: string;
      }>;
      return Array.from(rows, (r) => r.id);
    });
  }

  /**
   * flatten-legacy-dual-core PR9g (design.md D6.5). Ports legacy
   * `backfillSemanticNeighbors` (`core/src/graph/semantic-neighbors.ts`)
   * verbatim: delete every existing row for the workspace, then a single
   * set-based `INSERT ... JOIN LATERAL` picks each active embedded fact's
   * top-k nearest neighbours (HNSW cosine) and inserts pairs above
   * `threshold`. `ON CONFLICT (workspace_id, source_fact_id,
   * target_fact_id) DO UPDATE` is legacy's own idempotency mechanism —
   * combined with the delete-first step, re-running this method with
   * unchanged embeddings reproduces the exact same edge set every time
   * (proven by `graph-semantic-backfill.integration.test.ts`'s dedicated
   * idempotency test). See `StorageAdapter.backfillSemanticNeighbors`'s doc
   * comment (`@mnemo-ai/types`) for the `public.mnemo_semantic_neighbor`
   * schema-location verdict this method relies on.
   */
  async backfillSemanticNeighbors(input: {
    workspaceId: string;
    k?: number;
    threshold?: number;
    modelVersion?: string;
  }): Promise<number> {
    const k = input.k ?? 8;
    const threshold = input.threshold ?? 0.75;
    const modelVersion = input.modelVersion ?? null;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      await tx.execute(sql`
        DELETE FROM public.mnemo_semantic_neighbor WHERE workspace_id = ${input.workspaceId}::uuid
      `);

      const result = await tx.execute(sql`
        INSERT INTO public.mnemo_semantic_neighbor
          (workspace_id, source_fact_id, target_fact_id, cosine, model_version)
        SELECT
          ${input.workspaceId}::uuid,
          a.id,
          nb.id,
          (1 - (a.embedding <=> nb.embedding))::real AS cosine,
          ${modelVersion}
        FROM mnemosyne.mnemo_fact a
        JOIN LATERAL (
          SELECT b.id, b.embedding
          FROM mnemosyne.mnemo_fact b
          WHERE b.workspace_id = ${input.workspaceId}::text
            AND b.id <> a.id
            AND b.status = 'active'
            AND b.embedding IS NOT NULL
            -- P118: both operands are STORED columns here, so the width has to
            -- match between the two rows, not against a query vector. With
            -- mixed widths in mnemo_fact the self-join hits the first
            -- mismatched pair and takes the whole statement down.
            AND ${sameWidthAsEachOther("a.embedding", "b.embedding")}
          ORDER BY a.embedding <=> b.embedding
          LIMIT ${k}
        ) nb ON true
        WHERE a.workspace_id = ${input.workspaceId}::text
          AND a.status = 'active'
          AND a.embedding IS NOT NULL
          AND (1 - (a.embedding <=> nb.embedding)) >= ${threshold}
        ON CONFLICT (workspace_id, source_fact_id, target_fact_id) DO UPDATE
          SET cosine = EXCLUDED.cosine,
              model_version = EXCLUDED.model_version,
              computed_at = now()
      `);

      // flatten-legacy-dual-core PR9g bugfix: postgres.js's raw `Result` (what
      // `tx.execute(sql\`...\`)` returns for a query with no `.returning()`/
      // field mapper — see `PostgresJsPreparedQuery.execute` in
      // drizzle-orm/postgres-js) exposes the affected-row count as `.count`,
      // NOT `.rowCount` (that's the `pg`/node-postgres property name, a
      // different driver). `.rowCount` is `undefined` on every postgres.js
      // result, so the pre-existing `EmbeddingRepository.markStale` — which
      // this method's first draft copied verbatim — always silently returns
      // 0 regardless of how many rows were actually affected. Caught here
      // because `graph-semantic-backfill.integration.test.ts` (real
      // Postgres) asserts a nonzero `edgesWritten`, which `markStale` has no
      // equivalent test for (and is never actually called by any production
      // code path — see apply-progress.md PR9g "Issues Found" for the
      // disclosed-but-not-fixed sibling bug).
      return (result as unknown as { count?: number }).count ?? 0;
    });
  }

  /**
   * Semantic-neighbor overlay for `getGraphSnapshot(includeSemantic: true)` —
   * ports legacy `loadSemanticEdges` (`packages/core/src/graph/
   * semantic-neighbors.ts`) verbatim (same query, same entity projection).
   * `public.mnemo_semantic_neighbor` is a raw table with no Drizzle model.
   * Its write side, `backfillSemanticNeighbors` (above), was added by PR9g —
   * see that method's doc comment for the resolved schema-location verdict
   * this read-only query also relies on.
   */
  private async loadSemanticEdges(
    tx: GraphTx,
    workspaceId: string,
    readable: Sensitivity[] | null
  ): Promise<SemanticEdgeRow[]> {
    // A pair drawn from a fact above the caller's ceiling is not an edge for them.
    const tiers = readable
      ? sql.join(
          readable.map((t) => sql`${t}`),
          sql`, `
        )
      : null;
    const ceilingClause = tiers
      ? sql` AND fa.sensitivity IN (${tiers}) AND fb.sensitivity IN (${tiers})`
      : sql``;
    const rows = await tx.execute(sql`
      SELECT
        LEAST(fa.entity_id, fb.entity_id)    AS "sourceId",
        GREATEST(fa.entity_id, fb.entity_id) AS "targetId",
        MAX(sn.cosine)::real                 AS cosine
      FROM public.mnemo_semantic_neighbor sn
      JOIN mnemosyne.mnemo_fact fa ON fa.id = sn.source_fact_id
      JOIN mnemosyne.mnemo_fact fb ON fb.id = sn.target_fact_id
      WHERE sn.workspace_id = ${workspaceId}::uuid
        AND fa.entity_id IS NOT NULL
        AND fb.entity_id IS NOT NULL
        AND fa.entity_id <> fb.entity_id${ceilingClause}
      GROUP BY LEAST(fa.entity_id, fb.entity_id), GREATEST(fa.entity_id, fb.entity_id)
    `);
    return rows as unknown as SemanticEdgeRow[];
  }

  async updateRelationStrength(id: string, delta: number): Promise<void> {
    await this.db
      .update(schema.relationTable)
      .set({
        hebbianWeight: sql`LEAST(1.0, GREATEST(0.0, hebbian_weight + ${delta}))`,
        coRecallCount: sql`co_recall_count + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.relationTable.id, id));
  }

  /**
   * P111 — bitemporal close. `valid_to IS NULL` in the predicate makes a repeat
   * call a no-op that reports false, rather than silently re-stamping a
   * already-closed relation with a later timestamp.
   */
  async closeRelation(
    id: string,
    workspaceId: string,
    opts?: { maxSensitivity?: Sensitivity }
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .update(schema.relationTable)
        .set({ validTo: sql`now()` })
        .where(
          and(
            eq(schema.relationTable.id, id),
            eq(schema.relationTable.workspaceId, workspaceId),
            isNull(schema.relationTable.validTo),
            ...relationReadable(opts?.maxSensitivity)
          )
        )
        .returning({ id: schema.relationTable.id });
      return rows.length > 0;
    });
  }

  async deleteRelation(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .delete(schema.relationTable)
        .where(
          and(eq(schema.relationTable.id, id), eq(schema.relationTable.workspaceId, workspaceId))
        );
    });
  }

  async createHyperedge(input: CreateHyperedgeInput): Promise<MnemoHyperedge> {
    if (input.memberIds.length < 3) {
      throw new Error("createHyperedge requires at least 3 memberIds");
    }
    if (new Set(input.memberIds).size !== input.memberIds.length) {
      throw new StorageValidationError("Hyperedge members must be distinct");
    }
    const id = crypto.randomUUID();
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      if (input.verifyMembers) {
        await this.assertMembersExist(tx, input.workspaceId, input.memberIds, input.maxSensitivity);
      }
      const rows = await tx
        .insert(schema.hyperedgeTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          memberIds: input.memberIds,
          label: input.label ?? null,
          description: input.description ?? null,
          contextQuery: input.contextQuery ?? null,
          contextEmbedding: input.contextEmbedding ? Array.from(input.contextEmbedding) : null,
          activationCount: 0,
          worth: 0.5,
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
        })
        .returning();
      if (!rows[0]) throw new Error("createHyperedge: INSERT returned no rows");
      return hyperedgeRowToDomain(rows[0]);
    });
  }

  /** Members are untyped ids, so each must resolve in SOME primitive table of this workspace. */
  private async assertMembersExist(
    tx: GraphTx,
    workspaceId: string,
    memberIds: string[],
    maxSensitivity?: Sensitivity
  ): Promise<void> {
    // Members above the caller's ceiling count as missing (no existence oracle).
    const allowed = maxSensitivity ? tiersAtOrBelow(maxSensitivity) : null;
    const ceilingClause = allowed
      ? sql` AND sensitivity IN (${sql.join(
          allowed.map((t) => sql`${t}`),
          sql`, `
        )})`
      : sql``;
    const idList = sql.join(
      memberIds.map((m) => sql`${m}`),
      sql`, `
    );
    const lookups = MEMBER_TABLES.map(
      (t) =>
        sql`SELECT id FROM ${sql.raw(`mnemosyne.${t}`)} WHERE workspace_id = ${workspaceId} AND id IN (${idList})${ceilingClause}`
    );
    const rows = (await tx.execute(sql.join(lookups, sql` UNION `))) as unknown as Array<{
      id: string;
    }>;
    const have = new Set(Array.from(rows).map((r) => r.id));
    if (memberIds.some((m) => !have.has(m))) {
      // Deliberately does not say WHICH member: that would let a caller probe ids in bulk.
      throw new StorageNotFoundError("One or more hyperedge members were not found");
    }
  }

  async getHyperedge(
    id: string,
    workspaceId: string,
    opts?: { includeClosed?: boolean; maxSensitivity?: Sensitivity }
  ): Promise<MnemoHyperedge | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.hyperedgeTable)
        .where(
          and(
            eq(schema.hyperedgeTable.id, id),
            eq(schema.hyperedgeTable.workspaceId, workspaceId),
            ...(opts?.includeClosed ? [] : [isNull(schema.hyperedgeTable.validTo)]),
            ...hyperedgeReadable(opts?.maxSensitivity)
          )
        )
        .limit(1);
      return rows[0] ? hyperedgeRowToDomain(rows[0]) : null;
    });
  }

  async updateHyperedge(id: string, input: UpdateHyperedgeInput): Promise<MnemoHyperedge> {
    return this.db.transaction(async (tx) => {
      // PRIM-12: the workspace GUC has to be set BEFORE the first query. The old
      // code read the row first to learn its workspace; under FORCE RLS that
      // SELECT sees no rows, so every PATCH failed as "not found".
      if (input.workspaceId) {
        await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      }
      const existing = await tx
        .select()
        .from(schema.hyperedgeTable)
        .where(
          and(
            eq(schema.hyperedgeTable.id, id),
            ...(input.workspaceId ? [eq(schema.hyperedgeTable.workspaceId, input.workspaceId)] : [])
          )
        )
        .limit(1);
      if (!existing[0]) throw new StorageNotFoundError(`Hyperedge not found: ${id}`);
      if (existing[0].validTo != null) {
        throw new StorageNotFoundError(`Hyperedge not found: ${id}`);
      }
      if (!input.workspaceId) {
        await tx.execute(sql`SELECT mnemo_set_workspace(${existing[0].workspaceId}::uuid)`);
      }
      const patch: Partial<typeof schema.hyperedgeTable.$inferInsert> = {};
      if (input.label !== undefined) patch.label = input.label;
      if (input.description !== undefined) patch.description = input.description;
      if (input.contextQuery !== undefined) patch.contextQuery = input.contextQuery;
      if (Object.keys(patch).length === 0) return hyperedgeRowToDomain(existing[0]);
      const updated = await tx
        .update(schema.hyperedgeTable)
        .set(patch)
        .where(and(eq(schema.hyperedgeTable.id, id), isNull(schema.hyperedgeTable.validTo)))
        .returning();
      if (!updated[0]) throw new StorageNotFoundError(`Hyperedge not found: ${id}`);
      return hyperedgeRowToDomain(updated[0]);
    });
  }

  async archiveHyperedge(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .update(schema.hyperedgeTable)
        .set({ validTo: dbNow() })
        .where(
          and(
            eq(schema.hyperedgeTable.id, id),
            eq(schema.hyperedgeTable.workspaceId, workspaceId),
            // A repeat archive must not re-stamp the original close time.
            isNull(schema.hyperedgeTable.validTo)
          )
        );
    });
  }

  async queryHyperedges(filter: HyperedgeFilter): Promise<PaginatedResult<MnemoHyperedge>> {
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);
      const conditions = [eq(schema.hyperedgeTable.workspaceId, filter.workspaceId)];
      if (filter.memberId) {
        conditions.push(sql`${filter.memberId} = ANY(${schema.hyperedgeTable.memberIds})`);
      }
      if (filter.label) {
        conditions.push(eq(schema.hyperedgeTable.label, filter.label));
      }
      // PRIM-12: deleted hyperedges stay out of lists and counts unless asked for.
      if (!filter.includeClosed) conditions.push(isNull(schema.hyperedgeTable.validTo));
      // In the WHERE both queries share, so `total` doesn't count hidden hyperedges either.
      conditions.push(...hyperedgeReadable(filter.maxSensitivity));
      const where = conditions.length > 1 ? and(...conditions) : conditions[0];
      const [rows, countRows] = await Promise.all([
        tx
          .select()
          .from(schema.hyperedgeTable)
          .where(where)
          .orderBy(desc(schema.hyperedgeTable.activationCount))
          .limit(limit)
          .offset(offset),
        tx.select({ total: count() }).from(schema.hyperedgeTable).where(where),
      ]);
      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(hyperedgeRowToDomain),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }

  async bumpHyperedgeActivation(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .update(schema.hyperedgeTable)
        .set({ activationCount: sql`activation_count + 1` })
        .where(
          and(eq(schema.hyperedgeTable.id, id), eq(schema.hyperedgeTable.workspaceId, workspaceId))
        );
    });
  }
}
