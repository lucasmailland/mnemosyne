-- Reverts 0076_audit_partition_runway.sql: both functions go back to SECURITY
-- INVOKER with their 0046 / 0001 bodies. Partitions the runway created stay:
-- they may hold audit rows, and the audit log is append-only.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION mnemosyne.create_audit_partition(p_year integer, p_month integer) RETURNS text
    LANGUAGE plpgsql
    SECURITY INVOKER
    AS $$
DECLARE
  v_partition_name TEXT;
  v_start          DATE;
  v_end            DATE;
  v_sql            TEXT;
BEGIN
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

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_audit_create_next_partition() RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    AS $$
DECLARE
  v_target DATE;
  v_msg    TEXT;
BEGIN
  v_target := DATE_TRUNC('month', NOW() + INTERVAL '1 month');
  v_msg := create_audit_partition(
    EXTRACT(YEAR  FROM v_target)::INT,
    EXTRACT(MONTH FROM v_target)::INT
  );
  RAISE NOTICE '%', v_msg;
END;
$$;

GRANT EXECUTE ON FUNCTION mnemosyne.create_audit_partition(integer, integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_audit_create_next_partition() TO PUBLIC;

COMMIT;
