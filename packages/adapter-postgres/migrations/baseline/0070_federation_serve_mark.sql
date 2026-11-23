-- Migration 0070: what this server has served each peer.
--
-- GET /memory/federation/items sends a tombstone (forgotten, merged or deleted
-- fact) only for a fact the puller may hold. It used to take that from the
-- puller's own knownCursor, so a peer sending a cursor in the future learned of
-- every fact the workspace ever forgot or deleted, including ones it was never
-- served. This table records, per (workspace, peer authenticated by the gate),
-- the latest creation time among the facts served to it; the bound is now the
-- earlier of knownCursor and this mark, and without a mark no tombstone goes.
--
-- RLS + FORCE per workspace (mnemosyne.workspace_id), like 0063. TRUNCATE skips
-- RLS, so the app roles never get it.
--
-- DEPLOYMENT ORDER. Before the server code that reads this table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE mnemosyne.mnemo_federation_serve_mark (
    workspace_id text NOT NULL,
    peer_id text NOT NULL,
    served_until timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, peer_id)
);

ALTER TABLE mnemosyne.mnemo_federation_serve_mark ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_federation_serve_mark FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_federation_serve_mark_ws ON mnemosyne.mnemo_federation_serve_mark FOR ALL
    USING (workspace_id = current_setting('mnemosyne.workspace_id', true))
    WITH CHECK (workspace_id = current_setting('mnemosyne.workspace_id', true));

REVOKE ALL ON TABLE mnemosyne.mnemo_federation_serve_mark FROM PUBLIC;
REVOKE TRUNCATE ON TABLE mnemosyne.mnemo_federation_serve_mark FROM app_user, mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_federation_serve_mark TO app_user, mnemo_app_role;
