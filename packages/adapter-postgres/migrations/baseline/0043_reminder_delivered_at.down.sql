-- migrate:allow-drop reason=reverts-0043-delivered_at-column-added-by-this-migration
-- Reverts 0043. Recall again delivers only the reminders it fires itself.
ALTER TABLE mnemosyne.mnemo_reminder DROP COLUMN IF EXISTS delivered_at;
