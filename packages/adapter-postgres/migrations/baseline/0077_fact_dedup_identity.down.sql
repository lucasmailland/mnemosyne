-- migrate:no-transaction
--
-- Reverts 0077_fact_dedup_identity.sql. The narrower index cannot be rebuilt
-- while two live rows share (workspace, scope, scopeRef, subject, statement)
-- under different owners or tiers; the build fails on such data and the wider
-- index stays in place.
DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_fact
    WHERE status = 'active' AND valid_to IS NULL
    GROUP BY workspace_id, scope, COALESCE(scope_ref, ''), subject, md5(statement)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0077 down: live facts share a statement under different owners or tiers; the narrower unique index cannot be rebuilt. Close the extra rows first.';
  END IF;
END
$check$;

DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.uniq_mnemo_fact_dedup_prev;
CREATE UNIQUE INDEX CONCURRENTLY uniq_mnemo_fact_dedup_prev
  ON mnemosyne.mnemo_fact USING btree (workspace_id, scope, COALESCE(scope_ref, ''::text), subject, md5(statement))
  WHERE ((status = 'active'::text) AND (valid_to IS NULL));

DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.uniq_mnemo_fact_dedup;
ALTER INDEX mnemosyne.uniq_mnemo_fact_dedup_prev RENAME TO uniq_mnemo_fact_dedup;
