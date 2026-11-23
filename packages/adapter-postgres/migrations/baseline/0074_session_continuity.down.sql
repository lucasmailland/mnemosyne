-- migrate:allow-drop reason=explicit rollback of additive capture metadata
DROP INDEX mnemosyne.idx_session_turn_legacy_occurrence_unique;
DROP INDEX mnemosyne.idx_session_legacy_successor_unique;
DROP INDEX mnemosyne.idx_session_legacy_source_generation_unique;
ALTER TABLE mnemosyne.mnemo_session_turn DROP COLUMN continuity_root_id;
ALTER TABLE mnemosyne.mnemo_session DROP COLUMN continuity_root_id;
