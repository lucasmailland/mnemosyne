-- migrate:unique-checked reason=widens-the-existing-unique-key-with-two-more-columns-so-no-current-row-can-violate-it
-- migrate:no-transaction
--
-- Migration 0077: owner and sensitivity are part of a fact's dedup key
-- (APP-009, audit 2026-11-22).
--
-- uniq_mnemo_fact_dedup allowed one live row per (workspace, scope, scopeRef,
-- subject, statement). The same sentence owned by another user, or kept at
-- another sensitivity tier, is a different fact: two users' identical personal
-- preference collided, and the write that lost the collision was answered with
-- the other row's id.
--
-- Adding columns to a unique index only relaxes it, so no existing row can
-- violate the new one. Built CONCURRENTLY under a temporary name, then swapped
-- in under the old name, which the code matches on (remember.ts, collapse.ts).
-- Outside a transaction every statement must be safe to rerun: an interrupted
-- build leaves an INVALID index that is dropped first, and a rerun after the
-- rename rebuilds and swaps again.
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.uniq_mnemo_fact_dedup_next;
CREATE UNIQUE INDEX CONCURRENTLY uniq_mnemo_fact_dedup_next
  ON mnemosyne.mnemo_fact USING btree (
    workspace_id,
    scope,
    COALESCE(scope_ref, ''::text),
    COALESCE(scope_owner, ''::text),
    sensitivity,
    subject,
    md5(statement)
  )
  WHERE ((status = 'active'::text) AND (valid_to IS NULL));

DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.uniq_mnemo_fact_dedup;
ALTER INDEX mnemosyne.uniq_mnemo_fact_dedup_next RENAME TO uniq_mnemo_fact_dedup;
