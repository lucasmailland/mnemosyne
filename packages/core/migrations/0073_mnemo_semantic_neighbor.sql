-- 0073_mnemo_semantic_neighbor.sql
-- Precomputed semantic-neighbor edges between facts (kNN over halfvec
-- embeddings). Distinct from mnemo_relation (judged edges, 9 locked verbs):
-- these are system-derived, undirected-by-convention similarity links that
-- densify the navigable graph. Populated by a backfill job; safe to truncate
-- and rebuild. Additive + idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS mnemo_semantic_neighbor (
  workspace_id   uuid        NOT NULL,
  source_fact_id text        NOT NULL,
  target_fact_id text        NOT NULL,
  cosine         real        NOT NULL,
  model_version  text,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_fact_id, target_fact_id)
);

-- Read path: "all neighbors in this workspace" (graph assembly) and
-- "neighbors of fact X" (per-node expansion).
CREATE INDEX IF NOT EXISTS idx_mnemo_semantic_neighbor_ws
  ON mnemo_semantic_neighbor (workspace_id);
CREATE INDEX IF NOT EXISTS idx_mnemo_semantic_neighbor_source
  ON mnemo_semantic_neighbor (workspace_id, source_fact_id);

COMMIT;
