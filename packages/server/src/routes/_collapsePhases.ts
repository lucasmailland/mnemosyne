/**
 * §Idempotency RDD9 (lines 3954-3968): multi-phase recovery-point orchestration
 * for the session-collapse mutation. Kept as a tiny pure helper so it is unit
 * testable in isolation and so the route handler stays declarative.
 *
 * Phases (spec vocabulary):
 *   session_locked  — recorded BEFORE the core call (local bookkeeping boundary;
 *                     collapseSession's first act is to load+lock the session).
 *   llm_called      — recorded AFTER the core call returns (the LLM step is
 *                     inside collapseSession; success implies it ran).
 *   facts_persisted — recorded AFTER the core call returns (collapse persists
 *                     knowledge units before returning).
 *
 * Resume semantics: if a retried request already reached 'facts_persisted' or
 * 'completed', the durable work is done — we short-circuit WITHOUT re-invoking
 * collapseSession. The middleware will still replay the stored response if one
 * exists; if the original crashed after facts_persisted but before the response
 * was stored, we return resumed=true and the route emits a 202 resume marker.
 *
 * We deliberately do NOT re-enter collapseSession to "continue" from
 * llm_called: collapseSession is internally re-runnable (its persist step is
 * topic-key-deduped, RDD-4), so the only states worth short-circuiting are the
 * post-persist ones. Anything earlier safely re-runs the whole pipeline.
 */
import type { RecoveryPoint } from "../idempotency.js";

export interface CollapseWithPhasesInput<T> {
  /** Recovery point this request resumed from; undefined for unkeyed requests. */
  startRecoveryPoint: RecoveryPoint | undefined;
  /** Phase recorder from the idempotency middleware; undefined for unkeyed requests. */
  recordPhase: ((phase: RecoveryPoint) => Promise<void>) | undefined;
  /** Invokes core.collapseSession(...). */
  runCollapse: () => Promise<T>;
}

export interface CollapseWithPhasesOutput<T> {
  /** True when the op short-circuited because durable work was already done. */
  resumed: boolean;
  /** The collapse result; undefined when resumed (no re-run). */
  result?: T;
  /** Truthful outcome: resumed (no re-run), skipped/failed (pipeline verdict) or completed. */
  outcome: "completed" | "skipped" | "failed" | "resumed";
}

type Obs = Record<string, unknown>;
const pick = (o: Obs, k: string): string | number | null => {
  const v = o[k];
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? v : null;
};

/**
 * Audit-safe error descriptor. A driver/Drizzle error message embeds the
 * failed SQL WITH its parameters (extracted statements included), so the
 * append-only audit table only ever receives the error class name and a
 * bounded, code-shaped `code` (e.g. a SQLSTATE) found along the cause chain —
 * never a message.
 */
export function sanitizeCollapseError(err: unknown): string | null {
  if (err == null) return null;
  // Symbolic reasons (e.g. "lease_lost") pass through; free text never does.
  if (typeof err === "string") return /^[A-Za-z0-9_.:-]{1,64}$/.test(err) ? err : "Error";
  const name =
    err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : "Error";
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return `${name}:${code}`;
    current = (current as { cause?: unknown }).cause;
  }
  return name;
}

/**
 * Safe session_close/collapse_operation audit detail. Whitelists scalar
 * fields only (never turns/transcript); anything unobserved stays null.
 */
export function buildCollapseAuditDetail(i: {
  operationId: string;
  attempt: number;
  reason: string;
  outcome: CollapseWithPhasesOutput<unknown>["outcome"];
  result?: unknown;
  error?: unknown;
  startedAt: number;
  now?: number;
}): Record<string, unknown> {
  const r = (i.result && typeof i.result === "object" ? i.result : {}) as Obs;
  const counts = r["originCounts"];
  return {
    kind: "collapse_operation",
    operation: i.operationId,
    attempt: i.attempt,
    reason: i.reason,
    status: i.outcome,
    skipReason: i.outcome === "skipped" ? pick(r, "skipReason") : null,
    error: sanitizeCollapseError(i.error),
    model: pick(r, "model"),
    promptVersion: pick(r, "promptVersion"),
    tokens: pick(r, "llmTokensUsed"),
    turns: pick(r, "turnsProcessed"),
    originCounts: counts && typeof counts === "object" ? counts : null,
    durationMs: Math.max(0, (i.now ?? Date.now()) - i.startedAt),
    segment: pick(r, "segment"),
    episodeId: pick(r, "episodeId"),
  };
}

const DONE_POINTS = new Set<RecoveryPoint>(["facts_persisted", "completed"]);

export async function collapseWithPhases<T>(
  input: CollapseWithPhasesInput<T>
): Promise<CollapseWithPhasesOutput<T>> {
  const { startRecoveryPoint, recordPhase, runCollapse } = input;

  // Resume: durable phases already completed on a prior attempt → do not re-run.
  if (startRecoveryPoint && DONE_POINTS.has(startRecoveryPoint)) {
    return { resumed: true, outcome: "resumed" };
  }

  // Phase 1 boundary — mark BEFORE the durable work so a crash is recoverable.
  await recordPhase?.("session_locked");

  const result = await runCollapse();

  // A skipped/failed verdict means no LLM call or persist is claimed.
  const status = (result as { status?: string } | undefined)?.status;
  if (status === "skipped" || status === "failed") {
    return { resumed: false, result, outcome: status };
  }

  // Phases 2 & 3 — the LLM call and persist both live inside collapseSession;
  // a completed return means both completed.
  await recordPhase?.("llm_called");
  await recordPhase?.("facts_persisted");

  return { resumed: false, result, outcome: "completed" };
}
