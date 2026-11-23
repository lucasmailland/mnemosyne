-- migrate:no-transaction
-- P17: Add scope_ref column to decision, strategy, workflow.
-- Replicates mnemo_fact.scope_ref: nullable text, no CHECK constraint.
-- CONCURRENTLY indexes cannot run inside a transaction; this file runs outside one.

ALTER TABLE mnemosyne.mnemo_decision ADD COLUMN IF NOT EXISTS scope_ref text;
ALTER TABLE mnemosyne.mnemo_strategy ADD COLUMN IF NOT EXISTS scope_ref text;
ALTER TABLE mnemosyne.mnemo_workflow ADD COLUMN IF NOT EXISTS scope_ref text;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_decision_ws_scope_ref
  ON mnemosyne.mnemo_decision (workspace_id, scope_ref)
  WHERE scope_ref IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_strategy_ws_scope_ref
  ON mnemosyne.mnemo_strategy (workspace_id, scope_ref)
  WHERE scope_ref IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_ws_scope_ref
  ON mnemosyne.mnemo_workflow (workspace_id, scope_ref)
  WHERE scope_ref IS NOT NULL;
