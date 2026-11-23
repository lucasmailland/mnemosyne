-- 0015_mnemo_rls_foundation.down.sql
--
-- Drops the foundational RLS helper functions installed by
-- 0015_mnemo_rls_foundation.sql. Note: this does NOT remove the per-table
-- policies the mnemo_* migrations created via apply_pattern_a() — those are
-- torn down by each table's own .down.sql. Dropping the functions while
-- policies still reference them is fine: policies embed the resolved
-- expression, and DROP FUNCTION here is a no-op for already-applied policies.

DROP FUNCTION IF EXISTS apply_pattern_a(text);
DROP FUNCTION IF EXISTS is_cross_tenant_admin();
DROP FUNCTION IF EXISTS current_workspace_id();
