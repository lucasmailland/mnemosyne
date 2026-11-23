-- Reverts 0079: partitions go back to 0076's grants (SELECT, INSERT kept).
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE part regclass;
BEGIN
  FOR part IN
    SELECT i.inhrelid::regclass FROM pg_catalog.pg_inherits i
    WHERE i.inhparent = 'mnemosyne.mnemo_audit_log'::regclass
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %s TO mnemo_app_role', part);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION mnemosyne.create_audit_partition(p_year integer, p_month integer) RETURNS text
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = mnemosyne, pg_temp
    SET timezone = 'UTC'
    AS $$
DECLARE
  v_partition_name TEXT;
  v_start          DATE;
  v_end            DATE;
BEGIN
  IF p_year < 2000 OR p_year > 9999 THEN
    RAISE EXCEPTION 'Invalid year: %', p_year;
  END IF;
  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'Invalid month: %', p_month;
  END IF;

  v_partition_name := format('mnemo_audit_log_y%sm%s', p_year, lpad(p_month::TEXT, 2, '0'));
  v_start := make_date(p_year, p_month, 1);
  v_end   := (v_start + INTERVAL '1 month')::DATE;

  -- Two replicas reach the first of the month together: one at a time.
  PERFORM pg_advisory_xact_lock(hashtext('mnemosyne.mnemo_audit_log.partition'));

  IF EXISTS (
    SELECT 1
    FROM   pg_catalog.pg_class c
    JOIN   pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'mnemosyne'
      AND  c.relname = v_partition_name
  ) THEN
    RETURN format('partition %s already exists', v_partition_name);
  END IF;

  EXECUTE format(
    'CREATE TABLE mnemosyne.%I PARTITION OF mnemosyne.mnemo_audit_log '
    'FOR VALUES FROM (%L) TO (%L)',
    v_partition_name, v_start, v_end
  );
  -- The partition inherits 0015's default privileges at creation time (0046).
  EXECUTE format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE mnemosyne.%I FROM mnemo_app_role',
    v_partition_name
  );
  RETURN format('created partition %s (%s .. %s)', v_partition_name, v_start, v_end);
END;
$$;

COMMIT;
