-- Migration 0018: allow time-only reminders (mnemo_reminder.condition nullable).
--
-- REMIND-1: `condition` was NOT NULL and z.string().min(1)-mandatory at
-- creation, so EVERY reminder carried a semantic condition. Combined with
-- evaluator.ts's AND rule for time+condition reminders, that made a pure
-- timer ("remind me at 17:00") inexpressible: the 30s background poller has
-- no query context, so the semantic half could never be satisfied and
-- NOTHING it swept could ever fire.
--
-- Catalog-only change: no table rewrite, no backfill, no index. Existing rows
-- keep their conditions unchanged; only NEW reminders may omit one. The
-- application layer enforces "at least one of condition / triggerAt"
-- (packages/server/src/routes/reminders.ts). No GRANT/RLS change.

ALTER TABLE mnemosyne.mnemo_reminder
  ALTER COLUMN condition DROP NOT NULL;
