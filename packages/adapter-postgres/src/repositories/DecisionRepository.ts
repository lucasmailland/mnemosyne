import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { closeAt, dbNow } from "./_clock.js";
import {
  type AnyColumn,
  type SQL,
  eq,
  and,
  or,
  lte,
  gt,
  isNull,
  sql,
  count,
  inArray,
} from "drizzle-orm";
import * as schema from "../schema/index.js";
import { mapRowToDecision, simpleHash } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type {
  MnemoDecision,
  CreateDecisionInput,
  UpdateDecisionInput,
  DecisionFilter,
  MergeDecisionByTopicKeyInput,
  PaginatedResult,
  SupersedeDecisionInput,
} from "@mnemo-ai/types";
import {
  PRIMITIVE_TEXT_PROJECTION,
  tiersAtOrBelow,
  StorageConflictError,
  StorageNotFoundError,
  StorageValidationError,
} from "@mnemo-ai/types";
import { scopeRefValues } from "@mnemo-ai/types";

// make-primitives-recallable (PR1, design.md D1): the outbox `text` payload
// derives from the shared registry instead of a hardcoded `title + " " +
// body` concat — this and EmbeddingRepository's EMBED_TABLE_META.textExpr
// are now the only two places that join is expressed, and both read it from
// PRIMITIVE_TEXT_PROJECTION.decision.
function projectDecisionText(title: string, body: string): string {
  const projection = PRIMITIVE_TEXT_PROJECTION.decision;
  const row: Record<string, string> = { title, body };
  return projection.fields
    .map((field) => row[field])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(projection.separator);
}

/** How many replaced texts a topic-key decision keeps in `metadata.revisions`. */
const MAX_KEPT_REVISIONS = 50;

