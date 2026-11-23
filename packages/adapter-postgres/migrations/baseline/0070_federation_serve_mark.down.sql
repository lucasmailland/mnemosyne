-- migrate:allow-drop reason=reverts the serve mark table 0070 adds
-- Reverts 0070. Roll the server back first: it reads this table.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS mnemosyne.mnemo_federation_serve_mark;
COMMIT;
