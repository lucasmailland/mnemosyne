-- Migration 0046: the audit and deletion logs are append-only by GRANT, not
-- only by trigger (SEC-6; CLAUDE.md S3 and S4).
--
-- S3 promises two layers for mnemo_audit_log: the enforce_audit_immutable
-- trigger AND no UPDATE/DELETE/TRUNCATE for mnemo_app_role. The baseline grants
-- the role SELECT, INSERT only (0001), but two later steps widened it:
--
--   * docker/scripts/provision-app-role.mjs, the third step of every production
--     migration run, executes
--       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mnemosyne
--     and its exception list omitted both logs;
--   * 0015's ALTER DEFAULT PRIVILEGES grants the same four privileges to every
--     table created afterwards, which includes each monthly audit partition
--     create_audit_partition() adds.
--
-- Measured on the 2026-10-17 eval stack: mnemo_app_role held UPDATE and DELETE
-- on mnemo_audit_log and the runtime login inherited them, so the guarantee
-- rested on the trigger alone. Under FORCE RLS with no UPDATE/DELETE policy the
-- statements even "succeeded" on zero rows instead of failing.
--
-- The provisioning script now revokes these itself after its blanket grant (it
-- runs after this file on every deploy). This migration repairs the privileges
-- already granted on existing installations — on the parent table AND on every
-- partition, since a partition addressed by name is checked against its own
-- ACL — and makes future partitions start revoked. mnemo_deletion_log (S4,
-- INSERT-only) had the same gap and gets the same repair. SELECT and INSERT are
-- untouched: the app appends and reads both logs.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE mnemosyne.mnemo_audit_log FROM mnemo_app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE mnemosyne.mnemo_deletion_log FROM mnemo_app_role;

DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN
    SELECT i.inhrelid::regclass
    FROM pg_inherits i
    WHERE i.inhparent = 'mnemosyne.mnemo_audit_log'::regclass
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE %s FROM mnemo_app_role', part);
  END LOOP;
END
$$;

-- Same body as 0001, plus the REVOKE right after the CREATE: the partition
-- inherits 0015's default privileges at creation time.
CREATE OR REPLACE FUNCTION mnemosyne.create_audit_partition(p_year integer, p_month integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_partition_name TEXT;
  v_start          DATE;
  v_end            DATE;
  v_sql            TEXT;
BEGIN
  -- Validate inputs
  IF p_year < 2000 OR p_year > 9999 THEN
    RAISE EXCEPTION 'Invalid year: %', p_year;
  END IF;
  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'Invalid month: %', p_month;
  END IF;

  v_partition_name := format('mnemo_audit_log_y%sm%s',
                             p_year,
                             lpad(p_month::TEXT, 2, '0'));
  v_start := make_date(p_year, p_month, 1);
  v_end   := v_start + INTERVAL '1 month';

  -- Idempotent: skip if partition already exists
  IF EXISTS (
    SELECT 1
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'mnemosyne'
      AND  c.relname = v_partition_name
  ) THEN
    RETURN format('partition %s already exists', v_partition_name);
  END IF;

  v_sql := format(
    'CREATE TABLE mnemosyne.%I PARTITION OF mnemosyne.mnemo_audit_log '
    'FOR VALUES FROM (%L) TO (%L)',
    v_partition_name, v_start, v_end
  );

  EXECUTE v_sql;
  EXECUTE format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE mnemosyne.%I FROM mnemo_app_role',
    v_partition_name
  );
  RETURN format('created partition %s (%s .. %s)', v_partition_name, v_start, v_end);
END;
$$;
