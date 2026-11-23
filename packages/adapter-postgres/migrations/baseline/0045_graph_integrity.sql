-- migrate:no-transaction
-- Migration 0045: graph and primitive integrity (WP-6).
--
-- 1. mnemo_entity: the (workspace_id, name, kind) uniqueness covered CLOSED
--    rows too, so closing an entity (unlink, reassignment, forget) kept its
--    name reserved forever. Uniqueness only makes sense for LIVE rows. The
--    partial index is built CONCURRENTLY (writes keep flowing) BEFORE the old
--    constraint is dropped, and it cannot fail on existing data: the old
--    constraint is strictly stronger.
--
-- 2. mnemo_relation: endpoints may be any of the ten non-hyperedge primitive
--    kinds (it was fact/decision/entity/episode only). The verb vocabulary is
--    untouched. An OPEN relation cannot link a node to itself; open self-loops
--    older clients wrote are closed here, and closed ones stay as history.
--
-- ONLINE SAFETY. This file runs outside a transaction, one statement at a
-- time. The only statements that take a strong lock are the catalog-only
-- ALTER TABLE ... DROP/ADD CONSTRAINT (all constraints are added NOT VALID, so
-- there is no table scan under the lock), each guarded by a short lock_timeout
-- so a long-running transaction makes the migration fail fast instead of
-- queueing every writer behind it. Validation runs afterwards under
-- SHARE UPDATE EXCLUSIVE, which does not block reads or writes. Every step is
-- idempotent, so a timed-out run is simply re-run.
--
-- DEPLOYMENT ORDER. Run this migration BEFORE the new server code. Old code on
-- the new schema is fine (the constraints are looser or equal for it, except
-- that it can no longer open a self-loop, which it never did on purpose); new
-- code on the old schema only misses the new kinds and the name reuse. If the
-- CONCURRENTLY build is interrupted it leaves an INVALID index: re-running the
-- file drops and rebuilds it.

SET lock_timeout = '5s';

DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.uq_mnemo_entity_live_name_kind;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_mnemo_entity_live_name_kind
  ON mnemosyne.mnemo_entity (workspace_id, name, kind)
  WHERE valid_to IS NULL;

ALTER TABLE mnemosyne.mnemo_entity
  DROP CONSTRAINT IF EXISTS mnemo_entity_workspace_id_name_kind_key;

-- Close open self-loops first (touches only the offending rows), so the CHECK
-- below is satisfiable by every existing row and an old loop can still be
-- retracted with a plain valid_to update.
UPDATE mnemosyne.mnemo_relation
   SET valid_to = now()
 WHERE source_kind = target_kind
   AND source_id = target_id
   AND valid_to IS NULL;

ALTER TABLE mnemosyne.mnemo_relation
  DROP CONSTRAINT IF EXISTS mnemo_relation_source_kind_check,
  DROP CONSTRAINT IF EXISTS mnemo_relation_target_kind_check,
  DROP CONSTRAINT IF EXISTS mnemo_relation_no_self_loop,
  ADD CONSTRAINT mnemo_relation_source_kind_check CHECK (source_kind = ANY (ARRAY[
    'fact'::text, 'decision'::text, 'entity'::text, 'episode'::text, 'strategy'::text,
    'workflow'::text, 'skill'::text, 'task'::text, 'event'::text, 'reasoning'::text])) NOT VALID,
  ADD CONSTRAINT mnemo_relation_target_kind_check CHECK (target_kind = ANY (ARRAY[
    'fact'::text, 'decision'::text, 'entity'::text, 'episode'::text, 'strategy'::text,
    'workflow'::text, 'skill'::text, 'task'::text, 'event'::text, 'reasoning'::text])) NOT VALID,
  ADD CONSTRAINT mnemo_relation_no_self_loop
    CHECK (NOT (source_kind = target_kind AND source_id = target_id) OR valid_to IS NOT NULL) NOT VALID;

ALTER TABLE mnemosyne.mnemo_relation VALIDATE CONSTRAINT mnemo_relation_source_kind_check;

ALTER TABLE mnemosyne.mnemo_relation VALIDATE CONSTRAINT mnemo_relation_target_kind_check;

ALTER TABLE mnemosyne.mnemo_relation VALIDATE CONSTRAINT mnemo_relation_no_self_loop;

RESET lock_timeout;
