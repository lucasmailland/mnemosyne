-- Migration 0076: the audit log never runs out of partitions (APP-001, audit
-- 2026-11-22).
--
-- The baseline creates mnemo_audit_log_y2026m01..m12 and nothing else, and the
-- table has no DEFAULT partition. Two things were meant to extend it and
-- neither could:
--
--   * mnemo_audit_create_next_partition() asked for NEXT month only. A database
--     migrated after the last baseline month had no partition for "now", and one
--     that was down across a month boundary came back with a hole.
--   * It ran as the server's own login. In production that is mnemo_app, which
--     holds USAGE on the schema and nothing more, so the CREATE TABLE inside
--     create_audit_partition() was refused ("permission denied for schema
--     mnemosyne") and the cron logged a warning every week.
--
-- With no partition for the current month every audit INSERT fails. Measured by
-- detaching the month's partition: POST /remember answered 500 with the fact
-- row already committed, DELETE /facts/:id answered 500 with the fact already
-- closed, and neither left an audit row.
--
-- Both functions become SECURITY DEFINER (they run as the role that owns the
-- table), with a pinned search_path and a pinned time zone, and the runway
-- grows to the current month plus the two after it. The time zone matters:
-- the bounds are built from dates, and a date turned into a timestamptz in a
-- session that is not UTC would overlap its neighbour or leave a gap.
--
-- A DEFAULT partition is deliberately NOT added. Once a row for month X sits in
-- it, month X's partition can no longer be created without moving that row,
-- and the audit log's immutability trigger forbids exactly that move.
SET LOCAL lock_timeout = '5s';

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

-- Same name and signature the cron already calls; it now keeps a runway of the
-- current month and the two after it instead of next month alone.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_audit_create_next_partition() RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = mnemosyne, pg_temp
    SET timezone = 'UTC'
    AS $$
DECLARE
  v_target DATE;
  v_offset INT;
BEGIN
  FOR v_offset IN 0..2 LOOP
    v_target := (date_trunc('month', now()) + make_interval(months => v_offset))::DATE;
    PERFORM mnemosyne.create_audit_partition(
      EXTRACT(YEAR  FROM v_target)::INT,
      EXTRACT(MONTH FROM v_target)::INT
    );
  END LOOP;
END;
$$;

-- A definer function is callable by PUBLIC unless that is taken away.
REVOKE ALL ON FUNCTION mnemosyne.create_audit_partition(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_audit_create_next_partition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.create_audit_partition(integer, integer) TO mnemo_app_role, app_user;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_audit_create_next_partition() TO mnemo_app_role, app_user;

-- Every migrate run leaves the runway in place, including a first install made
-- after the last month the baseline knows about.
SELECT mnemosyne.mnemo_audit_create_next_partition();
