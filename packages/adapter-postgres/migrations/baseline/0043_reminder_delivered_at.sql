-- Migration 0043 (WP-4, LIFECYCLE-6): record when a reminder reached an agent.
--
-- The 30-second poller fires due time-only reminders (status -> 'triggered')
-- with no agent to show them to; recall only evaluated 'pending' rows, so a
-- reminder the poller fired first never reached memory_recall. delivered_at
-- separates "fired" from "an agent saw it": the next recall returns every
-- triggered reminder with delivered_at IS NULL, once, and stamps it.
--
-- Reminders that were already triggered or dismissed before this migration are
-- treated as delivered, so the first recall after the upgrade does not replay
-- the workspace's whole reminder history.

ALTER TABLE mnemosyne.mnemo_reminder
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

UPDATE mnemosyne.mnemo_reminder
   SET delivered_at = COALESCE(triggered_at, updated_at)
 WHERE status <> 'pending'
   AND delivered_at IS NULL;
