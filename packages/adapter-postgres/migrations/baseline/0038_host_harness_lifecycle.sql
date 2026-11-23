-- migrate:no-transaction
-- Host harness v1 expand-only schema. Every statement is restart-safe because
-- the migration runner executes this file one statement at a time.

ALTER DEFAULT PRIVILEGES IN SCHEMA mnemosyne
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM mnemo_app_role;

ALTER TABLE mnemosyne.mnemo_session
  ADD COLUMN IF NOT EXISTS source_host text,
  ADD COLUMN IF NOT EXISTS source_session_id text,
  ADD COLUMN IF NOT EXISTS source_client_instance_id text,
  ADD COLUMN IF NOT EXISTS source_generation integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS predecessor_session_id text,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS close_kind text,
  ADD COLUMN IF NOT EXISTS close_requested_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS close_grace_deadline timestamp with time zone,
  ADD COLUMN IF NOT EXISTS terminal_digest_version integer,
  ADD COLUMN IF NOT EXISTS terminal_message_set_digest text,
  ADD COLUMN IF NOT EXISTS terminal_max_enqueue_sequence bigint,
  ADD COLUMN IF NOT EXISTS sensitivity text,
  ADD COLUMN IF NOT EXISTS origin_actor_id text,
  ADD COLUMN IF NOT EXISTS origin_actor_type text,
  ADD COLUMN IF NOT EXISTS origin_user_id text,
  ADD COLUMN IF NOT EXISTS origin_sensitivity_ceiling text,
  ADD COLUMN IF NOT EXISTS collapse_lease_owner text,
  ADD COLUMN IF NOT EXISTS collapse_lease_expires_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS collapse_attempts integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS collapse_next_attempt_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS collapse_operation_id text,
  ADD COLUMN IF NOT EXISTS capture_incomplete boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS capture_incomplete_reasons jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;

ALTER TABLE mnemosyne.mnemo_session_turn
  ADD COLUMN IF NOT EXISTS source_message_id text,
  ADD COLUMN IF NOT EXISTS supersedes_source_message_id text,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS retracted_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS retraction_reason text,
  ADD COLUMN IF NOT EXISTS ingestion_event_workspace_id text DEFAULT current_setting('mnemosyne.workspace_id', true),
  ADD COLUMN IF NOT EXISTS ingestion_event_id uuid;

ALTER TABLE mnemosyne.mnemo_session_turn
  ALTER COLUMN ingestion_event_workspace_id
  SET DEFAULT current_setting('mnemosyne.workspace_id', true);

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_normalize_turn_ingestion_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.ingestion_event_workspace_id := NEW.workspace_id::text;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mnemosyne.mnemo_session_turn'::regclass
      AND tgname = 'trg_session_turn_ingestion_workspace'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_session_turn_ingestion_workspace
      BEFORE INSERT OR UPDATE OF workspace_id, ingestion_event_workspace_id
      ON mnemosyne.mnemo_session_turn
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_normalize_turn_ingestion_workspace();
  END IF;
END
$$;

UPDATE mnemosyne.mnemo_session_turn
SET ingestion_event_workspace_id = workspace_id::text
WHERE ingestion_event_workspace_id IS DISTINCT FROM workspace_id::text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mnemosyne.mnemo_session_turn'::regclass
      AND conname = 'mnemo_session_turn_ingestion_workspace_not_null_check'
  ) THEN
    ALTER TABLE mnemosyne.mnemo_session_turn
      ADD CONSTRAINT mnemo_session_turn_ingestion_workspace_not_null_check
      CHECK (ingestion_event_workspace_id IS NOT NULL)
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE mnemosyne.mnemo_session_turn
  VALIDATE CONSTRAINT mnemo_session_turn_ingestion_workspace_not_null_check;

SET lock_timeout = '5s';

ALTER TABLE mnemosyne.mnemo_session_turn
  ALTER COLUMN ingestion_event_workspace_id SET NOT NULL;

RESET lock_timeout;

ALTER TABLE mnemosyne.mnemo_session_turn
  DROP CONSTRAINT IF EXISTS mnemo_session_turn_ingestion_workspace_not_null_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mnemosyne.mnemo_session_turn'::regclass
      AND conname = 'mnemo_session_turn_ingestion_workspace_check'
  ) THEN
    ALTER TABLE mnemosyne.mnemo_session_turn
      ADD CONSTRAINT mnemo_session_turn_ingestion_workspace_check
      CHECK (ingestion_event_workspace_id = workspace_id::text)
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE mnemosyne.mnemo_session_turn
  VALIDATE CONSTRAINT mnemo_session_turn_ingestion_workspace_check;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_touch_session_last_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE mnemosyne.mnemo_session
  SET last_activity_at = GREATEST(COALESCE(last_activity_at, started_at), NEW.created_at)
  WHERE id = NEW.session_id AND workspace_id = NEW.workspace_id::text;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mnemosyne.mnemo_session_turn'::regclass
      AND tgname = 'trg_session_turn_last_activity'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_session_turn_last_activity
      AFTER INSERT ON mnemosyne.mnemo_session_turn
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_touch_session_last_activity();
  END IF;
END
$$;

