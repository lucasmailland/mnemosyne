-- 0074_api_key_max_sensitivity.sql — Per-key sensitivity ceiling for mnemo_api_keys.
--
-- Adds max_sensitivity to the bearer-key table so individual API keys can be
-- restricted to a sensitivity tier below the workspace ceiling.
--
-- NULL means "no additional restriction" — the key inherits the workspace ceiling
-- (same semantics as mnemo_scoped_api_keys.max_sensitivity).
--
-- Enforcement: verifyApiKeyToken reads this column, sets c("maxSensitivity"),
-- and effectiveCeiling() in rbac.ts takes min(workspaceCeiling, keyCeiling).
-- Ceiling violations return 404 (anti-probing — do not confirm the resource exists).

ALTER TABLE mnemo_api_keys
  ADD COLUMN IF NOT EXISTS max_sensitivity TEXT
    CHECK (max_sensitivity IN ('public', 'internal', 'confidential', 'restricted'));
