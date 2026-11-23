-- Reverts 0075_harness_message_chunks.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS mnemosyne.mnemo_harness_message_chunk;

COMMIT;
