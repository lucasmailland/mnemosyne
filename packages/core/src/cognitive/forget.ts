// TASK-3006: Bitemporal forget — soft close (validTo = now) or hard delete.
// DATA_MODEL.md §3, SECURITY.md §8.
//
// Soft mode: sets validTo = now on the primitive (bitemporal close).
//   The record is still queryable with includeArchived=true.
//   Appends outbox: vector_delete + cache_bust.
//
// Hard mode (Wave X — GDPR erasure, §7 "right to erasure"):
//   Requires KeyScope "memory:hard_delete" (NOT "memory:delete").
//   Sequence (all steps must complete for GDPR compliance):
//     0. appendAuditEntry: action="erasure_initiated", isTerminal=false (P50 D4 —
//        crash-safe forensic marker, unguarded await, BEFORE any destructive step)
//     1. hardDeleteFact (real DELETE from mnemo_fact)
//     2. appendDeletionLog (INSERT into mnemo_deletion_log — resurrection guard)
//     3. destroyActorDek (crypto-erase the actor's DEK; FATAL if missing/fails)
//     4. appendOutbox: vector_delete + cache_bust
//     5. appendAuditEntry: action="hard_delete", isTerminal=true

import type { PrimitiveKind, AuthContext } from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";

export async function forget(
  ctx: CoreContext,
  id: string,
  kind: PrimitiveKind,
  mode: "soft" | "hard",
  auth: AuthContext,
  reason?: string
): Promise<void> {
  const span = ctx.telemetry.startSpan("mnemo.forget", {
    attributes: { id, kind, mode, workspaceId: auth.workspaceId },
  });

  try {
    if (mode === "hard") {
      // Wave X: hard delete requires memory:hard_delete (stricter than memory:delete)
      if (!auth.scopes.includes("memory:hard_delete")) {
        throw Object.assign(new Error("hard delete requires memory:hard_delete scope"), {
          code: "FORBIDDEN",
        });
      }

      // P50 (D4): non-terminal forensic marker recorded BEFORE any destructive
      // step (row deletion or DEK destruction). The whole point of an
      // "initiated" record is that it survives a crash mid-erasure — so this
      // is an unguarded await, NOT the swallow-and-log emitAudit() pattern
      // used by the server-side emitters. If the audit write itself fails,
      // erasure must abort here, while it is still fully reversible, rather
      // than let irreversible data destruction proceed with no forensic
      // trail.
      await ctx.storage.appendAuditEntry({
        workspaceId: auth.workspaceId,
        actorType: auth.actorType,
        actorId: auth.actorId,
        action: "erasure_initiated",
        resourceKind: kind,
        resourceId: id,
        isTerminal: false,
        detail: { userId: auth.userId, gdprErasure: true },
      });

      // GDPR erasure sequence
      // Step 1: Physical row deletion (currently only supported for facts)
      // The deletion log keeps the fact's creation time (0068): federation
      // serves the erasure as a tombstone only to peers that may hold the fact.
      // It comes from the DELETE itself; a read first could miss the row (a
      // ceiling, a filter) that the DELETE still removes.
      let itemCreatedAt: Date | undefined;
      if (kind === "fact") {
        const deleted = await ctx.storage.hardDeleteFact?.(id, auth.workspaceId);
        if (typeof deleted === "object") itemCreatedAt = deleted.createdAt;
      } else {
        // Non-fact kinds: fall back to soft archive (crypto-erasure via DEK)
        await archivePrimitive(ctx, id, kind, auth.workspaceId);
      }

      // Step 2: Deletion log — resurrection guard (INSERT-only table, no RLS)
      await ctx.storage.appendDeletionLog?.({
        workspaceId: auth.workspaceId,
        deletedItemId: id,
        deletedItemType: kind,
        deletionType: "gdpr_erasure",
        actorId: auth.actorId,
        reason: "GDPR Article 17 erasure request",
        ...(itemCreatedAt ? { itemCreatedAt } : {}),
      });

      // Step 3: Crypto-erase the caller's DEK(s). GDPR erasure MUST NOT silently
      // succeed without key destruction — any failure here is fatal so the
      // terminal audit entry (step 5) is never written for a no-op erasure.
      //
      // Prefer the person-scoped path when a real platform user is bound to
      // this key: destroyUserDeks destroys EVERY DEK that person has accrued
      // across every actor_id/key they've used, not just this one credential's
      // — a person holding two API keys previously only ever got ONE of their
      // two DEKs destroyed here, silently leaving the other recoverable. Falls
      // back to the single-credential path exactly as before for service/
      // agent-only keys, where there is no person to erase.
      if (auth.userId) {
        if (typeof ctx.storage.destroyUserDeks !== "function") {
          throw Object.assign(
            new Error(
              "GDPR hard delete: storage adapter does not implement destroyUserDeks; " +
                "cannot crypto-erase — refusing to record erasure as complete"
            ),
            { code: "DEK_DESTROY_UNSUPPORTED" }
          );
        }
        let destroyedCount: number;
        try {
          destroyedCount = await ctx.storage.destroyUserDeks(auth.workspaceId, auth.userId);
        } catch (dekErr) {
          ctx.logger.error("forget: DEK destruction threw — GDPR erasure aborted", {
            workspaceId: auth.workspaceId,
            userId: auth.userId,
            err: dekErr,
          });
          throw Object.assign(
            new Error(
              `GDPR hard delete: DEK destruction failed for user ${auth.userId}: ${
                dekErr instanceof Error ? dekErr.message : String(dekErr)
              }`
            ),
            { code: "DEK_DESTROY_FAILED", cause: dekErr }
          );
        }
        if (destroyedCount === 0) {
          // Fall back to the single-credential path before giving up: a DEK
          // provisioned before migration 0024 has no user_id stamped on it
          // (no backfill was run — see that migration's comments), so
          // destroyUserDeks legitimately finds zero rows for a person whose
          // only DEK predates the migration, even though destroyActorDek
          // would find and destroy it via this key's own actorId. Without
          // this fallback, GDPR erasure would hard-fail for exactly the
          // legacy-DEK case the migration's own comments promise is covered.
          let legacyDestroyed = false;
          if (typeof ctx.storage.destroyActorDek === "function") {
            try {
              legacyDestroyed = await ctx.storage.destroyActorDek(auth.workspaceId, auth.actorId);
            } catch (dekErr) {
              ctx.logger.error(
                "forget: legacy DEK destruction fallback threw — GDPR erasure aborted",
                { workspaceId: auth.workspaceId, actorId: auth.actorId, err: dekErr }
              );
              throw Object.assign(
                new Error(
                  `GDPR hard delete: DEK destruction failed for actor ${auth.actorId}: ${
                    dekErr instanceof Error ? dekErr.message : String(dekErr)
                  }`
                ),
                { code: "DEK_DESTROY_FAILED", cause: dekErr }
              );
            }
          }
          if (!legacyDestroyed) {
            throw Object.assign(
              new Error(
                `GDPR hard delete: DEK destruction reported no keys destroyed for user ${auth.userId} ` +
                  `(workspace ${auth.workspaceId}), and no legacy actor-keyed DEK was found for actor ` +
                  `${auth.actorId} either; refusing to record erasure as complete`
              ),
              { code: "DEK_DESTROY_NOOP" }
            );
          }
        }
      } else {
        if (typeof ctx.storage.destroyActorDek !== "function") {
          throw Object.assign(
            new Error(
              "GDPR hard delete: storage adapter does not implement destroyActorDek; " +
                "cannot crypto-erase — refusing to record erasure as complete"
            ),
            { code: "DEK_DESTROY_UNSUPPORTED" }
          );
        }
        let dekDestroyed: boolean;
        try {
          dekDestroyed = await ctx.storage.destroyActorDek(auth.workspaceId, auth.actorId);
        } catch (dekErr) {
          ctx.logger.error("forget: DEK destruction threw — GDPR erasure aborted", {
            workspaceId: auth.workspaceId,
            actorId: auth.actorId,
            err: dekErr,
          });
          throw Object.assign(
            new Error(
              `GDPR hard delete: DEK destruction failed for actor ${auth.actorId}: ${
                dekErr instanceof Error ? dekErr.message : String(dekErr)
              }`
            ),
            { code: "DEK_DESTROY_FAILED", cause: dekErr }
          );
        }
        if (dekDestroyed === false) {
          throw Object.assign(
            new Error(
              `GDPR hard delete: DEK destruction reported no key destroyed for actor ${auth.actorId} ` +
                `(workspace ${auth.workspaceId}); refusing to record erasure as complete`
            ),
            { code: "DEK_DESTROY_NOOP" }
          );
        }
      }

      // Step 4: Transactional outbox — remove from vector index + bust hot-tier cache
      await ctx.storage.appendOutbox({
        workspaceId: auth.workspaceId,
        eventType: "vector_delete",
        payload: { id, kind },
      });
      await ctx.storage.appendOutbox({
        workspaceId: auth.workspaceId,
        eventType: "cache_bust",
        payload: { pattern: `mnemo:${auth.workspaceId}:hot:*` },
      });

      // Step 5: Terminal audit entry
      await ctx.storage.appendAuditEntry({
        workspaceId: auth.workspaceId,
        actorType: auth.actorType,
        actorId: auth.actorId,
        action: "hard_delete",
        resourceKind: kind,
        resourceId: id,
        isTerminal: true,
        detail: { gdprErasure: true },
      });

      ctx.logger.info("forget: GDPR hard delete completed", {
        id,
        kind,
        workspaceId: auth.workspaceId,
      });

      return;
    }

    // P74: confirm the primitive exists before reporting it archived.
    //
    // Every archive* implementation returns void and no-ops on a missing row,
    // so this path answered "forgotten" for ids that never existed — including
    // the fabricated ones the surprise gate used to hand out. DELETE /facts/:id
    // already probes with getFact and 404s (routes/facts.ts), but the generic
    // DELETE /forget/:kind/:id route came straight here and archived blind: it
    // declares a 404 in its OpenAPI responses that it could never produce.
    //
    // getRecallPrimitives is the one getter that spans every kind (all but
    // hyperedge, which has no archive dispatch entry either). Where an adapter
    // does not implement it we skip rather than fail the delete — but we say so,
    // because an unverifiable delete reported as a successful one is the exact
    // class of silence this item exists to remove.
    if (kind !== "hyperedge") {
      if (typeof ctx.storage.getRecallPrimitives === "function") {
        const found = await ctx.storage.getRecallPrimitives(auth.workspaceId, [{ id, kind }]);
        if (found.length === 0) {
          throw Object.assign(new Error(`${kind} ${id} not found`), { code: "NOT_FOUND" });
        }
      } else {
        ctx.logger.warn(
          "forget: cannot verify primitive exists — adapter lacks getRecallPrimitives",
          {
            id,
            kind,
            workspaceId: auth.workspaceId,
          }
        );
      }
    }

    // PRIM-10 — events are an immutable log: `mnemo_event` has no validity
    // interval and no status, and `archiveEvent` is a documented no-op. This
    // path used to answer `forgotten: true` anyway, while the event — and the
    // fact derived from it — stayed recallable. Refuse, after the existence
    // check (a missing event is still a 404), before writing anything.
    if (kind === "event") {
      throw Object.assign(
        new Error(
          "events are immutable and cannot be forgotten; forget the facts derived from them instead"
        ),
        { code: "EVENT_IMMUTABLE" }
      );
    }

    // Soft mode: bitemporal close (validTo = now)
    const transitioned = await archivePrimitive(ctx, id, kind, auth.workspaceId);
    // PRIM-3: an archive that reports `false` closed nothing — the primitive
    // was already forgotten, or a concurrent forget won the race. Forgetting
    // stays idempotent (the caller is told it is forgotten, which is true),
    // but a no-op must not enqueue a second vector_delete or log a second
    // delete it did not perform. `void` (adapters without the flag) proceeds.
    if (transitioned === false) {
      ctx.logger.info("forget: primitive already closed — nothing to do", {
        id,
        kind,
        workspaceId: auth.workspaceId,
      });
      return;
    }

    // Transactional outbox: remove from vector index + bust hot-tier cache
    await ctx.storage.appendOutbox({
      workspaceId: auth.workspaceId,
      eventType: "vector_delete",
      payload: { id, kind },
    });
    await ctx.storage.appendOutbox({
      workspaceId: auth.workspaceId,
      eventType: "cache_bust",
      payload: { pattern: `mnemo:${auth.workspaceId}:hot:*` },
    });

    // Audit trail
    // FORGET-2: truncate to 200 chars, matching the fact-specific route's
    // reason cap (routes/facts.ts's DELETE /facts/:id) — this is the single
    // call site for every OTHER primitive kind's soft-forget, so the cap
    // belongs here rather than duplicated at each caller.
    const truncatedReason = reason !== undefined ? reason.slice(0, 200) : undefined;
    await ctx.storage.appendAuditEntry({
      workspaceId: auth.workspaceId,
      actorType: auth.actorType,
      actorId: auth.actorId,
      action: "delete",
      resourceKind: kind,
      resourceId: id,
      isTerminal: false,
      ...(truncatedReason ? { detail: { reason: truncatedReason } } : {}),
    });

    ctx.logger.info("forget: primitive soft-archived", {
      id,
      kind,
      mode,
      workspaceId: auth.workspaceId,
    });
  } finally {
    span.end();
  }
}

// ─── Archive dispatcher ───────────────────────────────────────────────────────

async function archivePrimitive(
  ctx: CoreContext,
  id: string,
  kind: PrimitiveKind,
  workspaceId: string
): Promise<boolean | void> {
  switch (kind) {
    case "fact":
      return ctx.storage.archiveFact(id, workspaceId);
    case "decision":
      return ctx.storage.archiveDecision(id, workspaceId);
    case "episode":
      return ctx.storage.archiveEpisode(id, workspaceId);
    case "entity":
      return ctx.storage.archiveEntity(id, workspaceId);
    case "strategy":
      return ctx.storage.archiveStrategy(id, workspaceId);
    case "workflow":
      return ctx.storage.archiveWorkflow(id, workspaceId);
    case "skill":
      return ctx.storage.archiveSkill(id, workspaceId);
    case "task":
      return ctx.storage.archiveTask(id, workspaceId);
    case "event":
      return ctx.storage.archiveEvent(id, workspaceId);
    case "reasoning":
      return ctx.storage.archiveReasoning(id, workspaceId);
    case "hyperedge":
      return ctx.storage.archiveHyperedge(id, workspaceId);
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown kind: ${_exhaustive}`);
    }
  }
}
