-- Reverts 0046's function change: create_audit_partition() goes back to the
-- 0001 body, so new partitions inherit 0015's default privileges again.
--
-- The REVOKEs are deliberately NOT undone. No migration ever granted UPDATE or
-- DELETE on either log — the baseline grants SELECT, INSERT — so there is no
-- prior migration state to restore; re-granting would only reopen S3/S4.
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
  RETURN format('created partition %s (%s .. %s)', v_partition_name, v_start, v_end);
END;
$$;
