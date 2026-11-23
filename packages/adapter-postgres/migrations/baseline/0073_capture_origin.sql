-- P138/P142: do not infer historical origin from role or prose.
ALTER TABLE mnemosyne.mnemo_session
  ADD COLUMN traffic_origin text NOT NULL DEFAULT 'unknown'
  CONSTRAINT mnemo_session_traffic_origin_check CHECK (traffic_origin IN ('organic', 'installer_verify', 'evaluation', 'unknown'));
ALTER TABLE mnemosyne.mnemo_session_turn
  ADD COLUMN turn_origin text NOT NULL DEFAULT 'unknown'
    CONSTRAINT mnemo_session_turn_origin_check CHECK (turn_origin IN ('human', 'agent_message', 'task_notification', 'pasted_content', 'assistant', 'unknown')),
  ADD COLUMN turn_origin_evidence text NOT NULL DEFAULT 'unclassified';
