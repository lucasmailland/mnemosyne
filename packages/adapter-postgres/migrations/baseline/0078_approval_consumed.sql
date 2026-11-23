-- Migration 0078: an approval is spent by the request it lets through
-- (APP-007, audit 2026-11-22).
--
-- An approved approval id used to be accepted on any request with the same
-- trigger, by anyone, until the end of time. DrizzleApprovalStore.consume now
-- moves it from 'approved' to 'consumed' in the same statement that checks it
-- is unexpired and is being redeemed by its requester for the same method and
-- path; the status check below admits the new value.
SET LOCAL lock_timeout = '5s';

ALTER TABLE mnemosyne.mnemo_approval_request
  DROP CONSTRAINT IF EXISTS mnemo_approval_request_status_check;
ALTER TABLE mnemosyne.mnemo_approval_request
  ADD CONSTRAINT mnemo_approval_request_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text, 'consumed'::text]))
  NOT VALID;
ALTER TABLE mnemosyne.mnemo_approval_request
  VALIDATE CONSTRAINT mnemo_approval_request_status_check;
