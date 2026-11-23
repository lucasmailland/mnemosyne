-- P64: MnemoReasoning bitemporality — validFrom/validTo, the 9th of 10
-- primitives (mnemo_event stays excluded by design — immutable append-only
-- log, see primitives.ts). This is a real schema change (Q1 = (a): add the
-- fields for real, not just document the omission).
--
-- ============================================================================
-- OPERATIONAL NOTE — LOCKS
--
-- Step 1 (ALTER TABLE ... ADD COLUMN ... DEFAULT now()) takes ACCESS
-- EXCLUSIVE but is catalog-only on Pg11+ (default stored in pg_attribute,
-- no heap rewrite) — a millisecond window, not a real outage risk.
--
-- Steps 2-3 (UPDATE) take ROW EXCLUSIVE: reads are not blocked, concurrent
-- writes to the same rows are. Each touched row leaves one dead tuple —
-- budget autovacuum. mnemo_reasoning is low-volume today (one row per
-- cached chain-of-thought); re-assess before a materially larger table.
--
-- Both UPDATEs are idempotent — re-running changes nothing (asserted by
-- reasoning-bitemporality.integration.test.ts).
--
-- No CONCURRENTLY index is added here (unlike 0005_p18_bitemporality.sql's
-- per-table indexes) — reasoning has no validAt-style caller today, so an
-- index would be pure write amplification (design.md D4). Because there is
-- no CONCURRENTLY step, this migration does NOT need
-- `-- migrate:no-transaction`: it runs inside the runner's transaction and
-- all three statements commit atomically. Forward-only (no .down.sql),
-- per 0029's precedent and the pre-1.0 policy.
-- ============================================================================

ALTER TABLE mnemosyne.mnemo_reasoning
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

-- Backfill 1 (identical pattern to 0005): a pre-existing row became valid
-- when it was written, not when this migration ran.
UPDATE mnemosyne.mnemo_reasoning
   SET valid_from = created_at
 WHERE valid_from != created_at;

-- Backfill 2 (0005 has no equivalent — none of its 5 tables carried an
-- archive marker). updated_at is an APPROXIMATION of the archive instant:
-- every status transition writes it, and an archived/pruned row is
-- terminal. 'quarantined' is excluded on purpose — it is a reversible hold
-- (lifecycleTransition promotes quarantined -> active when worth
-- recovers, cognitive/reasoning.ts), not a close.
UPDATE mnemosyne.mnemo_reasoning
   SET valid_to = GREATEST(updated_at, created_at)
 WHERE valid_to IS NULL
   AND status IN ('archived', 'pruned');