WITH activity AS (
  SELECT s.id, COALESCE(MAX(t.created_at), s.started_at) AS max_created_at
  FROM mnemosyne.mnemo_session s
  LEFT JOIN mnemosyne.mnemo_session_turn t
    ON t.session_id = s.id AND t.workspace_id::text = s.workspace_id
  GROUP BY s.id, s.started_at
)
UPDATE mnemosyne.mnemo_session s
SET last_activity_at = COALESCE(activity.max_created_at, s.started_at)
FROM activity
WHERE activity.id = s.id AND s.last_activity_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mnemosyne.mnemo_session'::regclass
      AND conname = 'mnemo_session_status_harness_check'
  ) THEN
    ALTER TABLE mnemosyne.mnemo_session
      ADD CONSTRAINT mnemo_session_status_harness_check
      CHECK (status = ANY (ARRAY['active'::text, 'collapse_pending'::text, 'collapsed'::text, 'archived'::text]))
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE mnemosyne.mnemo_session
  VALIDATE CONSTRAINT mnemo_session_status_harness_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mnemosyne.mnemo_session'::regclass
      AND conname = 'mnemo_session_status_check'
  ) THEN
    ALTER TABLE mnemosyne.mnemo_session DROP CONSTRAINT mnemo_session_status_check;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_enforce_managed_session_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_host IS NOT NULL AND (
    NEW.source_host IS DISTINCT FROM OLD.source_host OR
    NEW.source_client_instance_id IS DISTINCT FROM OLD.source_client_instance_id OR
    NEW.source_session_id IS DISTINCT FROM OLD.source_session_id OR
    NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
    NEW.sensitivity IS DISTINCT FROM OLD.sensitivity OR
    NEW.origin_actor_id IS DISTINCT FROM OLD.origin_actor_id OR
    NEW.origin_actor_type IS DISTINCT FROM OLD.origin_actor_type OR
    NEW.origin_user_id IS DISTINCT FROM OLD.origin_user_id OR
    NEW.origin_sensitivity_ceiling IS DISTINCT FROM OLD.origin_sensitivity_ceiling
  ) THEN
    RAISE EXCEPTION 'managed session source identity and provenance are immutable';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mnemosyne.mnemo_session'::regclass
      AND tgname = 'trg_enforce_managed_session_identity'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_enforce_managed_session_identity
      BEFORE UPDATE ON mnemosyne.mnemo_session
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_enforce_managed_session_identity();
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_harness_workspace_control (
  workspace_id text PRIMARY KEY,
  ingestion_enabled boolean NOT NULL DEFAULT true,
  fence_epoch bigint NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by text,
  update_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mnemo_harness_workspace_control_fence_epoch_check CHECK (fence_epoch BETWEEN 0 AND 9007199254740991),
  CONSTRAINT mnemo_harness_workspace_control_workspace_fkey
    FOREIGN KEY (workspace_id) REFERENCES mnemosyne.mnemo_workspace(id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_enforce_harness_workspace_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ingestion_enabled IS DISTINCT FROM OLD.ingestion_enabled THEN
    NEW.fence_epoch := OLD.fence_epoch + 1;
  ELSIF NEW.fence_epoch IS DISTINCT FROM OLD.fence_epoch THEN
    RAISE EXCEPTION 'fence_epoch may only change with an ingestion state transition';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mnemosyne.mnemo_harness_workspace_control'::regclass
      AND tgname = 'trg_enforce_harness_workspace_fence'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_enforce_harness_workspace_fence
      BEFORE UPDATE ON mnemosyne.mnemo_harness_workspace_control
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_enforce_harness_workspace_fence();
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_seed_harness_workspace_control()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mnemosyne
AS $$
BEGIN
  INSERT INTO mnemosyne.mnemo_harness_workspace_control (workspace_id)
  VALUES (NEW.id)
  ON CONFLICT (workspace_id) DO NOTHING;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mnemosyne.mnemo_workspace'::regclass
      AND tgname = 'trg_seed_harness_workspace_control'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_seed_harness_workspace_control
      AFTER INSERT ON mnemosyne.mnemo_workspace
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_seed_harness_workspace_control();
  END IF;
END
$$;

INSERT INTO mnemosyne.mnemo_harness_workspace_control (workspace_id)
SELECT w.id FROM mnemosyne.mnemo_workspace w
ON CONFLICT (workspace_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_harness_ingestion_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  event_id text NOT NULL,
  source_host text NOT NULL,
  source_client_instance_id text NOT NULL,
  source_session_id text NOT NULL,
  source_generation integer,
  enqueue_sequence bigint NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  normalization_version integer NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  origin_actor_id text NOT NULL,
  origin_actor_type text NOT NULL,
  origin_user_id text,
  origin_sensitivity_ceiling text NOT NULL,
  session_id text,
  ledger_state text NOT NULL DEFAULT 'retryable',
  acknowledgement jsonb,
  finalized_at timestamp with time zone,
  retry_code text,
  CONSTRAINT mnemo_harness_ingestion_event_enqueue_sequence_check CHECK (enqueue_sequence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT mnemo_harness_ingestion_event_source_generation_check CHECK (source_generation IS NULL OR source_generation BETWEEN 0 AND 2147483647),
  CONSTRAINT mnemo_harness_ingestion_event_ledger_state_check CHECK (ledger_state = ANY (ARRAY['retryable'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text]))
);

ALTER TABLE mnemosyne.mnemo_harness_ingestion_event
  ADD COLUMN IF NOT EXISTS origin_actor_id text,
  ADD COLUMN IF NOT EXISTS origin_actor_type text,
  ADD COLUMN IF NOT EXISTS origin_user_id text,
  ADD COLUMN IF NOT EXISTS origin_sensitivity_ceiling text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_harness_ingestion_event
    WHERE origin_actor_id IS NULL OR origin_actor_type IS NULL
       OR origin_sensitivity_ceiling IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce harness ledger provenance: existing rows are missing immutable origin binding';
  END IF;
END
$$;

ALTER TABLE mnemosyne.mnemo_harness_ingestion_event
  ALTER COLUMN origin_actor_id SET NOT NULL,
  ALTER COLUMN origin_actor_type SET NOT NULL,
  ALTER COLUMN origin_sensitivity_ceiling SET NOT NULL;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_enforce_harness_event_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.event_id IS DISTINCT FROM OLD.event_id OR
     NEW.source_host IS DISTINCT FROM OLD.source_host OR
     NEW.source_client_instance_id IS DISTINCT FROM OLD.source_client_instance_id OR
     NEW.source_session_id IS DISTINCT FROM OLD.source_session_id OR
     NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
     NEW.enqueue_sequence IS DISTINCT FROM OLD.enqueue_sequence OR
     NEW.event_type IS DISTINCT FROM OLD.event_type OR
     NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
     NEW.normalization_version IS DISTINCT FROM OLD.normalization_version OR
     NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR
     NEW.received_at IS DISTINCT FROM OLD.received_at OR
     NEW.origin_actor_id IS DISTINCT FROM OLD.origin_actor_id OR
     NEW.origin_actor_type IS DISTINCT FROM OLD.origin_actor_type OR
     NEW.origin_user_id IS DISTINCT FROM OLD.origin_user_id OR
     NEW.origin_sensitivity_ceiling IS DISTINCT FROM OLD.origin_sensitivity_ceiling
  THEN
    RAISE EXCEPTION 'harness event source identity and enqueue provenance are immutable';
  END IF;
  IF OLD.ledger_state <> 'retryable' AND (
     NEW.session_id IS DISTINCT FROM OLD.session_id OR
     NEW.ledger_state IS DISTINCT FROM OLD.ledger_state OR
     NEW.acknowledgement IS DISTINCT FROM OLD.acknowledgement OR
     NEW.finalized_at IS DISTINCT FROM OLD.finalized_at OR
     NEW.retry_code IS DISTINCT FROM OLD.retry_code
  ) THEN
    RAISE EXCEPTION 'finalized harness event acknowledgement is immutable';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mnemosyne.mnemo_harness_ingestion_event'::regclass
      AND tgname = 'trg_enforce_harness_event_provenance'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_enforce_harness_event_provenance
      BEFORE UPDATE ON mnemosyne.mnemo_harness_ingestion_event
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_enforce_harness_event_provenance();
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_enforce_managed_turn_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_message_id IS NOT NULL AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
    NEW.session_id IS DISTINCT FROM OLD.session_id OR
    NEW.turn_index IS DISTINCT FROM OLD.turn_index OR
    NEW.source_message_id IS DISTINCT FROM OLD.source_message_id OR
    NEW.supersedes_source_message_id IS DISTINCT FROM OLD.supersedes_source_message_id OR
    NEW.role IS DISTINCT FROM OLD.role OR
    NEW.content IS DISTINCT FROM OLD.content OR
    NEW.content_hash IS DISTINCT FROM OLD.content_hash OR
    NEW.ingestion_event_workspace_id IS DISTINCT FROM OLD.ingestion_event_workspace_id OR
    NEW.ingestion_event_id IS DISTINCT FROM OLD.ingestion_event_id
  ) THEN
    RAISE EXCEPTION 'managed turn source identity and enqueue provenance are immutable';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mnemosyne.mnemo_session_turn'::regclass
      AND tgname = 'trg_enforce_managed_turn_identity'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_enforce_managed_turn_identity
      BEFORE UPDATE ON mnemosyne.mnemo_session_turn
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_enforce_managed_turn_identity();
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_harness_loss (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  ingestion_event_id uuid NOT NULL,
  source_generation integer NOT NULL,
  enqueue_sequence bigint NOT NULL,
  lost_event_type text NOT NULL,
  lost_source_message_id text NOT NULL,
  lost_role text NOT NULL,
  lost_content_hash text NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mnemo_harness_loss_source_generation_check CHECK (source_generation BETWEEN 0 AND 2147483647),
  CONSTRAINT mnemo_harness_loss_enqueue_sequence_check CHECK (enqueue_sequence BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_harness_retraction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  ingestion_event_id uuid NOT NULL,
  source_message_id text NOT NULL,
  predecessor_session_id text,
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_harness_message_tombstone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  source_host text NOT NULL,
  source_client_instance_id text NOT NULL,
  source_session_id text NOT NULL,
  source_generation integer NOT NULL,
  event_id text NOT NULL,
  source_message_id text NOT NULL,
  payload_hash text NOT NULL,
  content_hash text NOT NULL,
  acknowledgement jsonb NOT NULL,
  deleted_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mnemo_harness_message_tombstone_source_generation_check CHECK (source_generation BETWEEN 0 AND 2147483647)
);

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_managed_collapse_operation (
  operation_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  source_generation integer NOT NULL,
  status text NOT NULL DEFAULT 'prepared',
  lease_owner text NOT NULL,
  result jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  committed_at timestamp with time zone,
  CONSTRAINT mnemo_managed_collapse_operation_source_generation_check CHECK (source_generation BETWEEN 0 AND 2147483647),
  CONSTRAINT mnemo_managed_collapse_operation_status_check CHECK (status = ANY (ARRAY['prepared'::text, 'committed'::text, 'failed'::text]))
);

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_managed_collapse_effect (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  collapse_operation_id text NOT NULL,
  effect_kind text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp with time zone,
  completed_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mnemo_managed_collapse_effect_attempts_check CHECK (attempts >= 0),
  CONSTRAINT mnemo_managed_collapse_effect_status_check CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text]))
);

