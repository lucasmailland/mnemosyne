-- 0064_mnemo_decision_confidence down
ALTER TABLE mnemo_decision DROP COLUMN IF EXISTS confidence;