export class DecisionRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  async createDecision(input: CreateDecisionInput): Promise<MnemoDecision> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const id = crypto.randomUUID();
      const normalizedHash = simpleHash(`${input.kind}:${input.title}:${input.body}`);

      const rows = await tx
        .insert(schema.decisionTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
          conversationId: input.conversationId,
          scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
          scopeRef: input.scopeRef,
          kind: input.kind,
          title: input.title,
          body: input.body,
          topicKey: input.topicKey,
          revisionCount: 1,
          normalizedHash,
          status: "active",
          decidedByUserId: input.decidedByUserId,
          confidence: input.confidence,
          validFrom: input.validFrom ?? dbNow(),
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: { id, kind: "decision", text: projectDecisionText(input.title, input.body) },
      });

      return mapRowToDecision(rows[0]!);
    });
  }

  /**
   * Topic-key upsert for decisions, mirroring `FactRepository.mergeFactByTopicKey`.
   * `null` = no active row for this key (caller inserts) — same contract as the
   * fact version. Two deliberate divergences: no DEK/sensitivity re-encryption
   * branch (decisions have no encrypted-statement path) and no tags merge
   * (decisions carry no `tags` column). The stored `topic_key` casing is never
   * rewritten — first writer wins, matching `primitives/decision.ts:100-107`.
   */
  async mergeDecisionByTopicKey(
    input: MergeDecisionByTopicKeyInput
  ): Promise<MnemoDecision | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const normalizedKey = input.topicKey.toLowerCase().trim();

      const sourceRows = await tx
        .select()
        .from(schema.decisionTable)
        .where(
          and(
            eq(schema.decisionTable.workspaceId, input.workspaceId),
            sql`lower(btrim(${schema.decisionTable.topicKey})) = ${normalizedKey}`,
            eq(schema.decisionTable.status, "active"),
            isNull(schema.decisionTable.validTo)
          )
        )
        .limit(1)
        .for("update");
      const source = sourceRows[0];
      if (!source) return null;

      const normalizedHash = simpleHash(`${input.kind}:${input.title}:${input.body}`);
      // PRIM-18: the revision overwrites in place (stable id, the contract
      // decision-topic-key.integration.test.ts pins), so the text it replaces is
      // kept in `metadata.revisions` (newest last, capped) instead of vanishing.
      const prior = (source.metadata ?? {}) as Record<string, unknown>;
      const history = Array.isArray(prior["revisions"]) ? (prior["revisions"] as unknown[]) : [];
      const revisions = [
        ...history,
        {
          revision: source.revisionCount,
          title: source.title,
          body: source.body,
          kind: source.kind,
          current_from: source.updatedAt.toISOString(),
          replaced_at: new Date().toISOString(),
        },
      ].slice(-MAX_KEPT_REVISIONS);
      const rows = await tx
        .update(schema.decisionTable)
        .set({
          title: input.title,
          body: input.body,
          kind: input.kind,
          normalizedHash,
          revisionCount: sql`${schema.decisionTable.revisionCount} + 1`,
          embedding: null,
          embeddingModel: null,
          embeddingStale: true,
          updatedAt: new Date(),
          ...(input.scopeRef !== undefined ? { scopeRef: input.scopeRef } : {}),
          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
          metadata: { ...prior, ...(input.metadata ?? {}), revisions },
        })
        .where(eq(schema.decisionTable.id, source.id))
        .returning();
      if (!rows[0]) return null;

      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: {
          id: source.id,
          kind: "decision",
          text: projectDecisionText(input.title, input.body),
        },
      });

      return mapRowToDecision(rows[0]);
    });
  }

  async getDecision(id: string, workspaceId: string): Promise<MnemoDecision | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.decisionTable)
        .where(
          and(eq(schema.decisionTable.id, id), eq(schema.decisionTable.workspaceId, workspaceId))
        )
        .limit(1);
      return rows[0] ? mapRowToDecision(rows[0]) : null;
    });
  }

  async updateDecision(id: string, input: UpdateDecisionInput): Promise<MnemoDecision> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const existing = await tx
        .select()
        .from(schema.decisionTable)
        .where(
          and(
            eq(schema.decisionTable.id, id),
            eq(schema.decisionTable.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!existing[0]) throw new Error(`Decision not found: ${id}`);

      const updates: PgUpdateSetSource<typeof schema.decisionTable> = {};
      if (input.title !== undefined) updates.title = input.title;
      if (input.body !== undefined) updates.body = input.body;
      if (input.status !== undefined) updates.status = input.status;
      if (input.supersededById !== undefined) updates.supersededById = input.supersededById;
      if (input.validTo !== undefined)
        updates.validTo = closeAt(input.validTo, schema.decisionTable.validFrom);
      // PRIM-18: closing a decision (superseded / withdrawn) always closes its
      // validity interval; a closed status with validTo NULL read as current.
      if (
        input.validTo === undefined &&
        (input.status === "superseded" || input.status === "withdrawn") &&
        existing[0].validTo == null
      ) {
        updates.validTo = dbNow();
      }
      if (input.metadata !== undefined)
        updates.metadata = input.metadata as Record<string, unknown>;
      // The same clock as the validTo above, so updated_at never trails valid_to.
      updates.updatedAt = dbNow();

      const rows = await tx
        .update(schema.decisionTable)
        .set(updates)
        .where(eq(schema.decisionTable.id, id))
        .returning();

      return mapRowToDecision(rows[0]!);
    });
  }

  /**
   * PRIM-18 — see `SupersedeDecisionInput`. Both rows are locked in id order so
   * two opposite supersedes cannot deadlock each other.
   */
  async supersedeDecision(input: SupersedeDecisionInput): Promise<MnemoDecision> {
    if (input.id === input.supersededById) {
      throw new StorageValidationError("A decision cannot supersede itself");
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const locked = await tx
        .select()
        .from(schema.decisionTable)
        .where(
          and(
            eq(schema.decisionTable.workspaceId, input.workspaceId),
            inArray(schema.decisionTable.id, [input.id, input.supersededById])
          )
        )
        .orderBy(schema.decisionTable.id)
        .for("update");
      const old = locked.find((d) => d.id === input.id);
      const next = locked.find((d) => d.id === input.supersededById);
      if (!old) throw new StorageNotFoundError(`Decision ${input.id} not found`);
      if (!next) throw new StorageNotFoundError(`Decision ${input.supersededById} not found`);

      if (old.status === "superseded") {
        if (old.supersededById === next.id) return mapRowToDecision(old);
        throw new StorageConflictError(
          `Decision ${old.id} was already superseded by another decision`
        );
      }
      if (old.status !== "active") {
        throw new StorageConflictError(
          `Decision ${old.id} is ${old.status} and cannot be superseded`
        );
      }
      // The replacement must be live; a closed one could point back at the old
      // decision (a cycle) or at a withdrawn row nobody can read.
      if (next.status !== "active" || next.validTo != null) {
        throw new StorageConflictError(
          `Decision ${next.id} is not active and cannot replace another`
        );
      }

      const now = dbNow();
      const rows = await tx
        .update(schema.decisionTable)
        .set({ status: "superseded", supersededById: next.id, validTo: now, updatedAt: now })
        .where(eq(schema.decisionTable.id, old.id))
        .returning();

      await tx.insert(schema.relationTable).values({
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        sourceKind: "decision",
        sourceId: next.id,
        targetKind: "decision",
        targetId: old.id,
        relation: "supersedes",
        hebbianWeight: 1.0,
        actorId: input.actorId,
        userId: input.userId,
        actorType: input.actorType,
      });
      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_delete",
        payload: { id: old.id, kind: "decision" },
      });
      return mapRowToDecision(rows[0]!);
    });
  }

  async archiveDecision(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const now = dbNow();
      await tx
        .update(schema.decisionTable)
        .set({ status: "withdrawn", validTo: now, updatedAt: now })
        .where(
          and(eq(schema.decisionTable.id, id), eq(schema.decisionTable.workspaceId, workspaceId))
        );

      await tx.insert(schema.outboxTable).values({
        workspaceId,
        eventType: "vector_delete",
        payload: { id, kind: "decision" },
      });
    });
  }

  async queryDecisions(filter: DecisionFilter): Promise<PaginatedResult<MnemoDecision>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.decisionTable.workspaceId, workspaceId)];
      if (filter.status) conditions.push(eq(schema.decisionTable.status, filter.status));
      if (filter.kind) conditions.push(eq(schema.decisionTable.kind, filter.kind));
      if (filter.topicKey) conditions.push(eq(schema.decisionTable.topicKey, filter.topicKey));
      const scopeRefs = scopeRefValues(filter);
      if (scopeRefs)
        conditions.push(
          or(
            inArray(schema.decisionTable.scopeRef, scopeRefs),
            isNull(schema.decisionTable.scopeRef)
          )!
        );
      if (filter.validAt) {
        conditions.push(lte(schema.decisionTable.validFrom, filter.validAt));
        conditions.push(
          // Typed operators, not raw sql — see querySkills (SKILL-1, 4bc311d).
          or(
            isNull(schema.decisionTable.validTo),
            gt(schema.decisionTable.validTo, filter.validAt)
          )!
        );
      }
      if (filter.openOnly) conditions.push(isNull(schema.decisionTable.validTo));

      if (filter.statuses) conditions.push(inArray(schema.decisionTable.status, filter.statuses));
      if (filter.maxSensitivity) {
        conditions.push(
          inArray(schema.decisionTable.sensitivity, tiersAtOrBelow(filter.maxSensitivity))
        );
      }

      // Millisecond truncation + byte-order ids so SQL agrees exactly with the
      // timeline's JS keyset comparator (Date ms, string code units).
      const closedAt = sql`COALESCE(${schema.decisionTable.validTo}, ${schema.decisionTable.updatedAt})`;
      const ms = (col: AnyColumn | SQL) => sql`date_trunc('milliseconds', ${col})`;
      const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
      // created_at >= a ms instant needs no truncation (and stays sargable).
      if (filter.createdSince)
        conditions.push(sql`${schema.decisionTable.createdAt} >= ${iso(filter.createdSince)}`);
      if (filter.closedSince) conditions.push(sql`${ms(closedAt)} > ${iso(filter.closedSince)}`);
      const orderCol = filter.orderBy
        ? ms(filter.orderBy === "createdAt" ? schema.decisionTable.createdAt : closedAt)
        : null;
      if (orderCol && filter.before)
        conditions.push(
          sql`(${orderCol}, ${schema.decisionTable.id} COLLATE "C") < (${iso(filter.before.at)}, ${filter.before.id})`
        );

      const whereClause = and(...conditions);
      const order = orderCol
        ? [sql`${orderCol} DESC`, sql`${schema.decisionTable.id} COLLATE "C" DESC`]
        : [];
      const [rows, countRows] = await Promise.all([
        tx
          .select()
          .from(schema.decisionTable)
          .where(whereClause)
          .orderBy(...order)
          .limit(limit)
          .offset(offset),
        filter.skipTotal
          ? null
          : tx.select({ total: count() }).from(schema.decisionTable).where(whereClause),
      ]);

      if (!countRows) {
        return {
          items: rows.map(mapRowToDecision),
          total: offset + rows.length,
          offset,
          limit,
          hasMore: rows.length === limit,
        };
      }
      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(mapRowToDecision),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }
}
