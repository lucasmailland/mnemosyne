-- migrate:allow-type-change reason=memory_id uuid->text must hold prefixed non-fact ids (mepi_...); mnemo_recall_log is an append-only telemetry log and the rewrite runs under lock_timeout
-- Migration 0071: recall observability.
-- mnemo_recall_request: one row per recall request. mnemo_recall_log gains
-- request_id/primitive_kind; memory_id becomes text (prefixed ids such as mepi_...);
-- fact_id becomes nullable (non-fact kinds). Historical rows get NO synthesized
-- request or rank: only kind=fact / memory_id=fact_id is backfilled.
SET LOCAL lock_timeout = '5s';

CREATE TABLE mnemosyne.mnemo_recall_request (
    workspace_id uuid NOT NULL,
    request_id text NOT NULL,
    request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    query_hash text,
    status text NOT NULL DEFAULT 'ok',
    duration_ms integer,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT mnemo_recall_request_pkey PRIMARY KEY (workspace_id, request_id)
);

ALTER TABLE mnemosyne.mnemo_recall_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_recall_request FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_recall_request_ws ON mnemosyne.mnemo_recall_request
    USING (workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid)
    WITH CHECK (workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_recall_request TO mnemo_app_role;
GRANT SELECT,INSERT ON TABLE mnemosyne.mnemo_recall_request TO mnemo_owner;

DROP INDEX IF EXISTS mnemosyne.idx_mnemo_recall_log_memory_time;
ALTER TABLE mnemosyne.mnemo_recall_log
    ALTER COLUMN memory_id TYPE text USING memory_id::text,
    ALTER COLUMN fact_id DROP NOT NULL,
    ADD COLUMN request_id text,
    ADD COLUMN primitive_kind text;

UPDATE mnemosyne.mnemo_recall_log
   SET primitive_kind = 'fact', memory_id = fact_id
 WHERE fact_id IS NOT NULL;

CREATE INDEX idx_mnemo_recall_log_memory_time ON mnemosyne.mnemo_recall_log
    USING btree (workspace_id, memory_id, recalled_at DESC) WHERE (memory_id IS NOT NULL);
ALTER TABLE mnemosyne.mnemo_recall_log
    ADD CONSTRAINT mnemo_recall_log_request_fkey FOREIGN KEY (workspace_id, request_id)
    REFERENCES mnemosyne.mnemo_recall_request (workspace_id, request_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX uq_mnemo_recall_log_request_rank ON mnemosyne.mnemo_recall_log
    USING btree (workspace_id, request_id, hit_rank)
    WHERE (request_id IS NOT NULL AND hit_rank IS NOT NULL);
