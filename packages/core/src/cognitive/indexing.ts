// Port-only shared indexing helper (make-primitives-recallable, design.md D1).
//
// `projectPrimitiveText` is a pure function over the registry in
// `@mnemo-ai/types`. `enqueuePrimitiveIndex` is the one place `remember()`'s
// non-fact write path appends its `vector_upsert` outbox entry from, for
// kinds whose repository does NOT already enqueue one in-transaction.
//
// Core holds no transaction handle across `storage.*` calls — only the
// repository does. Kinds in RECALLABLE_KINDS (fact, decision) already get an
// in-transaction outbox row from their own repository method
// (FactRepository.createFact, DecisionRepository.createDecision /
// mergeDecisionByTopicKey); calling this helper for those kinds would
// double-enqueue against that existing entry, not strengthen the guarantee.
//
// Zero drizzle/pg/redis import (S9, `v3-purity.test.ts`).

import {
  PRIMITIVE_TEXT_PROJECTION,
  type PrimitiveKind,
  type RecallableKind,
} from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";

/**
 * Pure — joins a recallable kind's declared fields (PRIMITIVE_TEXT_PROJECTION)
 * out of `row` into one text blob using the registry's separator. A missing
 * or non-string field is skipped, never emitted as the literal string
 * `"undefined"`.
 */
// P65: the implementation moved to @mnemo-ai/types, next to the registry it
// reads, so the in-memory adapter in types/testing can use it too. Re-exported
// here because core is where every existing caller imports it from.
export { projectPrimitiveText } from "@mnemo-ai/types";

export interface EnqueuePrimitiveIndexParams {
  workspaceId: string;
  id: string;
  kind: PrimitiveKind;
  /** Precomputed vector — used when the caller already embedded the content. */
  vector?: number[];
  /** Text-form payload — OutboxWorker embeds it on drain (CRIT-05). */
  text?: string;
  revision?: number;
  model?: string;
}

/**
 * Appends one `vector_upsert` outbox entry — vector-form (`vector`) or
 * text-form (`text`); `OutboxWorker.processVectorUpsert` already accepts
 * both shapes. Does NOT open a transaction: this is a best-effort append
 * from `remember()`'s request path, exactly mirroring the block it replaces
 * (`remember.ts` Step 6, pre-PR1).
 */
export async function enqueuePrimitiveIndex(
  ctx: CoreContext,
  params: EnqueuePrimitiveIndexParams
): Promise<void> {
  const { workspaceId, id, kind, vector, text, revision, model } = params;
  await ctx.storage.appendOutbox({
    workspaceId,
    eventType: "vector_upsert",
    payload: {
      id,
      kind,
      ...(vector !== undefined ? { vector } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(revision !== undefined ? { revision } : {}),
      ...(model !== undefined ? { model } : {}),
    },
  });
}
