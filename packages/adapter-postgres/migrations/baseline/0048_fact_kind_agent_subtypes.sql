-- migrate:no-transaction
-- Migration 0048 (verify Q-3): the fact kinds agents actually send.
--
-- WP-5 answered an unknown fact `subtype` with a 400 (AGENTSIM-8). Agents that
-- follow the protocol file facts under the decision vocabulary, and the
-- end-to-end verification lost 45 of 62 of their writes that way. Six of those
-- values name a real category of fact (architecture, bugfix, config,
-- discovery, policy, process), so mnemo_fact.kind accepts them now. Any other
-- unknown subtype is stored as 'other' by POST /remember, which says so in the
-- response's `warnings`.
--
-- ONLINE SAFETY. As in 0045: this file runs outside a transaction. The
-- constraint swap is catalog-only (the new CHECK is added NOT VALID) under a
-- short lock_timeout, and the scan runs afterwards under SHARE UPDATE
-- EXCLUSIVE, which blocks neither reads nor writes. The new CHECK is strictly
-- looser than the old one, so validation cannot fail. Both statements are
-- idempotent: a timed-out run is simply re-run.
--
-- DEPLOYMENT ORDER. Before the new server code. Old code never writes the new
-- values; new code on the old schema would fail those writes on the CHECK.

SET lock_timeout = '5s';

ALTER TABLE mnemosyne.mnemo_fact
  DROP CONSTRAINT IF EXISTS mnemo_fact_kind_check,
  ADD CONSTRAINT mnemo_fact_kind_check CHECK (kind = ANY (ARRAY[
    'preference'::text, 'trait'::text, 'event'::text, 'relationship'::text, 'skill'::text,
    'concern'::text, 'architecture'::text, 'bugfix'::text, 'config'::text, 'discovery'::text,
    'policy'::text, 'process'::text, 'other'::text])) NOT VALID;

ALTER TABLE mnemosyne.mnemo_fact VALIDATE CONSTRAINT mnemo_fact_kind_check;

RESET lock_timeout;