CREATE TABLE IF NOT EXISTS mnemosyne.mnemo_extraction_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  collapse_operation_id text NOT NULL,
  session_id text NOT NULL,
  primitive_kind text NOT NULL,
  primitive_id text NOT NULL,
  source_message_ids text[] NOT NULL DEFAULT '{}'::text[],
  origin_actor_id text NOT NULL,
  origin_actor_type text NOT NULL,
  origin_user_id text,
  sensitivity text NOT NULL,
  sensitivity_ceiling text NOT NULL,
  candidate_hash text,
  rejection_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
DECLARE
  constraint_spec record;
BEGIN
  FOR constraint_spec IN
    SELECT * FROM (VALUES
      ('mnemo_session', 'mnemo_session_terminal_sequence_safe_check',
       'terminal_max_enqueue_sequence IS NULL OR terminal_max_enqueue_sequence BETWEEN 1 AND 9007199254740991'),
      ('mnemo_harness_ingestion_event', 'mnemo_harness_ingestion_event_enqueue_sequence_check',
       'enqueue_sequence BETWEEN 1 AND 9007199254740991'),
      ('mnemo_harness_ingestion_event', 'mnemo_harness_ingestion_event_enqueue_sequence_safe_check',
       'enqueue_sequence BETWEEN 1 AND 9007199254740991'),
      ('mnemo_harness_loss', 'mnemo_harness_loss_enqueue_sequence_check',
       'enqueue_sequence BETWEEN 1 AND 9007199254740991'),
      ('mnemo_harness_loss', 'mnemo_harness_loss_enqueue_sequence_safe_check',
       'enqueue_sequence BETWEEN 1 AND 9007199254740991')
    ) AS constraints(table_name, name, definition)
  LOOP
    EXECUTE format(
      'ALTER TABLE mnemosyne.%I DROP CONSTRAINT IF EXISTS %I',
      constraint_spec.table_name,
      constraint_spec.name
    );
    EXECUTE format(
      'ALTER TABLE mnemosyne.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID',
      constraint_spec.table_name,
      constraint_spec.name,
      constraint_spec.definition
    );
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'mnemosyne.mnemo_session'::regclass AND conname = 'mnemo_session_source_generation_safe_check') THEN
    ALTER TABLE mnemosyne.mnemo_session ADD CONSTRAINT mnemo_session_source_generation_safe_check CHECK (source_generation IS NULL OR source_generation BETWEEN 0 AND 2147483647) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'mnemosyne.mnemo_harness_workspace_control'::regclass AND conname = 'mnemo_harness_workspace_control_fence_epoch_safe_check') THEN
    ALTER TABLE mnemosyne.mnemo_harness_workspace_control ADD CONSTRAINT mnemo_harness_workspace_control_fence_epoch_safe_check CHECK (fence_epoch BETWEEN 0 AND 9007199254740991) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'mnemosyne.mnemo_harness_ingestion_event'::regclass AND conname = 'mnemo_harness_ingestion_event_source_generation_safe_check') THEN
    ALTER TABLE mnemosyne.mnemo_harness_ingestion_event ADD CONSTRAINT mnemo_harness_ingestion_event_source_generation_safe_check CHECK (source_generation IS NULL OR source_generation BETWEEN 0 AND 2147483647) NOT VALID;
  END IF;
