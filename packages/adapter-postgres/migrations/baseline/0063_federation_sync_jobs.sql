-- Migration 0063: federation sync jobs survive a restart.
--
-- POST /memory/federation/sync answers 202 with a job id and pulls in the
-- background; GET /memory/federation/sync/:jobId reads the job. The server kept
-- those jobs in memory (InMemoryJobStore), so a restart forgot them and every
-- poll after it answered 404. This table holds what SyncJob holds.
--
-- A job belongs to the workspace that started it: RLS + FORCE keyed to the
-- mnemosyne.workspace_id GUC, which DrizzleSyncJobStore sets with
-- set_config(..., true) inside its own transaction. A job of another workspace
-- is invisible, even with its id.
--
-- heartbeat_at is bumped by the process running the job. A pending or running
-- job whose heartbeat stopped (the process died) reads as failed instead of
-- staying "running" forever; see DrizzleSyncJobStore.
--
-- DEPLOYMENT ORDER. Before the server code that reads this table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE mnemosyne.mnemo_federation_sync_job (
    id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    workspace_id text NOT NULL,
    peer_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    outcome jsonb,
    error text
);

ALTER TABLE mnemosyne.mnemo_federation_sync_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_federation_sync_job FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_federation_sync_job_ws ON mnemosyne.mnemo_federation_sync_job FOR ALL
    USING (workspace_id = current_setting('mnemosyne.workspace_id', true))
    WITH CHECK (workspace_id = current_setting('mnemosyne.workspace_id', true));

-- TRUNCATE skips RLS, so the app roles never get it.
REVOKE ALL ON TABLE mnemosyne.mnemo_federation_sync_job FROM PUBLIC;
REVOKE TRUNCATE ON TABLE mnemosyne.mnemo_federation_sync_job FROM app_user, mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_federation_sync_job TO app_user, mnemo_app_role;
