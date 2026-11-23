-- Migration 0014: grant mnemo_app_role DML access on 11 tables that the
-- baseline squash (0001) and the vector-spaces migration (0008) created
-- with RLS enabled but no matching GRANT.
--
-- Found by SAFE-1's new grant_completeness linter check (migration-safety.ts)
-- — the same bug class as 0008's own index-target grant gap (fixed at the
-- time), mnemo_audit_log's INSERT-only RLS gap, and mnemo_semantic_neighbor's
-- missing GRANT (both shipped and fixed by hand after the fact). Every table
-- below was verified against a real Postgres container:
-- has_table_privilege('mnemo_app_role', <table>, 'SELECT') returned false,
-- vs true for a control table (mnemo_episode) known to be correctly
-- granted. Under any properly-hardened deployment (app_user role per
-- docker/README.md, NOT the superuser connection) every query against
-- these tables 500s with "permission denied" -- not an RLS-empty-result-set
-- degradation, a hard failure.
--
-- Three sibling tables in the same "§6 scoped-key scheme" (mnemo_scoped_api_keys,
-- mnemo_scoped_key_escrow, mnemo_scoped_key_usage) were investigated and are
-- DELIBERATELY excluded here: DrizzleApiKeyStore.ts documents that auth
-- lookups against them happen before any workspace GUC is set, over the
-- pre-auth bootstrap connection -- the exact same architectural exception
-- CLAUDE.md documents for mnemo_api_keys. Granting mnemo_app_role there
-- would be a no-op for how they're actually queried, not a fix.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_consolidation_lock TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_embedding_cache TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_hot_tier_snapshot TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_key_escrow TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_review_item TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_workspace_kek TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_workspace_mode TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_vector_space TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_fact_embeddings_1024 TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_fact_embeddings_1536 TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_fact_embeddings_2048 TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_fact_embeddings_4096 TO mnemo_app_role;