END
$$;

ALTER TABLE mnemosyne.mnemo_session VALIDATE CONSTRAINT mnemo_session_source_generation_safe_check;
ALTER TABLE mnemosyne.mnemo_session VALIDATE CONSTRAINT mnemo_session_terminal_sequence_safe_check;
ALTER TABLE mnemosyne.mnemo_harness_workspace_control VALIDATE CONSTRAINT mnemo_harness_workspace_control_fence_epoch_safe_check;
ALTER TABLE mnemosyne.mnemo_harness_ingestion_event VALIDATE CONSTRAINT mnemo_harness_ingestion_event_enqueue_sequence_check;
ALTER TABLE mnemosyne.mnemo_harness_ingestion_event VALIDATE CONSTRAINT mnemo_harness_ingestion_event_enqueue_sequence_safe_check;
ALTER TABLE mnemosyne.mnemo_harness_ingestion_event VALIDATE CONSTRAINT mnemo_harness_ingestion_event_source_generation_safe_check;
ALTER TABLE mnemosyne.mnemo_harness_loss VALIDATE CONSTRAINT mnemo_harness_loss_enqueue_sequence_check;
ALTER TABLE mnemosyne.mnemo_harness_loss VALIDATE CONSTRAINT mnemo_harness_loss_enqueue_sequence_safe_check;

