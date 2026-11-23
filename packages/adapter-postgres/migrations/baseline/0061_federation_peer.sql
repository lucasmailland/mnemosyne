-- Migration 0061: federation peers survive a restart.
--
-- Until now the server kept its federation peers in memory (InMemoryPeerStore),
-- so every restart forgot them and there was no way to add one. This table holds
-- what PeerConfig holds; the server writes it only through
-- POST /memory/federation/peers (federation:admin), and key rotation updates the
-- pin of an existing row (FED-04: nothing else creates a peer).
--
-- A peer belongs to the installation, not to a workspace, so the workspace RLS
-- policies do not apply. It is still RLS + FORCE (S2), with one policy keyed to
-- the mnemosyne.federation_peers GUC: DrizzlePeerStore sets it with
-- set_config(..., true) inside its own transaction, as the tenant tables do with
-- their GUCs. A query from any other path (a workspace transaction included)
-- sees no rows, so the peers' api_key and symmetric_key never leak through it.
-- Definer functions (0050, 0057) would not add a check here: the gate is the
-- caller's API key scope, which the database cannot see.
--
-- DEPLOYMENT ORDER. Before the server code that reads this table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE mnemosyne.mnemo_federation_peer (
    peer_id text PRIMARY KEY CHECK (length(peer_id) BETWEEN 1 AND 253),
    pinned_cert_der bytea NOT NULL CHECK (length(pinned_cert_der) > 0),
    trust_weight double precision NOT NULL CHECK (trust_weight >= 0 AND trust_weight <= 1),
    approved_at timestamptz NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    url text,
    api_key text,
    signing_public_key text,
    symmetric_key text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mnemosyne.mnemo_federation_peer ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_federation_peer FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_federation_peer_store ON mnemosyne.mnemo_federation_peer FOR ALL
    USING (current_setting('mnemosyne.federation_peers', true) = 'on')
    WITH CHECK (current_setting('mnemosyne.federation_peers', true) = 'on');

-- TRUNCATE skips RLS, so the app roles never get it.
REVOKE ALL ON TABLE mnemosyne.mnemo_federation_peer FROM PUBLIC;
REVOKE TRUNCATE ON TABLE mnemosyne.mnemo_federation_peer FROM app_user, mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_federation_peer TO app_user, mnemo_app_role;
