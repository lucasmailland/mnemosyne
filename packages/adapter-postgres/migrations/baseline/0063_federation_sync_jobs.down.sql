-- migrate:allow-drop reason=reverts the sync job table 0063 adds
-- Reverts 0063. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit). Roll the server back first: it reads this
-- table. The jobs are lost; an older server keeps them in memory only.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS mnemosyne.mnemo_federation_sync_job;
COMMIT;
