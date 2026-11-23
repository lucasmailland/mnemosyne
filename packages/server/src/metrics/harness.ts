import { Gauge } from "./index.js";

/**
 * Managed lifecycle metrics.
 *
 * Every series here is rebuilt from a storage aggregate on each scrape, never
 * accumulated from process-local transitions. A counter incremented in-process
 * reports what THIS replica happened to observe since IT started, which after a
 * restart or behind a second replica is not the state of the system — and these
 * numbers are the ones an operator uses to decide whether capture is healthy.
 */

/**
 * Bounded label values. Anything else is folded into "other".
 *
 * Label values become Prometheus time series, so an unbounded one — a workspace
 * id, a session id, a raw error string — turns one metric into unboundedly many
 * and takes the scrape down with it. Whitelisting is also why no identifier can
 * leak into metrics: there is no path for an arbitrary string to become a label.
 */
export const ARCHIVE_REASON_LABELS = [
  "empty_session",
  "incomplete_exchange",
  "too_few_turns",
  "low_recurrence_signal",
  "no_pin",
  "other",
] as const;

export const EXTRACTION_RESULT_LABELS = ["succeeded", "failed", "not_attempted", "other"] as const;

export type ArchiveReasonLabel = (typeof ARCHIVE_REASON_LABELS)[number];
export type ExtractionResultLabel = (typeof EXTRACTION_RESULT_LABELS)[number];

function bounded<T extends string>(allowed: readonly T[], value: string): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : ("other" as T);
}

export interface ManagedLifecycleStats {
  active: number;
  pending: number;
  collapsed: number;
  archivedByReason: Array<{ reason: string; count: number }>;
  /** Sessions grouped by how many collapse attempts they have taken. */
  retryBuckets: Array<{ bucket: string; count: number }>;
  /** Age of the oldest session still waiting to collapse, or null when none is. */
  oldestPendingAgeSeconds: number | null;
  /** Sessions grouped by captured message count. */
  messageCountBuckets: Array<{ bucket: string; count: number }>;
  extraction: Array<{ result: string; count: number }>;
  /** Sessions whose capture is known to be missing messages. */
  incompleteCapture: number;
}

export const harnessGauges = {
  sessions: new Gauge(
    "mnemo_managed_sessions",
    "Managed sessions by lifecycle state, read from storage on each scrape"
  ),
  archived: new Gauge(
    "mnemo_managed_sessions_archived",
    "Managed sessions archived without knowledge, by bounded reason"
  ),
  retries: new Gauge(
    "mnemo_managed_collapse_retries",
    "Managed sessions by collapse attempt count"
  ),
  oldestPendingAge: new Gauge(
    "mnemo_managed_oldest_pending_age_seconds",
    "Age of the oldest managed session still awaiting collapse"
  ),
  messageCounts: new Gauge(
    "mnemo_managed_session_messages",
    "Managed sessions by captured message-count bucket"
  ),
  extraction: new Gauge(
    "mnemo_managed_extraction",
    "Terminal managed extraction attempts by bounded result"
  ),
  extractionSuccessRate: new Gauge(
    "mnemo_managed_extraction_success_rate",
    "Successful extractions over all terminal extraction attempts in the snapshot window"
  ),
  incompleteCapture: new Gauge(
    "mnemo_managed_incomplete_capture",
    "Managed sessions whose capture is known to be missing messages"
  ),
} as const;

/**
 * Successful extractions over all TERMINAL extraction attempts.
 *
 * Sessions that never attempted extraction are excluded on purpose. An archive
 * that happened before extraction ran is not a failed extraction, and counting
 * it would make this rate track archive volume instead of extraction quality —
 * it would fall simply because more empty sessions were captured.
 *
 * Zero when nothing has been attempted: a rate over an empty denominator is not
 * "perfect", and reporting 1 there would silence the very alert that matters on
 * a freshly enabled host.
 */
export function extractionSuccessRate(
  extraction: ReadonlyArray<{ result: string; count: number }>
): number {
  let succeeded = 0;
  let attempted = 0;
  for (const { result, count } of extraction) {
    const label = bounded(EXTRACTION_RESULT_LABELS, result);
    if (label === "not_attempted") continue;
    attempted += count;
    if (label === "succeeded") succeeded += count;
  }
  return attempted === 0 ? 0 : succeeded / attempted;
}

/** Sum counts per bounded label so folding into "other" never loses a session. */
function foldByLabel<T extends string>(
  allowed: readonly T[],
  rows: ReadonlyArray<{ count: number } & Record<string, unknown>>,
  field: string
): Map<T, number> {
  const totals = new Map<T, number>();
  for (const row of rows) {
    const label = bounded(allowed, String(row[field] ?? ""));
    totals.set(label, (totals.get(label) ?? 0) + row.count);
  }
  return totals;
}

/**
 * Rebuild every managed gauge from one storage snapshot.
 *
 * Each gauge is cleared first, so a label the snapshot no longer contains stops
 * being published instead of freezing at its last value.
 */
export function applyManagedLifecycleStats(stats: ManagedLifecycleStats): void {
  for (const gauge of Object.values(harnessGauges)) gauge.clear();

  harnessGauges.sessions.set({ state: "active" }, stats.active);
  harnessGauges.sessions.set({ state: "collapse_pending" }, stats.pending);
  harnessGauges.sessions.set({ state: "collapsed" }, stats.collapsed);

  for (const [reason, count] of foldByLabel(
    ARCHIVE_REASON_LABELS,
    stats.archivedByReason,
    "reason"
  )) {
    harnessGauges.archived.set({ reason }, count);
  }
  for (const { bucket, count } of stats.retryBuckets) {
    harnessGauges.retries.set({ attempts: bucket }, count);
  }
  for (const { bucket, count } of stats.messageCountBuckets) {
    harnessGauges.messageCounts.set({ le: bucket }, count);
  }
  for (const [result, count] of foldByLabel(EXTRACTION_RESULT_LABELS, stats.extraction, "result")) {
    harnessGauges.extraction.set({ result }, count);
  }

  harnessGauges.extractionSuccessRate.set({}, extractionSuccessRate(stats.extraction));
  harnessGauges.incompleteCapture.set({}, stats.incompleteCapture);
  // Only published when something is actually pending: an absent series is
  // honest about "nothing is waiting", where 0 reads as "waiting, for no time".
  if (stats.oldestPendingAgeSeconds !== null) {
    harnessGauges.oldestPendingAge.set({}, stats.oldestPendingAgeSeconds);
  }
}
