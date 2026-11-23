-- Reverts 0078_approval_consumed.sql. A spent approval goes back to 'expired',
-- which no request can redeem either.
BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE mnemosyne.mnemo_approval_request SET status = 'expired' WHERE status = 'consumed';
ALTER TABLE mnemosyne.mnemo_approval_request
  DROP CONSTRAINT IF EXISTS mnemo_approval_request_status_check;
ALTER TABLE mnemosyne.mnemo_approval_request
  ADD CONSTRAINT mnemo_approval_request_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text]));

COMMIT;