REVOKE ALL ON TABLE
  mnemosyne.mnemo_harness_ingestion_event,
  mnemosyne.mnemo_harness_workspace_control,
  mnemosyne.mnemo_harness_loss,
  mnemosyne.mnemo_harness_retraction,
  mnemosyne.mnemo_harness_message_tombstone,
  mnemosyne.mnemo_managed_collapse_operation,
  mnemosyne.mnemo_managed_collapse_effect,
  mnemosyne.mnemo_extraction_provenance
FROM mnemo_app_role;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_index_definition_matches(target_index oid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  actual_index_name text;
  table_name text;
  actual_unique boolean;
  actual_valid boolean;
  actual_ready boolean;
  actual_access_method text;
  actual_attribute_count integer;
  actual_key_count integer;
  actual_nulls_not_distinct boolean;
  actual_keys text[];
  actual_predicate text;
  expected_table text;
  expected_unique boolean;
  expected_keys text[];
  expected_predicate text;
BEGIN
   SELECT ci.relname, ct.relname, i.indisunique, i.indisvalid, i.indisready,
          am.amname, i.indnatts, i.indnkeyatts, i.indnullsnotdistinct,
         ARRAY(
           SELECT pg_get_indexdef(i.indexrelid, key_position, true)
           FROM generate_series(1, i.indnkeyatts) AS key_position
           ORDER BY key_position
         ),
         lower(regexp_replace(regexp_replace(COALESCE(pg_get_expr(i.indpred, i.indrelid), ''), '::text', '', 'g'), '[[:space:]()]', '', 'g'))
   INTO actual_index_name, table_name, actual_unique, actual_valid, actual_ready,
        actual_access_method, actual_attribute_count, actual_key_count,
        actual_nulls_not_distinct, actual_keys, actual_predicate
   FROM pg_index i
   JOIN pg_class ci ON ci.oid = i.indexrelid
   JOIN pg_class ct ON ct.oid = i.indrelid
   JOIN pg_am am ON am.oid = ci.relam
  WHERE i.indexrelid = target_index;

  SELECT definition.expected_table, definition.expected_unique,
         definition.expected_keys, definition.expected_predicate
  INTO expected_table, expected_unique, expected_keys, expected_predicate
  FROM (VALUES
    ('idx_session_workspace_id_unique', 'mnemo_session', true, ARRAY['workspace_id', 'id']::text[], ''),
    ('idx_session_source_generation_unique', 'mnemo_session', true, ARRAY['workspace_id', 'source_host', 'source_client_instance_id', 'source_session_id', 'source_generation']::text[], 'source_hostisnotnullandsource_client_instance_idisnotnullandsource_session_idisnotnullandsource_generationisnotnull'),
    ('idx_session_turn_source_message_unique', 'mnemo_session_turn', true, ARRAY['workspace_id', 'session_id', 'source_message_id']::text[], 'source_message_idisnotnull'),
    ('idx_harness_event_workspace_id_unique', 'mnemo_harness_ingestion_event', true, ARRAY['workspace_id', 'id']::text[], ''),
    ('idx_harness_event_id_unique', 'mnemo_harness_ingestion_event', true, ARRAY['workspace_id', 'event_id']::text[], ''),
    ('idx_harness_source_sequence_unique', 'mnemo_harness_ingestion_event', true, ARRAY['workspace_id', 'source_host', 'source_client_instance_id', 'source_session_id', 'enqueue_sequence']::text[], ''),
    ('idx_harness_tombstone_source_message_unique', 'mnemo_harness_message_tombstone', true, ARRAY['workspace_id', 'source_host', 'source_client_instance_id', 'source_session_id', 'source_generation', 'source_message_id']::text[], ''),
    ('idx_managed_collapse_session_generation_unique', 'mnemo_managed_collapse_operation', true, ARRAY['workspace_id', 'session_id', 'source_generation']::text[], ''),
    ('idx_managed_collapse_operation_workspace_id_unique', 'mnemo_managed_collapse_operation', true, ARRAY['workspace_id', 'operation_id']::text[], ''),
    ('idx_managed_collapse_effect_unique', 'mnemo_managed_collapse_effect', true, ARRAY['collapse_operation_id', 'effect_kind', 'target_kind', 'target_id']::text[], ''),
    ('idx_session_managed_activity', 'mnemo_session', false, ARRAY['workspace_id', 'last_activity_at']::text[], 'source_hostisnotnullandstatus=''active'''),
    ('idx_session_collapse_due', 'mnemo_session', false, ARRAY['workspace_id', 'collapse_next_attempt_at']::text[], 'status=''collapse_pending'''),
    ('idx_session_terminal_retention', 'mnemo_session', false, ARRAY['workspace_id', 'COALESCE(collapsed_at, archived_at)', 'id']::text[], 'source_hostisnotnullandstatus=anyarray[''collapsed'',''archived'']'),
    ('idx_harness_event_retryable', 'mnemo_harness_ingestion_event', false, ARRAY['workspace_id', 'received_at']::text[], 'ledger_state=''retryable'''),
    ('idx_harness_loss_session', 'mnemo_harness_loss', false, ARRAY['workspace_id', 'session_id']::text[], ''),
    ('idx_harness_retraction_session', 'mnemo_harness_retraction', false, ARRAY['workspace_id', 'session_id']::text[], ''),
    ('idx_harness_tombstone_session', 'mnemo_harness_message_tombstone', false, ARRAY['workspace_id', 'session_id']::text[], ''),
    ('idx_managed_collapse_effect_pending', 'mnemo_managed_collapse_effect', false, ARRAY['workspace_id', 'next_attempt_at']::text[], 'status=anyarray[''pending'',''failed'']'),
    ('idx_extraction_provenance_primitive', 'mnemo_extraction_provenance', false, ARRAY['workspace_id', 'primitive_kind', 'primitive_id']::text[], '')
  ) AS definition(index_name, expected_table, expected_unique, expected_keys, expected_predicate)
  WHERE definition.index_name = actual_index_name;

  RETURN actual_valid
    AND actual_ready
    AND actual_access_method = 'btree'
    AND actual_attribute_count = actual_key_count
    AND NOT actual_nulls_not_distinct
    AND table_name = expected_table
    AND actual_unique = expected_unique
    AND actual_keys = expected_keys
    AND actual_predicate = expected_predicate;
END
$$;

-- Interrupted or stale fixed-name builds are renamed and dropped concurrently.
-- A valid index is preserved only when its normalized catalog definition is exact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_session_workspace_id_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_session_workspace_id_unique RENAME TO idx_session_workspace_id_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_session_workspace_id_unique_invalid;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_session_workspace_id_unique
  ON mnemosyne.mnemo_session (workspace_id, id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_session_source_generation_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_session_source_generation_unique RENAME TO idx_session_source_generation_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_session_source_generation_unique_invalid;

DO $$
DECLARE
  duplicate_workspace text;
  duplicate_host text;
  duplicate_client text;
  duplicate_session text;
  duplicate_generation integer;
  duplicate_count bigint;
BEGIN
  SELECT workspace_id, source_host, source_client_instance_id, source_session_id, source_generation, COUNT(*)
  INTO duplicate_workspace, duplicate_host, duplicate_client, duplicate_session, duplicate_generation, duplicate_count
  FROM mnemosyne.mnemo_session
  WHERE source_host IS NOT NULL AND source_client_instance_id IS NOT NULL
    AND source_session_id IS NOT NULL AND source_generation IS NOT NULL
  GROUP BY workspace_id, source_host, source_client_instance_id, source_session_id, source_generation
  HAVING COUNT(*) > 1
  ORDER BY workspace_id, source_host, source_client_instance_id, source_session_id, source_generation
  LIMIT 1;

  IF duplicate_workspace IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot create idx_session_source_generation_unique: duplicate source identity (workspace_id=%, source_host=%, source_client_instance_id=%, source_session_id=%, source_generation=%, count=%)',
      duplicate_workspace, duplicate_host, duplicate_client, duplicate_session, duplicate_generation, duplicate_count
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_session_source_generation_unique
  ON mnemosyne.mnemo_session (workspace_id, source_host, source_client_instance_id, source_session_id, source_generation)
  WHERE source_host IS NOT NULL AND source_client_instance_id IS NOT NULL
    AND source_session_id IS NOT NULL AND source_generation IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_session_turn_source_message_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_session_turn_source_message_unique RENAME TO idx_session_turn_source_message_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_session_turn_source_message_unique_invalid;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_session_turn_source_message_unique
  ON mnemosyne.mnemo_session_turn (workspace_id, session_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_harness_event_workspace_id_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_harness_event_workspace_id_unique RENAME TO idx_harness_event_workspace_id_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_harness_event_workspace_id_unique_invalid;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_harness_event_workspace_id_unique
  ON mnemosyne.mnemo_harness_ingestion_event (workspace_id, id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_harness_event_id_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_harness_event_id_unique RENAME TO idx_harness_event_id_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_harness_event_id_unique_invalid;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_harness_event_id_unique
  ON mnemosyne.mnemo_harness_ingestion_event (workspace_id, event_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_harness_source_sequence_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_harness_source_sequence_unique RENAME TO idx_harness_source_sequence_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_harness_source_sequence_unique_invalid;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_harness_source_sequence_unique
  ON mnemosyne.mnemo_harness_ingestion_event
    (workspace_id, source_host, source_client_instance_id, source_session_id, enqueue_sequence);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_harness_tombstone_source_message_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_harness_tombstone_source_message_unique RENAME TO idx_harness_tombstone_source_message_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_harness_tombstone_source_message_unique_invalid;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_harness_tombstone_source_message_unique
  ON mnemosyne.mnemo_harness_message_tombstone
    (workspace_id, source_host, source_client_instance_id, source_session_id, source_generation, source_message_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_managed_collapse_operation_workspace_id_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_managed_collapse_operation_workspace_id_unique RENAME TO idx_managed_collapse_operation_workspace_id_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_managed_collapse_operation_workspace_id_unique_invalid;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_managed_collapse_operation_workspace_id_unique
  ON mnemosyne.mnemo_managed_collapse_operation (workspace_id, operation_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_managed_collapse_session_generation_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_managed_collapse_session_generation_unique RENAME TO idx_managed_collapse_session_generation_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_managed_collapse_session_generation_unique_invalid;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_managed_collapse_session_generation_unique
  ON mnemosyne.mnemo_managed_collapse_operation (workspace_id, session_id, source_generation);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_managed_collapse_effect_unique'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_managed_collapse_effect_unique RENAME TO idx_managed_collapse_effect_unique_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_managed_collapse_effect_unique_invalid;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_managed_collapse_effect_unique
  ON mnemosyne.mnemo_managed_collapse_effect (collapse_operation_id, effect_kind, target_kind, target_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_session_managed_activity'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_session_managed_activity RENAME TO idx_session_managed_activity_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_session_managed_activity_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_managed_activity
  ON mnemosyne.mnemo_session (workspace_id, last_activity_at)
  WHERE source_host IS NOT NULL AND status = 'active';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_session_collapse_due'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_session_collapse_due RENAME TO idx_session_collapse_due_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_session_collapse_due_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_collapse_due
  ON mnemosyne.mnemo_session (workspace_id, collapse_next_attempt_at)
  WHERE status = 'collapse_pending';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_session_terminal_retention'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_session_terminal_retention RENAME TO idx_session_terminal_retention_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_session_terminal_retention_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_terminal_retention
  ON mnemosyne.mnemo_session (workspace_id, (COALESCE(collapsed_at, archived_at)), id)
  WHERE source_host IS NOT NULL AND status IN ('collapsed', 'archived');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_harness_event_retryable'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_harness_event_retryable RENAME TO idx_harness_event_retryable_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_harness_event_retryable_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_harness_event_retryable
  ON mnemosyne.mnemo_harness_ingestion_event (workspace_id, received_at)
  WHERE ledger_state = 'retryable';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_harness_loss_session'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_harness_loss_session RENAME TO idx_harness_loss_session_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_harness_loss_session_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_harness_loss_session
  ON mnemosyne.mnemo_harness_loss (workspace_id, session_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_harness_retraction_session'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_harness_retraction_session RENAME TO idx_harness_retraction_session_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_harness_retraction_session_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_harness_retraction_session
  ON mnemosyne.mnemo_harness_retraction (workspace_id, session_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_harness_tombstone_session'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_harness_tombstone_session RENAME TO idx_harness_tombstone_session_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_harness_tombstone_session_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_harness_tombstone_session
  ON mnemosyne.mnemo_harness_message_tombstone (workspace_id, session_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_managed_collapse_effect_pending'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_managed_collapse_effect_pending RENAME TO idx_managed_collapse_effect_pending_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_managed_collapse_effect_pending_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_managed_collapse_effect_pending
  ON mnemosyne.mnemo_managed_collapse_effect (workspace_id, next_attempt_at)
  WHERE status IN ('pending', 'failed');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_extraction_provenance_primitive'
      AND NOT mnemosyne.mnemo_index_definition_matches(i.indexrelid)
  ) THEN
    ALTER INDEX mnemosyne.idx_extraction_provenance_primitive RENAME TO idx_extraction_provenance_primitive_invalid;
  END IF;
END
$$;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_extraction_provenance_primitive_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_extraction_provenance_primitive
  ON mnemosyne.mnemo_extraction_provenance (workspace_id, primitive_kind, primitive_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mnemosyne.mnemo_session_turn'::regclass
      AND conname = 'mnemo_session_turn_session_workspace_fkey'
  ) THEN
    ALTER TABLE mnemosyne.mnemo_session_turn
      ADD CONSTRAINT mnemo_session_turn_session_workspace_fkey
      FOREIGN KEY (ingestion_event_workspace_id, session_id)
      REFERENCES mnemosyne.mnemo_session(workspace_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE mnemosyne.mnemo_session_turn
  VALIDATE CONSTRAINT mnemo_session_turn_session_workspace_fkey;

ALTER TABLE mnemosyne.mnemo_session_turn
  DROP CONSTRAINT IF EXISTS mnemo_session_turn_session_id_fkey;

DO $$
DECLARE
  constraint_spec record;
BEGIN
  FOR constraint_spec IN
    SELECT * FROM (VALUES
      ('mnemo_session_predecessor_workspace_fkey', 'mnemo_session',
       'FOREIGN KEY (workspace_id, predecessor_session_id) REFERENCES mnemosyne.mnemo_session(workspace_id, id) ON DELETE SET NULL (predecessor_session_id)'),
      ('mnemo_session_turn_ingestion_event_workspace_fkey', 'mnemo_session_turn',
       'FOREIGN KEY (ingestion_event_workspace_id, ingestion_event_id) REFERENCES mnemosyne.mnemo_harness_ingestion_event(workspace_id, id) ON DELETE SET NULL (ingestion_event_id)'),
      ('mnemo_harness_ingestion_event_session_workspace_fkey', 'mnemo_harness_ingestion_event',
       'FOREIGN KEY (workspace_id, session_id) REFERENCES mnemosyne.mnemo_session(workspace_id, id)'),
      ('mnemo_harness_loss_session_workspace_fkey', 'mnemo_harness_loss',
       'FOREIGN KEY (workspace_id, session_id) REFERENCES mnemosyne.mnemo_session(workspace_id, id) ON DELETE CASCADE'),
      ('mnemo_harness_loss_event_workspace_fkey', 'mnemo_harness_loss',
       'FOREIGN KEY (workspace_id, ingestion_event_id) REFERENCES mnemosyne.mnemo_harness_ingestion_event(workspace_id, id) ON DELETE RESTRICT'),
      ('mnemo_harness_retraction_session_workspace_fkey', 'mnemo_harness_retraction',
       'FOREIGN KEY (workspace_id, session_id) REFERENCES mnemosyne.mnemo_session(workspace_id, id) ON DELETE CASCADE'),
      ('mnemo_harness_retraction_event_workspace_fkey', 'mnemo_harness_retraction',
       'FOREIGN KEY (workspace_id, ingestion_event_id) REFERENCES mnemosyne.mnemo_harness_ingestion_event(workspace_id, id) ON DELETE RESTRICT'),
      ('mnemo_harness_retraction_predecessor_workspace_fkey', 'mnemo_harness_retraction',
       'FOREIGN KEY (workspace_id, predecessor_session_id) REFERENCES mnemosyne.mnemo_session(workspace_id, id) ON DELETE SET NULL (predecessor_session_id)'),
      ('mnemo_harness_tombstone_session_workspace_fkey', 'mnemo_harness_message_tombstone',
       'FOREIGN KEY (workspace_id, session_id) REFERENCES mnemosyne.mnemo_session(workspace_id, id)'),
      ('mnemo_managed_collapse_operation_session_workspace_fkey', 'mnemo_managed_collapse_operation',
       'FOREIGN KEY (workspace_id, session_id) REFERENCES mnemosyne.mnemo_session(workspace_id, id) ON DELETE RESTRICT'),
      ('mnemo_managed_collapse_effect_operation_workspace_fkey', 'mnemo_managed_collapse_effect',
       'FOREIGN KEY (workspace_id, collapse_operation_id) REFERENCES mnemosyne.mnemo_managed_collapse_operation(workspace_id, operation_id) ON DELETE CASCADE'),
      ('mnemo_extraction_provenance_operation_workspace_fkey', 'mnemo_extraction_provenance',
       'FOREIGN KEY (workspace_id, collapse_operation_id) REFERENCES mnemosyne.mnemo_managed_collapse_operation(workspace_id, operation_id) ON DELETE CASCADE'),
      ('mnemo_extraction_provenance_session_workspace_fkey', 'mnemo_extraction_provenance',
       'FOREIGN KEY (workspace_id, session_id) REFERENCES mnemosyne.mnemo_session(workspace_id, id) ON DELETE RESTRICT')
    ) AS constraints(name, table_name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('mnemosyne.%I', constraint_spec.table_name)::regclass
        AND conname = constraint_spec.name
    ) THEN
      EXECUTE format(
        'ALTER TABLE mnemosyne.%I ADD CONSTRAINT %I %s NOT VALID',
        constraint_spec.table_name,
        constraint_spec.name,
        constraint_spec.definition
      );
    END IF;

    EXECUTE format(
      'ALTER TABLE mnemosyne.%I VALIDATE CONSTRAINT %I',
      constraint_spec.table_name,
      constraint_spec.name
    );
  END LOOP;
END
$$;

ALTER TABLE mnemosyne.mnemo_harness_ingestion_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_ingestion_event FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_workspace_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_workspace_control FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_loss ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_loss FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_retraction ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_retraction FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_message_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_harness_message_tombstone FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_managed_collapse_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_managed_collapse_operation FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_managed_collapse_effect ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_managed_collapse_effect FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_extraction_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_extraction_provenance FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
  policy_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'mnemo_harness_ingestion_event', 'mnemo_harness_workspace_control',
    'mnemo_harness_loss', 'mnemo_harness_retraction',
    'mnemo_harness_message_tombstone', 'mnemo_managed_collapse_operation',
    'mnemo_managed_collapse_effect', 'mnemo_extraction_provenance'
  ] LOOP
    policy_name := table_name || '_ws';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'mnemosyne' AND c.relname = table_name AND p.polname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON mnemosyne.%I USING ((workspace_id)::uuid = current_setting(''mnemosyne.workspace_id'', true)::uuid) WITH CHECK ((workspace_id)::uuid = current_setting(''mnemosyne.workspace_id'', true)::uuid)',
        policy_name,
        table_name
      );
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON TABLE mnemosyne.mnemo_harness_ingestion_event TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE ON TABLE mnemosyne.mnemo_harness_workspace_control TO mnemo_app_role;
GRANT SELECT, INSERT ON TABLE mnemosyne.mnemo_harness_loss TO mnemo_app_role;
GRANT SELECT, INSERT ON TABLE mnemosyne.mnemo_harness_retraction TO mnemo_app_role;
GRANT SELECT, INSERT ON TABLE mnemosyne.mnemo_harness_message_tombstone TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE ON TABLE mnemosyne.mnemo_managed_collapse_operation TO mnemo_app_role;
GRANT SELECT, INSERT, UPDATE ON TABLE mnemosyne.mnemo_managed_collapse_effect TO mnemo_app_role;
GRANT SELECT, INSERT ON TABLE mnemosyne.mnemo_extraction_provenance TO mnemo_app_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA mnemosyne
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mnemo_app_role;
