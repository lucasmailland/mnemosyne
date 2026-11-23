-- 0067_api_keys_plan.sql
-- Adds billing-plan tier column to mnemo_api_keys (mirrors v3/0036_api_key_plan.sql).
-- Required by factory.ts findByKeyHash / findByLookupHash which SELECT plan from this table.
BEGIN;
ALTER TABLE mnemo_api_keys
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro', 'enterprise'));
COMMIT;
