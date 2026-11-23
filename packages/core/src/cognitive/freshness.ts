// packages/core/src/cognitive/freshness.ts
//
// topicKey-suggest-and-hit-freshness slice (c) — pure, deterministic bucketing
// of a single RecallHit's valid-time (`validFrom`) into a staleness label.
// No I/O, no LLM call. See
// docs/archive/openspec/topickey-suggest-and-hit-freshness/design.md D5/D6 for the
// placement rationale (stamped once inside recall-cold.ts's `buildResponse`).
//
// Thresholds mirror `mv_confidence_map`'s CASE expression (baseline
// migration 0001_v3_complete_baseline.sql:2424-2427) — `current` <7d,
// `recent` <30d, `aging` <90d, else `stale` — but that view buckets
// `max(created_at)` (transaction-time) across a group of facts, while this
// function buckets one primitive's own `validFrom` (valid-time). Same
// thresholds by design; different axis, different question. Do not conflate
// with `SelfModel.confidenceMap[].freshness` (metacognition.ts).

import type { HitFreshness } from "@mnemo-ai/types";

/** Threshold days, exported so tests/consumers don't hardcode the boundaries. */
export const HIT_FRESHNESS_DAYS = {
  current: 7,
  recent: 30,
  aging: 90,
} as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Buckets `validFrom` relative to `now` (default: `Date.now()`, injectable
 * for deterministic tests). Strict `<` thresholds, mirroring the SQL's
 * `max(created_at) > (now() - interval)` shape (strict inequality — a hit
 * exactly at the boundary falls into the next, staler bucket).
 *
 * Fail-conservative edge cases:
 * - A `validFrom` in the future (age < 0) is treated as "current" — it's
 *   the freshest possible state, not an error condition.
 * - An invalid/unparseable `validFrom` (age is `NaN`) degrades to "stale" —
 *   the safest assumption when staleness can't be computed at all.
 */
export function hitFreshness(
  validFrom: Date | string,
  now: number | Date = Date.now()
): HitFreshness {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const validFromMs =
    validFrom instanceof Date ? validFrom.getTime() : new Date(validFrom).getTime();
  const ageMs = nowMs - validFromMs;

  if (Number.isNaN(ageMs)) return "stale";
  if (ageMs < 0) return "current";

  const ageDays = ageMs / MS_PER_DAY;
  if (ageDays < HIT_FRESHNESS_DAYS.current) return "current";
  if (ageDays < HIT_FRESHNESS_DAYS.recent) return "recent";
  if (ageDays < HIT_FRESHNESS_DAYS.aging) return "aging";
  return "stale";
}
