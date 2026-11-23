-- Migration 0044: mnemo_fact_revision — the prior revisions an in-place edit
-- promised to keep (CHAOS-8).
--
-- PATCH /facts/:id, self_edit append and restore update a fact IN PLACE: the id
-- is stable and `revision_count` goes up. API.md §2.3 says the original is
-- preserved, but nothing kept it — the previous statement was overwritten, and
-- concurrent PATCHes lost revisions outright. FactRepository.updateFact now
-- locks the row and copies the revision it is about to replace into this table
-- in the same transaction.
--
-- Rows hold the STORED values (ciphertext for confidential/restricted facts),
-- so crypto-erasure of the actor DEK covers them. The FK cascades on delete:
-- a hard delete, a purge or a GDPR erasure of the fact removes its history in
-- the same statement, without each path having to know this table exists.
-- Workspace-isolated like every mnemo_* table (ENABLE + FORCE RLS). The app
-- role may only read and append: history is never rewritten.

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_fact_revision (
  fact_id text NOT NULL,
  revision integer NOT NULL,
  workspace_id text NOT NULL,
  statement text NOT NULL,
  subject text NOT NULL,
  kind text NOT NULL,
  confidence real NOT NULL,
  relevance real NOT NULL,
  pinned boolean NOT NULL,
  status text NOT NULL,
  sensitivity text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamp with time zone NOT NULL,
  valid_to timestamp with time zone,
  revision_updated_at timestamp with time zone NOT NULL,
  superseded_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mnemo_fact_revision_pkey PRIMARY KEY (fact_id, revision),
  CONSTRAINT mnemo_fact_revision_fact_fkey
    FOREIGN KEY (fact_id) REFERENCES mnemosyne.mnemo_fact(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mnemo_fact_revision_workspace
  ON mnemosyne.mnemo_fact_revision USING btree (workspace_id);

ALTER TABLE mnemosyne.mnemo_fact_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_fact_revision FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'mnemosyne' AND tablename = 'mnemo_fact_revision'
      AND policyname = 'mnemo_fact_revision_ws'
  ) THEN
    CREATE POLICY mnemo_fact_revision_ws ON mnemosyne.mnemo_fact_revision
      USING ((workspace_id)::uuid = current_setting('mnemosyne.workspace_id', true)::uuid)
      WITH CHECK ((workspace_id)::uuid = current_setting('mnemosyne.workspace_id', true)::uuid);
  END IF;
END
$$;

-- Append-only for the app role. 0038's default privileges hand every new table
-- SELECT, INSERT, UPDATE and DELETE, and a GRANT of SELECT/INSERT does not take
-- the other two away, so they are revoked explicitly. docker/scripts/
-- provision-app-role.mjs re-grants DML on ALL TABLES after every deploy and
-- revokes them again for this table. The FK cascade on a fact's hard delete
-- still removes its history: referential actions run as the table owner.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE mnemosyne.mnemo_fact_revision FROM mnemo_app_role;
GRANT SELECT, INSERT ON TABLE mnemosyne.mnemo_fact_revision TO mnemo_app_role;
