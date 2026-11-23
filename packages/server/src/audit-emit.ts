/**
 * p50-audit-log-emitters — swallow-and-log audit emitter helper.
 *
 * Every route-level audit emission added by PR2-6 goes through this helper
 * instead of calling `deps.storage.appendAuditEntry(...)` directly. Design D1:
 * all 10 server emissions happen AFTER the mutation already committed in a
 * separate tx, so a Merkle-lock failure on the audit write must never turn a
 * 200/201 into a 500. Frequency is low enough that we still `await` (unlike
 * the hot-path `setImmediate` fire-and-forget used by recall.ts) — that keeps
 * ordering deterministic and the call testable, while `.catch()` ensures a
 * rejected write never propagates to the caller.
 *
 * Core-side emitters (self-edit.ts, forget.ts) intentionally do NOT use this
 * helper — they keep the existing inline unguarded `await
 * ctx.storage.appendAuditEntry(...)` convention (forget.ts's
 * `erasure_initiated` in particular is a deliberate unguarded-await exception:
 * a failed write there must abort erasure while it is still reversible).
 * `emitAudit` is server-route-only.
 */
import type { AuditLogEntry } from "@mnemo-ai/types";
import type { ServerDeps } from "./deps.js";
import { logger } from "./logging.js";

export async function emitAudit(
  deps: Pick<ServerDeps, "storage">,
  entry: Omit<AuditLogEntry, "id" | "createdAt">
): Promise<void> {
  if (typeof deps.storage?.appendAuditEntry !== "function") return;

  // try/await (not .catch on the returned promise): a synchronous throw from the
  // adapter must not escape either — callers emit from `finally` blocks and a
  // throw there would mask the real outcome or turn a 2xx into a 500.
  try {
    await deps.storage.appendAuditEntry(entry);
  } catch (err: unknown) {
    logger.warn(
      {
        err,
        action: entry.action,
        workspaceId: entry.workspaceId,
        resourceKind: entry.resourceKind,
      },
      "audit_emit.failed"
    );
  }
}

export type SubtypeState = "absent" | "invalid" | "explicit-other" | "valid";

/** Append-only /remember subtype-normalization record (no statement text). */
export function emitWriterNormalizationAudit(
  deps: Pick<ServerDeps, "storage">,
  e: Pick<AuditLogEntry, "workspaceId" | "actorType" | "actorId" | "resourceKind" | "resourceId">,
  detail: {
    subtypeState: SubtypeState;
    receivedSubtype: string | null;
    storedSubtype: string | null;
    warningCode: string | null;
    writerVersion: string;
  }
): Promise<void> {
  return emitAudit(deps, {
    ...e,
    action: "create",
    isTerminal: false,
    detail: { event: "writer_normalization", ...detail },
  });
}
