-- migrate:no-transaction

-- Keep this expand-only: old servers can archive/re-collapse managed rows after
-- quiesce without writing the new archive fields. Metadata consistency belongs
-- to the managed finalizer until the rollback compatibility window closes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'mnemosyne.mnemo_session'::regclass
      AND conname = 'mnemo_session_managed_archive_reason_check'
  ) THEN
    ALTER TABLE mnemosyne.mnemo_session
      ADD CONSTRAINT mnemo_session_managed_archive_reason_check
      CHECK (
        (archive_reason IS NULL OR archive_reason = ANY (ARRAY[
          'empty_session'::text,
          'incomplete_exchange'::text,
          'too_few_turns'::text,
          'low_recurrence_signal'::text,
          'no_pin'::text
        ]))
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE mnemosyne.mnemo_session
  VALIDATE CONSTRAINT mnemo_session_managed_archive_reason_check;
