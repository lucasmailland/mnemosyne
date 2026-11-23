import { dbNow } from "./_clock.js";
// PRIM-18 (dedup part) — create a decision or strategy unless an identical
// active one exists, atomically.
//
// Facts have had content-hash idempotency since P109; two identical decisions
// or strategies were still two rows. remember() creates them through these
// methods instead of createDecision/createStrategy when the write names no
// topicKey, and gets the existing record back on a repeat.
//
// "Identical" is every field that makes the record what it is, compared
// exactly: content (kind/title/body, trigger/action), owner, scopeRef,
// sensitivity and, for a decision, the subject remember() keeps in its
// metadata — each as the insert would store it, defaults included. Text
// alone is not enough: the same sentence in another project, another person's
// scope or at another tier is its own record, and handing back an id the
// caller may not be allowed to read is worse than a duplicate. Only active,
// open rows count: an archived or superseded record is never resurrected.
//
// Atomic: the lookup and the insert run in ONE transaction that first takes a
// transaction-scoped advisory lock keyed by workspace and identity. Two
// identical writes serialize on the lock; the second sees the first's row.
// Different identities never wait on each other. Separate lookup and insert
// transactions left a window in which eight concurrent repeats made two rows.
//
// The INSERTs mirror DecisionRepository.createDecision and
// KnowledgeRepository.createStrategy (row + in-transaction vector_upsert
// outbox entry) for the inputs remember() sends — no supersedesId. The parity
// test in primitive-duplicate-lookup.integration.test.ts fails if they drift.

import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { mapRowToDecision, mapRowToStrategy, simpleHash } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type {
  CreateDecisionInput,
  CreateStrategyInput,
  MnemoDecision,
  MnemoStrategy,
} from "@mnemo-ai/types";
import { projectPrimitiveText } from "@mnemo-ai/types";

type Tx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

/** pg_advisory_xact_lock key for one identity — a 64-bit hash of its fields. */
async function lockIdentity(tx: Tx, parts: ReadonlyArray<string | null>): Promise<void> {
  const key = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export class DuplicateLookupRepository {
  constructor(private readonly db: DrizzleClient) {}

  async createDecisionUnlessDuplicate(
    input: CreateDecisionInput
  ): Promise<{ decision: MnemoDecision; reused: boolean }> {
    const scopeOwner = input.scopeOwner ?? `workspace:${input.workspaceId}`;
    const scopeRef = input.scopeRef ?? null;
    const sensitivity = input.sensitivity ?? "internal";
    // AGENTSIM-7: remember() keeps the decision's subject in metadata; the
    // same sentence about another subject is another decision.
    const rawSubject = (input.metadata as { subject?: unknown } | undefined)?.subject;
    const subject = typeof rawSubject === "string" ? rawSubject : null;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      await lockIdentity(tx, [
        "decision",
        input.workspaceId,
        input.kind,
        input.title,
        input.body,
        scopeOwner,
        scopeRef,
        sensitivity,
        subject,
      ]);

      const t = schema.decisionTable;
      const existing = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.workspaceId, input.workspaceId),
            eq(t.status, "active"),
            isNull(t.validTo),
            eq(t.kind, input.kind),
            eq(t.title, input.title),
            eq(t.body, input.body),
            eq(t.scopeOwner, scopeOwner),
            scopeRef === null ? isNull(t.scopeRef) : eq(t.scopeRef, scopeRef),
            eq(t.sensitivity, sensitivity),
            subject === null
              ? sql`${t.metadata}->>'subject' IS NULL`
              : sql`${t.metadata}->>'subject' = ${subject}`
          )
        )
        .orderBy(t.createdAt)
        .limit(1);
      if (existing[0]) return { decision: mapRowToDecision(existing[0]), reused: true };

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(t)
        .values({
          id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
          conversationId: input.conversationId,
          scopeOwner,
          scopeRef: input.scopeRef,
          kind: input.kind,
          title: input.title,
          body: input.body,
          topicKey: input.topicKey,
          revisionCount: 1,
          normalizedHash: simpleHash(`${input.kind}:${input.title}:${input.body}`),
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
        payload: {
          id,
          kind: "decision",
          text: projectPrimitiveText("decision", { title: input.title, body: input.body }),
        },
      });
      return { decision: mapRowToDecision(rows[0]!), reused: false };
    });
  }

  async createStrategyUnlessDuplicate(
    input: CreateStrategyInput
  ): Promise<{ strategy: MnemoStrategy; reused: boolean }> {
    if (input.supersedesId) {
      // Superseding is a lifecycle transition with its own locking
      // (KnowledgeRepository.createStrategy); never a dedup candidate.
      throw new Error("createStrategyUnlessDuplicate: supersedesId is not supported");
    }
    const scopeOwner = input.scopeOwner ?? `workspace:${input.workspaceId}`;
    const scopeRef = input.scopeRef ?? null;
    const sensitivity = input.sensitivity ?? "internal";
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      await lockIdentity(tx, [
        "strategy",
        input.workspaceId,
        input.trigger,
        input.action,
        scopeOwner,
        scopeRef,
        sensitivity,
      ]);

      const t = schema.strategyTable;
      const existing = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.workspaceId, input.workspaceId),
            eq(t.status, "active"),
            isNull(t.validTo),
            eq(t.trigger, input.trigger),
            eq(t.action, input.action),
            eq(t.scopeOwner, scopeOwner),
            scopeRef === null ? isNull(t.scopeRef) : eq(t.scopeRef, scopeRef),
            eq(t.sensitivity, sensitivity)
          )
        )
        .orderBy(t.createdAt)
        .limit(1);
      if (existing[0]) return { strategy: mapRowToStrategy(existing[0]), reused: true };

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(t)
        .values({
          id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
          scopeOwner,
          scopeRef: input.scopeRef,
          trigger: input.trigger,
          action: input.action,
          context: input.context,
          relatedFacts: input.relatedFacts ?? [],
          attribution: input.attribution ?? "inferred",
          validFrom: input.validFrom ?? dbNow(),
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();
      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: {
          id,
          kind: "strategy",
          text: projectPrimitiveText("strategy", { trigger: input.trigger, action: input.action }),
        },
      });
      return { strategy: mapRowToStrategy(rows[0]!), reused: false };
    });
  }
}
