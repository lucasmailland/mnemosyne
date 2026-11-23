-- Rollback 0075.
DROP POLICY IF EXISTS mnemo_semantic_neighbor_ws ON mnemo_semantic_neighbor;
ALTER TABLE mnemo_semantic_neighbor NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemo_semantic_neighbor DISABLE ROW LEVEL SECURITY;
