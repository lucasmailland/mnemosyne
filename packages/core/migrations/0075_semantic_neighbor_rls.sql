-- 0075_semantic_neighbor_rls.sql
-- DB-6 (2026-07-23 audit): mnemo_semantic_neighbor (added by 0073) never had
-- RLS enabled at all -- CLAUDE.md's S2 invariant ("All mnemo_* tables MUST
-- have both ENABLE ROW LEVEL SECURITY AND FORCE ROW LEVEL SECURITY") was
-- violated from the start. mnemo_app_role has DML grants on this table
-- (adapter-postgres migration 0001's conditional GRANT, closed by DB-3's
-- coverage), so without RLS any workspace could read/write another
-- workspace's semantic-neighbor edges. backfillSemanticNeighbors,
-- loadSemanticEdges, and buildGraphQuery({includeSemantic}) all already run
-- inside withMnemoTx (confirmed by the 2026-07-01 empirical NOSUPERUSER
-- audit), which sets the mnemosyne.workspace_id GUC before touching this
-- table -- so a workspace-scoped policy costs nothing on the real call
-- paths. Additive + idempotent.
BEGIN;

ALTER TABLE mnemo_semantic_neighbor ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_semantic_neighbor FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mnemo_semantic_neighbor_ws ON mnemo_semantic_neighbor;
CREATE POLICY mnemo_semantic_neighbor_ws ON mnemo_semantic_neighbor
  FOR ALL USING (workspace_id = (current_setting('mnemosyne.workspace_id', true))::uuid);

COMMIT;
