-- migrate:allow-drop reason=explicit rollback of additive capture metadata
ALTER TABLE mnemosyne.mnemo_session_turn DROP COLUMN turn_origin_evidence, DROP COLUMN turn_origin;
ALTER TABLE mnemosyne.mnemo_session DROP COLUMN traffic_origin;
