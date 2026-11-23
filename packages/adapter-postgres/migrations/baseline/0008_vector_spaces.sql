-- 0008_vector_spaces.sql: Multi-Model Vector Space Architecture (§B4.1 - §B4.5)

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_vector_space (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id TEXT NOT NULL,
    space_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    model_revision TEXT DEFAULT 'v1',
    dimensions INTEGER NOT NULL CHECK (dimensions IN (512, 768, 1024, 1536, 2048, 3072, 4096)),
    distance_metric TEXT NOT NULL DEFAULT 'cosine' CHECK (distance_metric IN ('cosine', 'ip', 'l2')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('building', 'active', 'dormant', 'stale', 'superseded', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_workspace_space_key UNIQUE (workspace_id, space_key)
);

ALTER TABLE mnemosyne.mnemo_vector_space ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_vector_space FORCE ROW LEVEL SECURITY;

CREATE POLICY vector_space_isolation ON mnemosyne.mnemo_vector_space
    FOR ALL
    USING (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''))
    WITH CHECK (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''));

-- Partitioned embedding tables by dimension (1024, 1536, 2048, 4096)
CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_fact_embeddings_1024 (
    fact_id TEXT NOT NULL REFERENCES mnemosyne.mnemo_fact(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    space_id UUID NOT NULL REFERENCES mnemosyne.mnemo_vector_space(id) ON DELETE CASCADE,
    embedding public.vector(1024) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (space_id, fact_id)
);
ALTER TABLE mnemosyne.mnemo_fact_embeddings_1024 ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_fact_embeddings_1024 FORCE ROW LEVEL SECURITY;
CREATE POLICY fact_emb_1024_isolation ON mnemosyne.mnemo_fact_embeddings_1024
    FOR ALL
    USING (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''))
    WITH CHECK (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''));
CREATE INDEX IF NOT EXISTS idx_fact_emb_1024_hnsw ON mnemosyne.mnemo_fact_embeddings_1024 USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_fact_embeddings_1536 (
    fact_id TEXT NOT NULL REFERENCES mnemosyne.mnemo_fact(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    space_id UUID NOT NULL REFERENCES mnemosyne.mnemo_vector_space(id) ON DELETE CASCADE,
    embedding public.vector(1536) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (space_id, fact_id)
);
ALTER TABLE mnemosyne.mnemo_fact_embeddings_1536 ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_fact_embeddings_1536 FORCE ROW LEVEL SECURITY;
CREATE POLICY fact_emb_1536_isolation ON mnemosyne.mnemo_fact_embeddings_1536
    FOR ALL
    USING (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''))
    WITH CHECK (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''));
CREATE INDEX IF NOT EXISTS idx_fact_emb_1536_hnsw ON mnemosyne.mnemo_fact_embeddings_1536 USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_fact_embeddings_2048 (
    fact_id TEXT NOT NULL REFERENCES mnemosyne.mnemo_fact(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    space_id UUID NOT NULL REFERENCES mnemosyne.mnemo_vector_space(id) ON DELETE CASCADE,
    embedding public.vector(2048) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (space_id, fact_id)
);
ALTER TABLE mnemosyne.mnemo_fact_embeddings_2048 ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_fact_embeddings_2048 FORCE ROW LEVEL SECURITY;
CREATE POLICY fact_emb_2048_isolation ON mnemosyne.mnemo_fact_embeddings_2048
    FOR ALL
    USING (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''))
    WITH CHECK (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''));

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_fact_embeddings_4096 (
    fact_id TEXT NOT NULL REFERENCES mnemosyne.mnemo_fact(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    space_id UUID NOT NULL REFERENCES mnemosyne.mnemo_vector_space(id) ON DELETE CASCADE,
    embedding public.vector(4096) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (space_id, fact_id)
);
ALTER TABLE mnemosyne.mnemo_fact_embeddings_4096 ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_fact_embeddings_4096 FORCE ROW LEVEL SECURITY;
CREATE POLICY fact_emb_4096_isolation ON mnemosyne.mnemo_fact_embeddings_4096
    FOR ALL
    USING (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''))
    WITH CHECK (workspace_id = NULLIF(current_setting('mnemosyne.current_workspace_id', true), ''));
