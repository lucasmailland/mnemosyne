-- Migration 0067: agent policy changes reach every replica without Redis.
--
-- Each replica caches agent policies for 60 s (middleware/rbac-policy.ts). A
-- write drops the entry on the replica that took it and, with Redis, on the
-- others through pub/sub; without Redis the others kept the old policy for up
-- to a minute. LISTEN/NOTIFY does not survive pgBouncer in transaction mode, so
-- the replicas poll this table instead.
--
-- * mnemo_access_policy_change: one row per insert, update or delete of
--   mnemo_access_policy, written by a trigger in the same transaction as the
--   policy, so a committed policy always has its row and a rolled-back one never
--   does. RLS + FORCE per workspace like the policy itself.
-- * mnemo_access_policy_changes(after_seq): what a replica polls every second.
--   Rows after its cursor, plus the last 10 s again: a sequence value is taken
--   at insert and the row shows at commit, so a concurrent writer can commit a
--   lower seq after a higher one was read. Returns ids only, no policy content.
-- * mnemo_purge_access_policy_changes(): drops rows older than an hour (the
--   cron job mnemo.policy.change.purge, one replica per run). Anything
--   older is past every cache's TTL.
--
-- Both functions run as the migration owner (which must bypass RLS, as for
-- 0041): the poll has no workspace to set the GUC to.
--
-- DEPLOYMENT ORDER. Before the server code that polls. An older server ignores
-- the table; the trigger only adds a row per policy write.
SET LOCAL lock_timeout = '5s';

CREATE TABLE mnemosyne.mnemo_access_policy_change (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL,
    agent_id text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mnemo_access_policy_change_changed_at_idx
    ON mnemosyne.mnemo_access_policy_change (changed_at);

ALTER TABLE mnemosyne.mnemo_access_policy_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_access_policy_change FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_access_policy_change_ws ON mnemosyne.mnemo_access_policy_change FOR ALL
    USING (workspace_id = current_setting('mnemosyne.workspace_id', true))
    WITH CHECK (workspace_id = current_setting('mnemosyne.workspace_id', true));

-- TRUNCATE skips RLS, so the app roles never get it.
REVOKE ALL ON TABLE mnemosyne.mnemo_access_policy_change FROM PUBLIC;
REVOKE TRUNCATE ON TABLE mnemosyne.mnemo_access_policy_change FROM app_user, mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_access_policy_change TO app_user, mnemo_app_role;

-- Runs as the writer, under the GUC the policy write already set.
CREATE FUNCTION mnemosyne.mnemo_access_policy_changed()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO mnemosyne.mnemo_access_policy_change (workspace_id, agent_id)
    VALUES (OLD.workspace_id, OLD.agent_id);
  ELSE
    INSERT INTO mnemosyne.mnemo_access_policy_change (workspace_id, agent_id)
    VALUES (NEW.workspace_id, NEW.agent_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER mnemo_access_policy_changed
    AFTER INSERT OR UPDATE OR DELETE ON mnemosyne.mnemo_access_policy
    FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_access_policy_changed();

CREATE FUNCTION mnemosyne.mnemo_access_policy_changes(after_seq bigint)
    RETURNS TABLE (seq bigint, workspace_id text, agent_id text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
  SELECT c.seq, c.workspace_id, c.agent_id
  FROM mnemosyne.mnemo_access_policy_change c
  WHERE c.seq > after_seq OR c.changed_at > now() - interval '10 seconds'
  ORDER BY c.seq;
$$;

CREATE FUNCTION mnemosyne.mnemo_purge_access_policy_changes()
    RETURNS integer
    LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
  WITH gone AS (
    DELETE FROM mnemosyne.mnemo_access_policy_change
    WHERE changed_at < now() - interval '1 hour'
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone;
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_access_policy_changes(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_purge_access_policy_changes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_access_policy_changes(bigint) TO app_user, mnemo_app_role;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_purge_access_policy_changes() TO app_user, mnemo_app_role;
