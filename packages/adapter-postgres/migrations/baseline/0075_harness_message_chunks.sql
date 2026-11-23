-- Staging table for versioned transport fragmentation of harness turn.append
-- messages that exceed HARNESS_MAX_MESSAGE_BYTES (64 KiB). Chunks are staged
-- under workspace RLS and reassembled atomically into mnemo_session_turn once
-- all 0..chunk_count-1 fragments are present.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_harness_message_chunk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  ingestion_event_id uuid NOT NULL,
  source_host text NOT NULL,
  source_client_instance_id text NOT NULL,
  source_session_id text NOT NULL,
  source_generation integer NOT NULL,
  source_message_id text NOT NULL,
  supersedes_source_message_id text,
  role text NOT NULL,
  chunk_index integer NOT NULL,
  chunk_count integer NOT NULL,
  chunk_content_hash text NOT NULL,
  message_content_hash text NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mnemo_harness_message_chunk_source_generation_check CHECK (source_generation BETWEEN 0 AND 2147483647),
  CONSTRAINT mnemo_harness_message_chunk_role_check CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text])),
  CONSTRAINT mnemo_harness_message_chunk_count_check CHECK (chunk_count BETWEEN 2 AND 256),
  CONSTRAINT mnemo_harness_message_chunk_index_check CHECK (chunk_index >= 0 AND chunk_index < chunk_count),
  CONSTRAINT mnemo_harness_message_chunk_session_workspace_fkey
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES mnemosyne.mnemo_session(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT mnemo_harness_message_chunk_event_workspace_fkey
    FOREIGN KEY (workspace_id, ingestion_event_id)
    REFERENCES mnemosyne.mnemo_harness_ingestion_event(workspace_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_message_chunk_unique
  ON mnemosyne.mnemo_harness_message_chunk (
    workspace_id,
    source_host,
    source_client_instance_id,
    source_session_id,
    source_generation,
    source_message_id,
    chunk_index
  );

CREATE INDEX IF NOT EXISTS idx_harness_message_chunk_session
  ON mnemosyne.mnemo_harness_message_chunk (workspace_id, session_id);

ALTER TABLE mnemosyne.mnemo_harness_message_chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_message_chunk FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne'
      AND c.relname = 'mnemo_harness_message_chunk'
      AND p.polname = 'mnemo_harness_message_chunk_ws'
  ) THEN
    CREATE POLICY mnemo_harness_message_chunk_ws
      ON mnemosyne.mnemo_harness_message_chunk
      USING ((workspace_id)::uuid = current_setting('mnemosyne.workspace_id', true)::uuid)
      WITH CHECK ((workspace_id)::uuid = current_setting('mnemosyne.workspace_id', true)::uuid);
  END IF;
END
$$;

REVOKE ALL ON TABLE mnemosyne.mnemo_harness_message_chunk FROM mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_harness_message_chunk TO mnemo_app_role;
