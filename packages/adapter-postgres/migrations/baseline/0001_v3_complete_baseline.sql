-- migrate:no-transaction
-- migrate:allow-non-concurrent-index reason=fresh-install-tables-are-empty-locks-are-instantaneous
-- migrate:allow-table-locks reason=fresh-install-all-tables-are-new-ADD-CONSTRAINT-locks-are-instantaneous
-- =============================================================================
-- Mnemosyne — Complete Schema Baseline (regenerated 2026-07-08)
-- squash-of: 0002_fix_mnemo_fact_columns.sql, 0003_fix_mnemo_session_id_default.sql,
--            0004_fix_app_user_role_grant.sql, 0005_fix_app_user_schema_access.sql,
--            0006_multi_tenant_rls.sql, 0007_fact_scope_owner.sql,
--            0008_session_active_prompt_version_index.sql, 0009_workspace_mode_graduation.sql,
--            0010_api_key_type_constraint.sql, 0011_seed_builtin_composition_rules.sql,
--            0012_decision_embedding_version.sql, 0013_init_materialized_views.sql,
--            0014_grant_semantic_neighbor.sql, 0015_personal_scope.sql,
--            0016_clean_scope_constraint.sql, 0017_attribution_columns.sql,
--            0018_idx_fact_actor.sql, 0019_api_key_max_sensitivity.sql,
--            0020_workspace_member_rls.sql
-- =============================================================================


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- ---------------------------------------------------------------------------
-- Roles (idempotent — safe to re-run on existing databases)
-- pg_dump --schema-only does not dump cluster-level roles, so we recreate
-- them here. All blocks use IF NOT EXISTS to be safe on existing DBs.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemo_app_role') THEN
    CREATE ROLE mnemo_app_role;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemo_v3_app_role') THEN
    CREATE ROLE mnemo_v3_app_role;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemo_owner') THEN
    CREATE ROLE mnemo_owner;
  END IF;
END
$$;

-- app_user: the SET LOCAL ROLE target used by withMnemoTx to enforce RLS.
-- Inherits mnemo_app_role privileges (USAGE on schema, table-level grants).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user;
    GRANT mnemo_app_role TO app_user;
  END IF;
END
$$;

--
-- Name: mnemosyne; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS mnemosyne;

CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;


--
-- Name: mnemo_decision_set_updated_at(); Type: FUNCTION; Schema: mnemosyne; Owner: -
-- pg_dump captured triggers referencing public.mnemo_decision_set_updated_at() and
-- public.mnemo_fact_set_updated_at(), but those functions live in public which
-- pg_dump --schema=mnemosyne skips. We define them in mnemosyne instead.
--

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_decision_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: mnemo_fact_set_updated_at(); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_fact_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: create_audit_partition(integer, integer); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.create_audit_partition(p_year integer, p_month integer) RETURNS text
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


--
-- Name: mnemo_audit_create_next_partition(); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.mnemo_audit_create_next_partition() RETURNS void
    LANGUAGE plpgsql
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


--
-- Name: mnemo_audit_immutable(); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.mnemo_audit_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION
    'mnemo_audit_log is append-only. Updates and deletes are forbidden. '
    'Operation: %, Table: mnemo_audit_log',
    TG_OP;
END;
$$;


--
-- Name: mnemo_deletion_log_immutable(); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.mnemo_deletion_log_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION
    'mnemo_deletion_log is append-only. Updates and deletes are forbidden. '
    'Operation: %, Table: mnemo_deletion_log',
    TG_OP;
END;
$$;


--
-- Name: mnemo_metacognition_trends(uuid); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.mnemo_metacognition_trends(p_workspace_id uuid) RETURNS TABLE(recall_hit_rate_cur numeric, recall_hit_rate_prev numeric, avg_recall_latency_cur numeric, avg_recall_latency_prev numeric, session_collapse_qual_cur numeric, session_collapse_qual_prev numeric, strategy_success_rate_cur numeric, strategy_success_rate_prev numeric)
    LANGUAGE sql SECURITY DEFINER
    AS $$
  WITH rl AS (
    SELECT
      COUNT(*) FILTER (WHERE hit_rank IS NOT NULL AND recalled_at >= NOW() - INTERVAL '7 days')::numeric  AS hits_cur,
      COUNT(*) FILTER (WHERE recalled_at >= NOW() - INTERVAL '7 days')::numeric                            AS total_cur,
      COUNT(*) FILTER (WHERE hit_rank IS NOT NULL AND recalled_at >= NOW() - INTERVAL '14 days' AND recalled_at < NOW() - INTERVAL '7 days')::numeric AS hits_prev,
      COUNT(*) FILTER (WHERE recalled_at >= NOW() - INTERVAL '14 days' AND recalled_at < NOW() - INTERVAL '7 days')::numeric AS total_prev,
      AVG(latency_ms) FILTER (WHERE recalled_at >= NOW() - INTERVAL '7 days')                              AS lat_cur,
      AVG(latency_ms) FILTER (WHERE recalled_at >= NOW() - INTERVAL '14 days' AND recalled_at < NOW() - INTERVAL '7 days') AS lat_prev
    FROM mnemosyne.mnemo_recall_log WHERE workspace_id = p_workspace_id
  ),
  sc AS (
    SELECT
      AVG(CASE outcome_rating WHEN 'success' THEN 1 WHEN 'neutral' THEN 0.5 ELSE 0 END) FILTER (WHERE collapsed_at >= NOW() - INTERVAL '7 days')  AS q_cur,
      AVG(CASE outcome_rating WHEN 'success' THEN 1 WHEN 'neutral' THEN 0.5 ELSE 0 END) FILTER (WHERE collapsed_at >= NOW() - INTERVAL '14 days' AND collapsed_at < NOW() - INTERVAL '7 days') AS q_prev
    FROM mnemosyne.mnemo_session WHERE workspace_id = p_workspace_id::text AND collapsed_at IS NOT NULL
  ),
  st AS (
    SELECT
      AVG(worth) FILTER (WHERE updated_at >= NOW() - INTERVAL '7 days')  AS s_cur,
      AVG(worth) FILTER (WHERE updated_at >= NOW() - INTERVAL '14 days' AND updated_at < NOW() - INTERVAL '7 days') AS s_prev
    FROM mnemosyne.mnemo_strategy WHERE workspace_id = p_workspace_id::text
  )
  SELECT
    COALESCE(rl.hits_cur / NULLIF(rl.total_cur, 0), 0),
    COALESCE(rl.hits_prev / NULLIF(rl.total_prev, 0), 0),
    COALESCE(rl.lat_cur, 0), COALESCE(rl.lat_prev, 0),
    COALESCE(sc.q_cur, 0), COALESCE(sc.q_prev, 0),
    COALESCE(st.s_cur, 0), COALESCE(st.s_prev, 0)
  FROM rl, sc, st;
$$;


--
-- Name: mnemo_refresh_anticipation(); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.mnemo_refresh_anticipation() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'public'
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mnemosyne.mv_sequential_patterns;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mnemosyne.mv_periodic_patterns;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mnemosyne.mv_conditional_patterns;
END;
$$;


--
-- Name: mnemo_refresh_metacognition(); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.mnemo_refresh_metacognition() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mnemosyne.mv_confidence_map;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mnemosyne.mv_knowledge_gaps;
END;
$$;


--
-- Name: mnemo_seed_builtin_rules(uuid); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.mnemo_seed_builtin_rules(p_workspace_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  inserted integer;
BEGIN
  PERFORM set_config('mnemosyne.workspace_id', p_workspace_id::text, true);
  INSERT INTO mnemosyne.mnemo_composition_rule
    (id, workspace_id, name, description, condition_dsl, action_dsl, priority, is_active, source, metadata)
  SELECT
    p_workspace_id::text || ':' || t.id,
    p_workspace_id::text,
    t.name, t.description, t.condition_dsl, t.action_dsl, t.priority, true, 'imported', '{}'::jsonb
  FROM mnemosyne.mnemo_composition_rule_template t
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;


--
-- Name: mnemo_set_workspace(uuid); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.mnemo_set_workspace(wid uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM set_config('mnemosyne.workspace_id', wid::text, true);
END;
$$;


--
-- Name: prune_audit_partitions(integer); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.prune_audit_partitions(p_retain_months integer DEFAULT 84) RETURNS integer
    LANGUAGE plpgsql
    AS $_$
DECLARE
  v_cutoff  DATE;
  v_rec     RECORD;
  v_pdate   DATE;
  v_dropped INT := 0;
BEGIN
  IF p_retain_months < 1 THEN
    RAISE EXCEPTION 'p_retain_months must be >= 1, got %', p_retain_months;
  END IF;

  v_cutoff := DATE_TRUNC('month', NOW() - (p_retain_months || ' months')::INTERVAL);

  FOR v_rec IN
    SELECT c.relname
    FROM   pg_class     c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   pg_inherits  i ON i.inhrelid = c.oid
    JOIN   pg_class     p ON p.oid = i.inhparent
    WHERE  n.nspname  = 'mnemosyne'
      AND  p.relname  = 'mnemo_audit_log'
      AND  c.relname  ~ '^mnemo_audit_log_y\d{4}m\d{2}$'
    ORDER BY c.relname
  LOOP
    -- Parse partition start from suffix  y<YYYY>m<MM>
    v_pdate := TO_DATE(
      REGEXP_REPLACE(v_rec.relname, '^mnemo_audit_log_y', '') ,
      'YYYYmMM'
    );
    IF v_pdate < v_cutoff THEN
      -- migrate:allow-drop reason=audit partition older than 7-year retention floor
      EXECUTE format('DROP TABLE IF EXISTS mnemosyne.%I', v_rec.relname);
      v_dropped := v_dropped + 1;
      RAISE NOTICE 'prune_audit_partitions: dropped % (< %)', v_rec.relname, v_cutoff;
    END IF;
  END LOOP;

  RETURN v_dropped;
END;
$_$;


--
-- Name: purge_outbox(interval); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.purge_outbox(p_older_than interval DEFAULT '7 days'::interval) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM mnemo_outbox
  WHERE  processed_at IS NOT NULL
    AND  processed_at < now() - p_older_than;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


--
-- Name: update_migration_cursor_updated_at(); Type: FUNCTION; Schema: mnemosyne; Owner: -
--

CREATE FUNCTION mnemosyne.update_migration_cursor_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: mnemo_access_policy; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_access_policy (
    id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text NOT NULL,
    read_scopes text[] DEFAULT '{}'::text[] NOT NULL,
    write_scopes text[] DEFAULT '{}'::text[] NOT NULL,
    self_edit jsonb DEFAULT '{"enabled": false}'::jsonb NOT NULL,
    task_scopes jsonb DEFAULT '{"canCreate": false, "canDelegate": false, "canDelegateTo": []}'::jsonb NOT NULL,
    limits jsonb DEFAULT '{"maxWritesPerMinute": 120, "maxRecallsPerMinute": 600, "maxSessionsConcurrent": 10, "maxSelfEditsPerSession": 3}'::jsonb NOT NULL,
    require_approval_for text[] DEFAULT '{}'::text[] NOT NULL,
    federation_access text DEFAULT 'none'::text NOT NULL,
    namespaces text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_access_policy_federation_access_check CHECK ((federation_access = ANY (ARRAY['none'::text, 'read'::text, 'read_write'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_access_policy FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_actor_dek; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_actor_dek (
    id text NOT NULL,
    workspace_id text NOT NULL,
    actor_id text NOT NULL,
    encrypted_key bytea,
    algorithm text DEFAULT 'AES-256-GCM'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    destroyed_at timestamp with time zone,
    CONSTRAINT mnemo_actor_dek_check CHECK (((destroyed_at IS NULL) OR (destroyed_at >= created_at))),
    CONSTRAINT mnemo_actor_dek_check1 CHECK (((status <> 'destroyed'::text) OR (encrypted_key IS NULL))),
    CONSTRAINT mnemo_actor_dek_status_check CHECK ((status = ANY (ARRAY['active'::text, 'destroyed'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_actor_dek FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_agent_profile; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_agent_profile (
    workspace_id uuid NOT NULL,
    agent_id text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_agent_profile FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_analogy_map; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_analogy_map (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    source_type text NOT NULL,
    target_id uuid NOT NULL,
    target_type text NOT NULL,
    similarity numeric(6,4) NOT NULL,
    mapping_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_analogy_map_mapping_type_check CHECK ((mapping_type = ANY (ARRAY['structural'::text, 'semantic'::text, 'functional'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_analogy_map FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_api_keys; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_api_keys (
    id text NOT NULL,
    workspace_id text NOT NULL,
    key_hash text NOT NULL,
    name text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    plan text DEFAULT 'free'::text NOT NULL,
    lookup_hash text,
    ip_allowlist text[] DEFAULT '{}'::text[] NOT NULL,
    deprecated_at timestamp with time zone,
    label text DEFAULT ''::text NOT NULL,
    user_id text,
    tenant_id text,
    key_kind text DEFAULT 'workspace'::text NOT NULL,
    max_sensitivity text,
    CONSTRAINT mnemo_api_keys_key_kind_check CHECK ((key_kind = ANY (ARRAY['workspace'::text, 'user'::text, 'tenant'::text, 'admin'::text]))),
    CONSTRAINT mnemo_api_keys_max_sensitivity_check CHECK ((max_sensitivity IS NULL) OR (max_sensitivity = ANY (ARRAY['public'::text, 'internal'::text, 'confidential'::text, 'restricted'::text])))
);


--
-- Name: mnemo_approval_request; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_approval_request (
    id text NOT NULL,
    workspace_id text NOT NULL,
    requested_by text NOT NULL,
    trigger text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_by text,
    resolved_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_approval_request_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_approval_request FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_audit_log; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
)
PARTITION BY RANGE (created_at);

ALTER TABLE ONLY mnemosyne.mnemo_audit_log FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_audit_log_id_seq; Type: SEQUENCE; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mnemosyne.mnemo_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mnemo_audit_log_y2026m01; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m01 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m02; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m02 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m03; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m03 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m04; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m04 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m05; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m05 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m06; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m06 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m07; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m07 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m08; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m08 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m09; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m09 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m10; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m10 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m11; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m11 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_audit_log_y2026m12; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_audit_log_y2026m12 (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_hash bytea,
    is_terminal boolean DEFAULT false NOT NULL,
    actor_dek_id text,
    entry_uid uuid,
    CONSTRAINT audit_merkle_integrity CHECK ((((is_terminal = false) AND (merkle_hash IS NOT NULL)) OR ((is_terminal = true) AND (merkle_hash IS NULL)))),
    CONSTRAINT mnemo_audit_log_action_check CHECK ((action = ANY (ARRAY['recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text, 'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text, 'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text, 'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text, 'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text, 'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text, 'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text, 'ip_denied'::text]))),
    CONSTRAINT mnemo_audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text, 'federation'::text])))
);


--
-- Name: mnemo_break_glass_request; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_break_glass_request (
    id text NOT NULL,
    workspace_id text NOT NULL,
    requested_by text NOT NULL,
    reason text NOT NULL,
    requested_scopes text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    approved_by text,
    approved_at timestamp with time zone,
    used_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_break_glass_request_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text, 'used'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_break_glass_request FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_causal_chain; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_causal_chain (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    cause_id uuid NOT NULL,
    cause_type text NOT NULL,
    effect_id uuid NOT NULL,
    effect_type text NOT NULL,
    confidence numeric(6,4) DEFAULT 0.5 NOT NULL,
    lag_seconds integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_causal_chain FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_citation; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_citation (
    id text NOT NULL,
    workspace_id text NOT NULL,
    memory_kind text NOT NULL,
    memory_id text NOT NULL,
    source_kind text NOT NULL,
    source_id text,
    extractor_model text,
    extractor_prompt_version text,
    judge_model text,
    judge_relation_id text,
    evidence_excerpt text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_citation_memory_kind_check CHECK ((memory_kind = ANY (ARRAY['fact'::text, 'decision'::text, 'entity'::text, 'episode'::text]))),
    CONSTRAINT mnemo_citation_source_kind_check CHECK ((source_kind = ANY (ARRAY['message'::text, 'document'::text, 'tool_call'::text, 'llm_extraction'::text, 'user_edit'::text, 'agent_save'::text, 'imported'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_citation FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_composition_rule; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_composition_rule (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    description text,
    condition_dsl jsonb NOT NULL,
    action_dsl jsonb NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    execution_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    source text DEFAULT 'manual'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_composition_rule FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_composition_rule_template; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_composition_rule_template (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    condition_dsl jsonb NOT NULL,
    action_dsl jsonb NOT NULL,
    priority integer DEFAULT 100 NOT NULL
);


--
-- Name: mnemo_consolidation_lock; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_consolidation_lock (
    workspace_id uuid NOT NULL,
    locked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mnemo_contradiction_queue; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_contradiction_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    fact_a_id text NOT NULL,
    fact_b_id text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    contradiction_type text NOT NULL,
    confidence numeric(6,4) NOT NULL,
    resolved_at timestamp with time zone,
    resolution text,
    resolved_by text,
    CONSTRAINT mnemo_contradiction_queue_contradiction_type_check CHECK ((contradiction_type = ANY (ARRAY['direct'::text, 'temporal'::text, 'probabilistic'::text]))),
    CONSTRAINT mnemo_contradiction_queue_resolution_check CHECK ((resolution = ANY (ARRAY['fact_a_wins'::text, 'fact_b_wins'::text, 'both_kept'::text, 'both_archived'::text, 'merged'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_contradiction_queue FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_decision; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_decision (
    id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text,
    actor_id text,
    conversation_id text,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    topic_key text,
    revision_count integer DEFAULT 1 NOT NULL,
    normalized_hash text NOT NULL,
    decided_by_user_id text,
    embedding public.vector(1536),
    embedding_model text,
    embedding_version text,
    text_lemmatized tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(body, ''::text)))) STORED,
    status text DEFAULT 'active'::text NOT NULL,
    superseded_by_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    confidence real,
    scope_owner text,
    embedding_stale boolean DEFAULT false NOT NULL,
    CONSTRAINT mnemo_decision_kind_check CHECK ((kind = ANY (ARRAY['decision'::text, 'architecture'::text, 'policy'::text, 'process'::text, 'bugfix'::text, 'learning'::text, 'discovery'::text, 'config'::text]))),
    CONSTRAINT mnemo_decision_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'withdrawn'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_decision FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_deletion_log; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_deletion_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    deleted_item_id uuid NOT NULL,
    deleted_item_type text NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL,
    deletion_type text NOT NULL,
    actor_id text NOT NULL,
    reason text,
    CONSTRAINT mnemo_deletion_log_deletion_type_check CHECK ((deletion_type = ANY (ARRAY['soft'::text, 'hard'::text, 'gdpr_erasure'::text, 'federation_tombstone'::text])))
);


--
-- Name: mnemo_embedding_cache; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_embedding_cache (
    id text NOT NULL,
    workspace_id text NOT NULL,
    text_hash text NOT NULL,
    embedding public.halfvec(1536) NOT NULL,
    model text NOT NULL,
    hit_count integer DEFAULT 1 NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_embedding_cache FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_encryption_keys; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_encryption_keys (
    id text NOT NULL,
    workspace_id text NOT NULL,
    key_id text NOT NULL,
    algorithm text DEFAULT 'AES-256-GCM'::text NOT NULL,
    purpose text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    rotated_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_encryption_keys FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_entity; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_entity (
    id text NOT NULL,
    workspace_id text NOT NULL,
    actor_id text,
    agent_id text,
    name text NOT NULL,
    kind text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    canonical_id text,
    description text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    mention_count integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scope_owner text,
    CONSTRAINT mnemo_entity_kind_check CHECK ((kind = ANY (ARRAY['person'::text, 'organization'::text, 'project'::text, 'concept'::text, 'place'::text, 'other'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_entity FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_episode; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_episode (
    id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text,
    actor_id text,
    title text NOT NULL,
    narrative text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    duration_minutes integer,
    participants text[] DEFAULT '{}'::text[] NOT NULL,
    topics text[] DEFAULT '{}'::text[] NOT NULL,
    linked_fact_ids text[] DEFAULT '{}'::text[] NOT NULL,
    source_conversation_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_synthetic boolean DEFAULT false NOT NULL,
    scope_owner text,
    parent_episode_id text,
    delta_content text,
    is_root boolean DEFAULT false NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    embedding public.halfvec(1536),
    embedding_model text,
    embedding_stale boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_episode FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_event; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_event (
    id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text,
    type text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    duration_s integer,
    source text NOT NULL,
    related_entities text[] DEFAULT '{}'::text[] NOT NULL,
    annotations jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    scope_owner text,
    CONSTRAINT mnemo_event_type_check CHECK ((type = ANY (ARRAY['system'::text, 'external'::text, 'user'::text, 'agent'::text, 'scheduled'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_event FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_fact; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_fact (
    id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text,
    scope text NOT NULL,
    scope_ref text,
    kind text NOT NULL,
    subject text NOT NULL,
    statement text NOT NULL,
    confidence real DEFAULT 0.7 NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    relevance real DEFAULT 1.0 NOT NULL,
    hit_count integer DEFAULT 0 NOT NULL,
    last_recalled_at timestamp with time zone,
    source_message_ids text[] DEFAULT '{}'::text[] NOT NULL,
    attributed_to text,
    linked_memory_ids text[] DEFAULT '{}'::text[] NOT NULL,
    embedding public.halfvec(1536),
    embedding_model text,
    embedding_version text,
    text_lemmatized tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(statement, ''::text))) STORED,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    merged_into_id text,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    memory_type text DEFAULT 'semantic'::text NOT NULL,
    attribution text DEFAULT 'inferred'::text NOT NULL,
    actor_id text,
    entity_id text,
    protocol_version text DEFAULT 'v1.1'::text NOT NULL,
    memory_strength double precision DEFAULT 1.0 NOT NULL,
    memory_stability double precision DEFAULT 1.0 NOT NULL,
    last_strength_update timestamp with time zone,
    episode_id text,
    sensitivity text DEFAULT 'internal'::text NOT NULL,
    worth_success numeric(10,4) DEFAULT 0 NOT NULL,
    worth_failure numeric(10,4) DEFAULT 0 NOT NULL,
    worth_alpha numeric(8,4) DEFAULT 2.0 NOT NULL,
    worth_beta numeric(8,4) DEFAULT 2.0 NOT NULL,
    worth numeric(6,4) GENERATED ALWAYS AS ((worth_alpha / NULLIF((worth_alpha + worth_beta), (0)::numeric))) STORED,
    canonical boolean DEFAULT false NOT NULL,
    session_id text,
    extraction_source text,
    topic_key text,
    revision_count integer DEFAULT 1 NOT NULL,
    embedding_stale boolean DEFAULT false NOT NULL,
    scope_owner text,
    CONSTRAINT mnemo_fact_attributed_to_check CHECK ((attributed_to = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text]))),
    CONSTRAINT mnemo_fact_attribution_check CHECK ((attribution = ANY (ARRAY['user_stated'::text, 'user_belief'::text, 'objective_fact'::text, 'inferred'::text]))),
    CONSTRAINT mnemo_fact_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT mnemo_fact_kind_check CHECK ((kind = ANY (ARRAY['preference'::text, 'trait'::text, 'event'::text, 'relationship'::text, 'skill'::text, 'concern'::text, 'other'::text]))),
    CONSTRAINT mnemo_fact_memory_type_check CHECK ((memory_type = ANY (ARRAY['semantic'::text, 'episodic'::text, 'procedural'::text, 'working'::text]))),
    CONSTRAINT mnemo_fact_relevance_check CHECK (((relevance >= (0)::double precision) AND (relevance <= (1)::double precision))),
    CONSTRAINT mnemo_fact_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'conversation'::text, 'employee'::text, 'team'::text]))),
    CONSTRAINT mnemo_fact_sensitivity_check CHECK ((sensitivity = ANY (ARRAY['public'::text, 'internal'::text, 'confidential'::text, 'restricted'::text]))),
    CONSTRAINT mnemo_fact_status_check CHECK ((status = ANY (ARRAY['active'::text, 'merged'::text, 'forgotten'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_fact FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_fact_archive; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_fact_archive (
    id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text,
    scope text NOT NULL,
    scope_ref text,
    kind text NOT NULL,
    subject text NOT NULL,
    statement text NOT NULL,
    confidence numeric(3,2) NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    relevance numeric(4,3) NOT NULL,
    hit_count integer DEFAULT 0 NOT NULL,
    last_recalled_at timestamp with time zone,
    source_message_ids text[] DEFAULT '{}'::text[] NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    original_status text NOT NULL,
    merged_into_id text,
    archived_at timestamp with time zone DEFAULT now() NOT NULL,
    archive_reason text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    sensitivity text DEFAULT 'internal'::text NOT NULL,
    worth_success numeric(10,4) DEFAULT 0 NOT NULL,
    worth_failure numeric(10,4) DEFAULT 0 NOT NULL,
    worth_alpha numeric(8,4) DEFAULT 2.0 NOT NULL,
    worth_beta numeric(8,4) DEFAULT 2.0 NOT NULL,
    worth numeric(6,4) GENERATED ALWAYS AS ((worth_alpha / NULLIF((worth_alpha + worth_beta), (0)::numeric))) STORED,
    canonical boolean DEFAULT false NOT NULL,
    session_id text,
    extraction_source text,
    topic_key text,
    revision_count integer DEFAULT 1 NOT NULL,
    embedding_stale boolean DEFAULT false NOT NULL,
    CONSTRAINT mnemo_fact_archive_sensitivity_check CHECK ((sensitivity = ANY (ARRAY['public'::text, 'internal'::text, 'confidential'::text, 'restricted'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_fact_archive FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_fact_hash; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_fact_hash (
    workspace_id text NOT NULL,
    statement_hash text NOT NULL,
    fact_id text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    seen_count integer DEFAULT 1 NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_fact_hash FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_fact_lsh; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_fact_lsh (
    workspace_id text NOT NULL,
    fact_id text NOT NULL,
    band_idx smallint NOT NULL,
    band_hash bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_fact_lsh FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_federated_item; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_federated_item (
    local_id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    remote_id text NOT NULL,
    peer_domain text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    attribution text DEFAULT 'federation_received'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_federated_item_attribution_check CHECK ((attribution = 'federation_received'::text))
);

ALTER TABLE ONLY mnemosyne.mnemo_federated_item FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_health; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_health (
    id text NOT NULL,
    workspace_id text NOT NULL,
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL,
    fact_count_active integer NOT NULL,
    fact_count_archived integer NOT NULL,
    fact_count_embedded integer NOT NULL,
    fact_count_unembedded integer NOT NULL,
    decision_count_active integer NOT NULL,
    relation_count_conflicts integer NOT NULL,
    facts_with_zero_hits integer NOT NULL,
    recall_hit_rate_30d numeric(4,3),
    extraction_jobs_failed_7d integer NOT NULL,
    extraction_jobs_deferred integer NOT NULL,
    computed_in_ms integer NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_health FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_hot_tier_snapshot; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_hot_tier_snapshot (
    workspace_id uuid NOT NULL,
    cache_key text NOT NULL,
    score double precision NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    dumped_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mnemo_hyperedge; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_hyperedge (
    id text NOT NULL,
    workspace_id text NOT NULL,
    member_ids text[] NOT NULL,
    label text,
    description text,
    context_query text,
    context_embedding public.halfvec(1536),
    activation_count integer DEFAULT 0 NOT NULL,
    worth real DEFAULT 0.5 NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT min_members CHECK ((array_length(member_ids, 1) >= 3))
);

ALTER TABLE ONLY mnemosyne.mnemo_hyperedge FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_idempotency_keys; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_idempotency_keys (
    workspace_id text NOT NULL,
    key text NOT NULL,
    request_hash text NOT NULL,
    recovery_point text DEFAULT 'started'::text NOT NULL,
    locked_at timestamp with time zone DEFAULT now() NOT NULL,
    response_code integer,
    response_body text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_idempotency_keys FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_inference_log; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_inference_log (
    id text NOT NULL,
    workspace_id text NOT NULL,
    rule_id text NOT NULL,
    input_fact_ids text[] NOT NULL,
    derived_kind text,
    derived_id text,
    confidence numeric(6,4) NOT NULL,
    rationale text,
    triggered_by_query text,
    conversation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_inference_log FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_key_escrow; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_key_escrow (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    key_id text NOT NULL,
    prefix text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    escrowed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_key_escrow_action_check CHECK ((action = ANY (ARRAY['rotate'::text, 'revoke'::text, 'break_glass'::text]))),
    CONSTRAINT mnemo_key_escrow_prefix_check CHECK ((prefix = ANY (ARRAY['mk_live_'::text, 'mk_test_'::text, 'mk_sess_'::text, 'mk_fed_'::text, 'mk_admin_'::text])))
);


--
-- Name: mnemo_meter_event; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_meter_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    operation text NOT NULL,
    units numeric DEFAULT 1 NOT NULL,
    cost_usd numeric DEFAULT 0 NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_meter_event FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_migration_cursor; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_migration_cursor (
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    last_created_at timestamp with time zone NOT NULL,
    last_id text NOT NULL,
    total_migrated integer DEFAULT 0 NOT NULL,
    total_errors integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_migration_cursor_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_migration_cursor FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_outbox; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    processed_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone,
    CONSTRAINT mnemo_outbox_event_type_check CHECK ((event_type = ANY (ARRAY['vector_upsert'::text, 'vector_delete'::text, 'cache_bust'::text, 'cache_set'::text, 'queue_job'::text, 'webhook_fire'::text, 'hyperedge_bump'::text, 'lsh_upsert'::text])))
);


--
-- Name: mnemo_plugin_state; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_plugin_state (
    id text NOT NULL,
    workspace_id text NOT NULL,
    plugin_id text NOT NULL,
    cursor text,
    last_synced_at timestamp with time zone,
    error_count integer DEFAULT 0 NOT NULL,
    last_error text,
    state jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_plugin_state FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_prime_ctx; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_prime_ctx (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    session_id text NOT NULL,
    fact_id text NOT NULL,
    trigger_type text NOT NULL,
    confidence numeric(6,4) NOT NULL,
    injected_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_prime_ctx_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['periodic'::text, 'sequential'::text, 'conditional'::text, 'entity'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_prime_ctx FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_prompt_version; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_prompt_version (
    id text NOT NULL,
    workspace_id text NOT NULL,
    prompt_key text NOT NULL,
    version integer NOT NULL,
    content text NOT NULL,
    performance_score real,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_id text DEFAULT ''::text NOT NULL,
    prompt_text text,
    diff_from_previous text,
    algorithm text DEFAULT 'manual'::text NOT NULL,
    trajectories_used integer,
    avg_score_before real,
    avg_score_after real,
    status text DEFAULT 'candidate'::text NOT NULL,
    activated_at timestamp with time zone
);

ALTER TABLE ONLY mnemosyne.mnemo_prompt_version FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_query_cache; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_query_cache (
    id text NOT NULL,
    workspace_id text NOT NULL,
    query_embedding public.vector(1536) NOT NULL,
    result_memory_ids text[] NOT NULL,
    result_memory_kinds text[] NOT NULL,
    scope text,
    scope_ref text,
    agent_id text,
    top_k integer NOT NULL,
    hit_count integer DEFAULT 1 NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_query_cache FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_reasoning; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_reasoning (
    id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text,
    question text NOT NULL,
    chain jsonb DEFAULT '[]'::jsonb NOT NULL,
    conclusion text NOT NULL,
    success_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    topic_key text,
    embedding public.halfvec(1536),
    embedding_model text,
    embedding_stale boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_used_at timestamp with time zone,
    usage_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    worth_alpha numeric(8,4) DEFAULT 1.0 NOT NULL,
    worth_beta numeric(8,4) DEFAULT 1.0 NOT NULL,
    worth real GENERATED ALWAYS AS ((worth_alpha / NULLIF((worth_alpha + worth_beta), (0)::numeric))) STORED,
    scope_owner text
);

ALTER TABLE ONLY mnemosyne.mnemo_reasoning FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_recall_log; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_recall_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    fact_id text NOT NULL,
    session_id text,
    recalled_at timestamp with time zone DEFAULT now() NOT NULL,
    query_text text,
    hit_rank integer,
    td_credit numeric(8,6) DEFAULT 0,
    activation_score numeric(6,4),
    memory_id uuid,
    recall_score real DEFAULT 0.0 NOT NULL,
    latency_ms integer
);


--
-- Name: mnemo_relation; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_relation (
    id text NOT NULL,
    workspace_id text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    relation text NOT NULL,
    judgment_status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    evidence jsonb,
    confidence real,
    marked_by_user_id text,
    marked_by_kind text DEFAULT 'system'::text NOT NULL,
    marked_by_model text,
    marked_by_prompt_version text,
    conversation_id text,
    superseded_by_relation_id text,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provenance text,
    hebbian_weight real DEFAULT 1.0 NOT NULL,
    co_recall_count integer DEFAULT 0 NOT NULL,
    directionality real DEFAULT 0.0 NOT NULL,
    last_co_recall_at timestamp with time zone,
    CONSTRAINT mnemo_relation_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT mnemo_relation_judgment_status_check CHECK ((judgment_status = ANY (ARRAY['pending'::text, 'judged'::text, 'dismissed'::text]))),
    CONSTRAINT mnemo_relation_marked_by_kind_check CHECK ((marked_by_kind = ANY (ARRAY['user'::text, 'agent'::text, 'system'::text, 'llm_judge'::text]))),
    CONSTRAINT mnemo_relation_relation_check CHECK ((relation = ANY (ARRAY['related'::text, 'compatible'::text, 'scoped'::text, 'conflicts_with'::text, 'supersedes'::text, 'not_conflict'::text, 'derived_from'::text, 'part_of'::text, 'member_of'::text]))),
    CONSTRAINT mnemo_relation_source_kind_check CHECK ((source_kind = ANY (ARRAY['fact'::text, 'decision'::text, 'entity'::text, 'episode'::text]))),
    CONSTRAINT mnemo_relation_target_kind_check CHECK ((target_kind = ANY (ARRAY['fact'::text, 'decision'::text, 'entity'::text, 'episode'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_relation FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_reminder; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_reminder (
    id text NOT NULL,
    workspace_id text NOT NULL,
    content text NOT NULL,
    condition text NOT NULL,
    trigger_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    condition_embedding public.halfvec(1536),
    triggered_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    created_by_agent_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_reminder_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'triggered'::text, 'dismissed'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_reminder FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_review_item; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_review_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    primitive_id text NOT NULL,
    primitive_kind text DEFAULT 'fact'::text NOT NULL,
    reason text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_review_item FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_review_queue; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_review_queue (
    id text NOT NULL,
    workspace_id text NOT NULL,
    fact_id text,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    resolution text,
    decision_id text,
    CONSTRAINT mnemo_review_queue_source_check CHECK (((fact_id IS NOT NULL) OR (decision_id IS NOT NULL)))
);

ALTER TABLE ONLY mnemosyne.mnemo_review_queue FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_salience_map; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_salience_map (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    topic text NOT NULL,
    salience numeric(6,4) DEFAULT 0.5 NOT NULL,
    decay_rate numeric(8,6) DEFAULT 0.1 NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_salience_map FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_scoped_api_keys; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_scoped_api_keys (
    key_id text NOT NULL,
    prefix text NOT NULL,
    hashed_secret text NOT NULL,
    workspace_id uuid NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone,
    rotated_from_id text,
    ip_allowlist jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    deprecated_at timestamp with time zone,
    mfa_secret text,
    is_test boolean DEFAULT false NOT NULL,
    max_sensitivity text
);


--
-- Name: mnemo_scoped_key_escrow; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_scoped_key_escrow (
    id bigint NOT NULL,
    key_id text NOT NULL,
    prefix text NOT NULL,
    workspace_id uuid NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    escrowed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mnemo_scoped_key_escrow_id_seq; Type: SEQUENCE; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_scoped_key_escrow ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mnemosyne.mnemo_scoped_key_escrow_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mnemo_scoped_key_usage; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_scoped_key_usage (
    id bigint NOT NULL,
    key_id text NOT NULL,
    ip_address text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mnemo_scoped_key_usage_id_seq; Type: SEQUENCE; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_scoped_key_usage ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mnemosyne.mnemo_scoped_key_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mnemo_session; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_session (
    id text DEFAULT gen_random_uuid() NOT NULL,
    workspace_id text NOT NULL,
    agent_id text,
    user_id text,
    status text DEFAULT 'active'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    collapsed_at timestamp with time zone,
    context_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    outcome_rating text,
    fact_count integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    turn_count integer DEFAULT 0 NOT NULL,
    token_count integer DEFAULT 0 NOT NULL,
    scratch jsonb DEFAULT '{}'::jsonb NOT NULL,
    active_prompt_version_id text,
    CONSTRAINT mnemo_session_outcome_rating_check CHECK ((outcome_rating = ANY (ARRAY['success'::text, 'failure'::text, 'neutral'::text]))),
    CONSTRAINT mnemo_session_status_check CHECK ((status = ANY (ARRAY['active'::text, 'collapsed'::text, 'archived'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_session FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_session_token; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_session_token (
    id text NOT NULL,
    workspace_id text NOT NULL,
    actor_id text NOT NULL,
    token_hash text NOT NULL,
    device_fingerprint text NOT NULL,
    used_at timestamp with time zone,
    family_revoked_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_session_token FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_session_turn; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_session_turn (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    session_id text NOT NULL,
    turn_index integer NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    token_count integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    hint text,
    CONSTRAINT mnemo_session_turn_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text, 'tool'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_session_turn FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_skill; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_skill (
    id text NOT NULL,
    workspace_id text NOT NULL,
    actor_id text,
    agent_id text,
    name text NOT NULL,
    prompt_template text NOT NULL,
    variables text[] DEFAULT '{}'::text[] NOT NULL,
    required_context text[] DEFAULT '{}'::text[] NOT NULL,
    quality_score real DEFAULT 0.5 NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    embedding public.halfvec(1536),
    embedding_model text,
    embedding_stale boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    worth_alpha numeric(8,4) DEFAULT 1.0 NOT NULL,
    worth_beta numeric(8,4) DEFAULT 1.0 NOT NULL,
    worth real GENERATED ALWAYS AS ((worth_alpha / NULLIF((worth_alpha + worth_beta), (0)::numeric))) STORED,
    scope_owner text
);

ALTER TABLE ONLY mnemosyne.mnemo_skill FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_spatial_index; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_spatial_index (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    fact_id text NOT NULL,
    location_name text,
    latitude numeric(9,6),
    longitude numeric(9,6),
    radius_km numeric(8,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_spatial_index FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_strategy; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_strategy (
    id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text,
    actor_id text,
    trigger text NOT NULL,
    action text NOT NULL,
    context text,
    success_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    supersedes_id text,
    status text DEFAULT 'active'::text NOT NULL,
    embedding public.halfvec(1536),
    embedding_model text,
    embedding_stale boolean DEFAULT false NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    worth_alpha numeric(8,4) DEFAULT 1.0 NOT NULL,
    worth_beta numeric(8,4) DEFAULT 1.0 NOT NULL,
    worth real GENERATED ALWAYS AS ((worth_alpha / NULLIF((worth_alpha + worth_beta), (0)::numeric))) STORED,
    related_facts text[] DEFAULT '{}'::text[] NOT NULL,
    attribution text DEFAULT 'inferred'::text NOT NULL,
    scope_owner text,
    CONSTRAINT mnemo_strategy_attribution_check CHECK ((attribution = ANY (ARRAY['user_stated'::text, 'user_belief'::text, 'objective_fact'::text, 'inferred'::text]))),
    CONSTRAINT mnemo_strategy_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'archived'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_strategy FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_sync_cursor; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_sync_cursor (
    peer_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    last_sync_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_sync_cursor FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_sync_supersession; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_sync_supersession (
    workspace_id uuid NOT NULL,
    remote_id text NOT NULL,
    superseded_local_id text NOT NULL,
    peer_domain text NOT NULL,
    superseded_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_sync_supersession FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_sync_tombstone; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_sync_tombstone (
    item_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    deleted_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    peer_domain text DEFAULT ''::text NOT NULL,
    reason text DEFAULT 'federation_tombstone'::text NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_sync_tombstone FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_task; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_task (
    id text NOT NULL,
    workspace_id text NOT NULL,
    actor_id text,
    agent_id text,
    title text NOT NULL,
    description text,
    status text DEFAULT 'pending'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    assigned_to text NOT NULL,
    delegated_by text,
    delegated_at timestamp with time zone,
    blocked_by text[] DEFAULT '{}'::text[] NOT NULL,
    subtask_ids text[] DEFAULT '{}'::text[] NOT NULL,
    parent_task_id text,
    related_facts text[] DEFAULT '{}'::text[] NOT NULL,
    related_entities text[] DEFAULT '{}'::text[] NOT NULL,
    session_id text,
    outcome text,
    lessons_learned text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    due_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    scope_owner text,
    CONSTRAINT mnemo_task_priority_check CHECK ((priority = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT mnemo_task_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'blocked'::text, 'delegated'::text, 'completed'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_task FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_temporal_anchor; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_temporal_anchor (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    fact_id text NOT NULL,
    anchor_label text NOT NULL,
    anchor_start timestamp with time zone,
    anchor_end timestamp with time zone,
    is_recurring boolean DEFAULT false NOT NULL,
    recurrence jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_temporal_anchor FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_tenant; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_tenant (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'personal'::text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_tenant_kind_check CHECK ((kind = ANY (ARRAY['personal'::text, 'organization'::text]))),
    CONSTRAINT mnemo_tenant_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'pro'::text, 'enterprise'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_tenant FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_tenant_member; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_tenant_member (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    invited_by text,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_tenant_member_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_tenant_member FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_user; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_user (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    email text NOT NULL,
    display_name text,
    personal_tenant_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mnemosyne.mnemo_user FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_webhook_delivery; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_webhook_delivery (
    id text NOT NULL,
    webhook_id text NOT NULL,
    workspace_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    response_status integer,
    response_body text,
    attempt integer DEFAULT 1 NOT NULL,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    next_attempt_at timestamp with time zone,
    CONSTRAINT mnemo_webhook_delivery_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_webhook_delivery FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_webhook_endpoint; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_webhook_endpoint (
    id text NOT NULL,
    workspace_id text NOT NULL,
    url text NOT NULL,
    events text[] DEFAULT '{}'::text[] NOT NULL,
    secret_hash text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    last_success_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone
);

ALTER TABLE ONLY mnemosyne.mnemo_webhook_endpoint FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_workflow; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_workflow (
    id text NOT NULL,
    workspace_id text NOT NULL,
    actor_id text,
    agent_id text,
    name text NOT NULL,
    description text,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    avg_duration_ms integer DEFAULT 0 NOT NULL,
    success_rate real DEFAULT 0.0 NOT NULL,
    execution_count integer DEFAULT 0 NOT NULL,
    last_executed_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    previous_version_id text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    worth_alpha numeric(8,4) DEFAULT 1.0 NOT NULL,
    worth_beta numeric(8,4) DEFAULT 1.0 NOT NULL,
    worth real GENERATED ALWAYS AS ((worth_alpha / NULLIF((worth_alpha + worth_beta), (0)::numeric))) STORED,
    scope_owner text,
    CONSTRAINT mnemo_workflow_status_check CHECK ((status = ANY (ARRAY['active'::text, 'deprecated'::text, 'draft'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_workflow FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_workspace; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_workspace (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    name text NOT NULL,
    slug text,
    tenant_id text NOT NULL,
    owner_user_id text,
    visibility text DEFAULT 'private'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_workspace_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'public'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_workspace FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_workspace_config; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_workspace_config (
    workspace_id uuid NOT NULL,
    key text NOT NULL,
    value_enc bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);

ALTER TABLE ONLY mnemosyne.mnemo_workspace_config FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_workspace_kek; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_workspace_kek (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id text NOT NULL,
    kek_version integer DEFAULT 1 NOT NULL,
    rotated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mnemo_workspace_member; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_workspace_member (
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'read'::text NOT NULL,
    invited_by text,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mnemo_workspace_member_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'write'::text, 'read'::text])))
);

ALTER TABLE ONLY mnemosyne.mnemo_workspace_member FORCE ROW LEVEL SECURITY;


--
-- Name: mnemo_workspace_mode; Type: TABLE; Schema: mnemosyne; Owner: -
--

CREATE TABLE mnemosyne.mnemo_workspace_mode (
    workspace_id text NOT NULL,
    mode text DEFAULT 'learning'::text NOT NULL,
    session_count integer DEFAULT 0 NOT NULL,
    promote_at integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    fact_count integer DEFAULT 0 NOT NULL,
    entity_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT mnemo_workspace_mode_mode_check CHECK ((mode = ANY (ARRAY['learning'::text, 'production'::text])))
);


--
-- Name: mv_conditional_patterns; Type: MATERIALIZED VIEW; Schema: mnemosyne; Owner: -
--

CREATE MATERIALIZED VIEW mnemosyne.mv_conditional_patterns AS
 WITH base AS (
         SELECT mnemo_recall_log.workspace_id,
            mnemo_recall_log.fact_id,
            lower(btrim(mnemo_recall_log.query_text)) AS query_key
           FROM mnemosyne.mnemo_recall_log
          WHERE ((mnemo_recall_log.recalled_at > (now() - '30 days'::interval)) AND (mnemo_recall_log.fact_id IS NOT NULL) AND (mnemo_recall_log.query_text IS NOT NULL) AND (btrim(mnemo_recall_log.query_text) <> ''::text))
        ), query_totals AS (
         SELECT base.workspace_id,
            base.query_key,
            (count(*))::integer AS query_total
           FROM base
          GROUP BY base.workspace_id, base.query_key
        ), pair_counts AS (
         SELECT base.workspace_id,
            base.query_key,
            base.fact_id,
            (count(*))::integer AS co_returns
           FROM base
          GROUP BY base.workspace_id, base.query_key, base.fact_id
         HAVING (count(*) >= 4)
        )
 SELECT pc.workspace_id,
    pc.query_key,
    pc.fact_id,
    pc.co_returns,
    qt.query_total,
    round(((pc.co_returns)::numeric / (qt.query_total)::numeric), 4) AS confidence
   FROM (pair_counts pc
     JOIN query_totals qt USING (workspace_id, query_key))
  WHERE (((pc.co_returns)::numeric / (qt.query_total)::numeric) >= 0.50)
  WITH NO DATA;


--
-- Name: mv_confidence_map; Type: MATERIALIZED VIEW; Schema: mnemosyne; Owner: -
--

CREATE MATERIALIZED VIEW mnemosyne.mv_confidence_map AS
 SELECT e.workspace_id,
    e.id AS entity_id,
    e.name AS canonical_name,
    e.kind,
    count(f.id) AS fact_count,
    round(COALESCE(avg(f.worth), (0)::numeric), 4) AS avg_worth,
    round((COALESCE(avg(f.confidence), (0)::double precision))::numeric, 4) AS avg_confidence,
    sum((COALESCE(f.worth_success, (1)::numeric) + COALESCE(f.worth_failure, (1)::numeric))) AS evidence_volume,
    count(DISTINCT f.actor_id) AS distinct_attributions,
    count(*) FILTER (WHERE (f.pinned = true)) AS pinned_count,
    count(*) FILTER (WHERE (f.memory_strength < (0.4)::double precision)) AS low_strength_count,
    max(f.created_at) AS newest_fact,
    min(f.created_at) AS oldest_fact,
    COALESCE(max(f.updated_at), e.updated_at) AS last_updated_at,
        CASE
            WHEN ((count(f.id) >= 10) AND (avg(f.worth) > 0.7)) THEN 'expert'::text
            WHEN ((count(f.id) >= 5) AND (avg(f.worth) > 0.5)) THEN 'familiar'::text
            WHEN (count(f.id) >= 2) THEN 'aware'::text
            WHEN (count(f.id) >= 1) THEN 'minimal'::text
            ELSE 'blind'::text
        END AS coverage_level,
        CASE
            WHEN (max(f.created_at) > (now() - '7 days'::interval)) THEN 'current'::text
            WHEN (max(f.created_at) > (now() - '30 days'::interval)) THEN 'recent'::text
            WHEN (max(f.created_at) > (now() - '90 days'::interval)) THEN 'aging'::text
            ELSE 'stale'::text
        END AS freshness
   FROM (mnemosyne.mnemo_entity e
     LEFT JOIN mnemosyne.mnemo_fact f ON (((f.entity_id = e.id) AND (f.valid_to IS NULL) AND (f.status = 'active'::text))))
  GROUP BY e.workspace_id, e.id, e.name, e.kind, e.updated_at
  WITH NO DATA;


--
-- Name: mv_knowledge_gaps; Type: MATERIALIZED VIEW; Schema: mnemosyne; Owner: -
--

CREATE MATERIALIZED VIEW mnemosyne.mv_knowledge_gaps AS
 WITH fact_agg AS (
         SELECT mnemo_fact.workspace_id,
            COALESCE(mnemo_fact.topic_key, '(uncategorised)'::text) AS topic_key,
            round(avg(mnemo_fact.worth), 4) AS avg_worth,
            sum((COALESCE(mnemo_fact.worth_success, (1)::numeric) + COALESCE(mnemo_fact.worth_failure, (1)::numeric))) AS evidence_volume,
            count(*) AS memory_count,
            array_agg(mnemo_fact.id) AS fact_ids
           FROM mnemosyne.mnemo_fact
          WHERE ((mnemo_fact.valid_to IS NULL) AND (mnemo_fact.status = 'active'::text))
          GROUP BY mnemo_fact.workspace_id, COALESCE(mnemo_fact.topic_key, '(uncategorised)'::text)
        ), recall_agg AS (
         SELECT f.workspace_id,
            COALESCE(f.topic_key, '(uncategorised)'::text) AS topic_key,
            count(rl.id) AS recall_hits_30d
           FROM (mnemosyne.mnemo_recall_log rl
             JOIN mnemosyne.mnemo_fact f ON (((rl.fact_id = f.id) AND (rl.workspace_id = (f.workspace_id)::uuid))))
          WHERE (rl.recalled_at >= (now() - '30 days'::interval))
          GROUP BY f.workspace_id, COALESCE(f.topic_key, '(uncategorised)'::text)
        )
 SELECT fa.workspace_id,
    fa.topic_key,
    fa.avg_worth,
    fa.evidence_volume,
    fa.memory_count,
    COALESCE(ra.recall_hits_30d, (0)::bigint) AS recall_hits_30d,
    round((((COALESCE(ra.recall_hits_30d, (0)::bigint))::numeric * ((1)::numeric - fa.avg_worth)) / GREATEST(fa.evidence_volume, (1)::numeric)), 6) AS gap_score
   FROM (fact_agg fa
     LEFT JOIN recall_agg ra ON (((fa.workspace_id = ra.workspace_id) AND (fa.topic_key = ra.topic_key))))
  WITH NO DATA;


--
-- Name: mv_periodic_patterns; Type: MATERIALIZED VIEW; Schema: mnemosyne; Owner: -
--

CREATE MATERIALIZED VIEW mnemosyne.mv_periodic_patterns AS
 WITH base AS (
         SELECT mnemo_recall_log.workspace_id,
            mnemo_recall_log.fact_id,
            (EXTRACT(dow FROM (mnemo_recall_log.recalled_at AT TIME ZONE 'UTC'::text)))::integer AS day_of_week,
            ((EXTRACT(hour FROM (mnemo_recall_log.recalled_at AT TIME ZONE 'UTC'::text)))::integer / 3) AS hour_bucket,
            date_trunc('week'::text, (mnemo_recall_log.recalled_at AT TIME ZONE 'UTC'::text)) AS week_bucket,
            mnemo_recall_log.recalled_at
           FROM mnemosyne.mnemo_recall_log
          WHERE ((mnemo_recall_log.recalled_at > (now() - (COALESCE(current_setting('mnemosyne.anticipation_periodic_window'::text, true), '90 days'::text))::interval)) AND (mnemo_recall_log.fact_id IS NOT NULL))
        ), totals AS (
         SELECT base.workspace_id,
            base.fact_id,
            (count(*))::integer AS total
           FROM base
          GROUP BY base.workspace_id, base.fact_id
        ), slot AS (
         SELECT base.workspace_id,
            base.fact_id,
            base.day_of_week,
            base.hour_bucket,
            (count(*))::integer AS slot_recalls,
            (count(DISTINCT base.week_bucket))::integer AS distinct_weeks
           FROM base
          GROUP BY base.workspace_id, base.fact_id, base.day_of_week, base.hour_bucket
        )
 SELECT s.workspace_id,
    s.fact_id AS memory_id,
    s.day_of_week,
    s.hour_bucket,
    s.slot_recalls,
    s.distinct_weeks,
    round(((s.slot_recalls)::numeric / (t.total)::numeric), 4) AS slot_share
   FROM (slot s
     JOIN totals t USING (workspace_id, fact_id))
  WHERE ((s.distinct_weeks >= 3) AND (((s.slot_recalls)::numeric / (t.total)::numeric) >= 0.20))
  WITH NO DATA;


--
-- Name: mv_sequential_patterns; Type: MATERIALIZED VIEW; Schema: mnemosyne; Owner: -
--

CREATE MATERIALIZED VIEW mnemosyne.mv_sequential_patterns AS
 WITH ordered AS (
         SELECT mnemo_recall_log.workspace_id,
            mnemo_recall_log.fact_id,
            mnemo_recall_log.recalled_at
           FROM mnemosyne.mnemo_recall_log
          WHERE ((mnemo_recall_log.recalled_at > (now() - '30 days'::interval)) AND (mnemo_recall_log.fact_id IS NOT NULL))
        ), pairs AS (
         SELECT a.workspace_id,
            a.fact_id AS predecessor_id,
            b.fact_id AS successor_id,
            (EXTRACT(epoch FROM (b.recalled_at - a.recalled_at)))::integer AS lag_seconds
           FROM (ordered a
             JOIN ordered b ON (((a.workspace_id = b.workspace_id) AND (b.recalled_at > a.recalled_at) AND (b.recalled_at <= (a.recalled_at + (COALESCE(current_setting('mnemosyne.anticipation_successor_window'::text, true), '5 minutes'::text))::interval)) AND (a.fact_id <> b.fact_id))))
        ), pair_counts AS (
         SELECT pairs.workspace_id,
            pairs.predecessor_id,
            pairs.successor_id,
            (count(*))::integer AS support,
            (avg(pairs.lag_seconds))::integer AS avg_lag_seconds
           FROM pairs
          GROUP BY pairs.workspace_id, pairs.predecessor_id, pairs.successor_id
         HAVING (count(*) >= 5)
        ), pred_totals AS (
         SELECT pair_counts.workspace_id,
            pair_counts.predecessor_id,
            (sum(pair_counts.support))::integer AS total_outgoing
           FROM pair_counts
          GROUP BY pair_counts.workspace_id, pair_counts.predecessor_id
        )
 SELECT pc.workspace_id,
    pc.predecessor_id,
    pc.successor_id,
    pc.support,
    pc.avg_lag_seconds,
    round(((pc.support)::numeric / (pt.total_outgoing)::numeric), 4) AS confidence
   FROM (pair_counts pc
     JOIN pred_totals pt ON (((pt.workspace_id = pc.workspace_id) AND (pt.predecessor_id = pc.predecessor_id))))
  WHERE (((pc.support)::numeric / (pt.total_outgoing)::numeric) >= 0.30)
  WITH NO DATA;


--
-- Name: mnemo_audit_log_y2026m01; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m01 FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m02; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m02 FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m03; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m03 FOR VALUES FROM ('2026-03-01 00:00:00+00') TO ('2026-04-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m04; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m04 FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m05; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m05 FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m06; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m07; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m08; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m09; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m09 FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m10; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m10 FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m11; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m11 FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');


--
-- Name: mnemo_audit_log_y2026m12; Type: TABLE ATTACH; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m12 FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');


--
-- Name: mnemo_access_policy mnemo_access_policy_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_access_policy
    ADD CONSTRAINT mnemo_access_policy_pkey PRIMARY KEY (id);


--
-- Name: mnemo_access_policy mnemo_access_policy_workspace_id_agent_id_key; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_access_policy
    ADD CONSTRAINT mnemo_access_policy_workspace_id_agent_id_key UNIQUE (workspace_id, agent_id);


--
-- Name: mnemo_actor_dek mnemo_actor_dek_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_actor_dek
    ADD CONSTRAINT mnemo_actor_dek_pkey PRIMARY KEY (id);


--
-- Name: mnemo_actor_dek mnemo_actor_dek_workspace_id_actor_id_key; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_actor_dek
    ADD CONSTRAINT mnemo_actor_dek_workspace_id_actor_id_key UNIQUE (workspace_id, actor_id);


--
-- Name: mnemo_agent_profile mnemo_agent_profile_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_agent_profile
    ADD CONSTRAINT mnemo_agent_profile_pkey PRIMARY KEY (workspace_id, agent_id);


--
-- Name: mnemo_analogy_map mnemo_analogy_map_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_analogy_map
    ADD CONSTRAINT mnemo_analogy_map_pkey PRIMARY KEY (id);


--
-- Name: mnemo_api_keys mnemo_api_keys_key_hash_key; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_api_keys
    ADD CONSTRAINT mnemo_api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: mnemo_api_keys mnemo_api_keys_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_api_keys
    ADD CONSTRAINT mnemo_api_keys_pkey PRIMARY KEY (id);


--
-- Name: mnemo_approval_request mnemo_approval_request_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_approval_request
    ADD CONSTRAINT mnemo_approval_request_pkey PRIMARY KEY (id);


--
-- Name: mnemo_audit_log mnemo_audit_log_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log
    ADD CONSTRAINT mnemo_audit_log_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m01 mnemo_audit_log_y2026m01_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m01
    ADD CONSTRAINT mnemo_audit_log_y2026m01_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m02 mnemo_audit_log_y2026m02_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m02
    ADD CONSTRAINT mnemo_audit_log_y2026m02_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m03 mnemo_audit_log_y2026m03_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m03
    ADD CONSTRAINT mnemo_audit_log_y2026m03_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m04 mnemo_audit_log_y2026m04_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m04
    ADD CONSTRAINT mnemo_audit_log_y2026m04_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m05 mnemo_audit_log_y2026m05_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m05
    ADD CONSTRAINT mnemo_audit_log_y2026m05_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m06 mnemo_audit_log_y2026m06_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m06
    ADD CONSTRAINT mnemo_audit_log_y2026m06_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m07 mnemo_audit_log_y2026m07_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m07
    ADD CONSTRAINT mnemo_audit_log_y2026m07_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m08 mnemo_audit_log_y2026m08_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m08
    ADD CONSTRAINT mnemo_audit_log_y2026m08_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m09 mnemo_audit_log_y2026m09_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m09
    ADD CONSTRAINT mnemo_audit_log_y2026m09_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m10 mnemo_audit_log_y2026m10_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m10
    ADD CONSTRAINT mnemo_audit_log_y2026m10_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m11 mnemo_audit_log_y2026m11_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m11
    ADD CONSTRAINT mnemo_audit_log_y2026m11_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_audit_log_y2026m12 mnemo_audit_log_y2026m12_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_audit_log_y2026m12
    ADD CONSTRAINT mnemo_audit_log_y2026m12_pkey PRIMARY KEY (id, created_at);


--
-- Name: mnemo_break_glass_request mnemo_break_glass_request_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_break_glass_request
    ADD CONSTRAINT mnemo_break_glass_request_pkey PRIMARY KEY (id);


--
-- Name: mnemo_causal_chain mnemo_causal_chain_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_causal_chain
    ADD CONSTRAINT mnemo_causal_chain_pkey PRIMARY KEY (id);


--
-- Name: mnemo_citation mnemo_citation_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_citation
    ADD CONSTRAINT mnemo_citation_pkey PRIMARY KEY (id);


--
-- Name: mnemo_composition_rule mnemo_composition_rule_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_composition_rule
    ADD CONSTRAINT mnemo_composition_rule_pkey PRIMARY KEY (id);


--
-- Name: mnemo_composition_rule_template mnemo_composition_rule_template_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_composition_rule_template
    ADD CONSTRAINT mnemo_composition_rule_template_pkey PRIMARY KEY (id);


--
-- Name: mnemo_consolidation_lock mnemo_consolidation_lock_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_consolidation_lock
    ADD CONSTRAINT mnemo_consolidation_lock_pkey PRIMARY KEY (workspace_id);


--
-- Name: mnemo_contradiction_queue mnemo_contradiction_queue_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_contradiction_queue
    ADD CONSTRAINT mnemo_contradiction_queue_pkey PRIMARY KEY (id);


--
-- Name: mnemo_decision mnemo_decision_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_decision
    ADD CONSTRAINT mnemo_decision_pkey PRIMARY KEY (id);


--
-- Name: mnemo_deletion_log mnemo_deletion_log_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_deletion_log
    ADD CONSTRAINT mnemo_deletion_log_pkey PRIMARY KEY (id);


--
-- Name: mnemo_embedding_cache mnemo_embedding_cache_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_embedding_cache
    ADD CONSTRAINT mnemo_embedding_cache_pkey PRIMARY KEY (id);


--
-- Name: mnemo_encryption_keys mnemo_encryption_keys_key_id_key; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_encryption_keys
    ADD CONSTRAINT mnemo_encryption_keys_key_id_key UNIQUE (key_id);


--
-- Name: mnemo_encryption_keys mnemo_encryption_keys_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_encryption_keys
    ADD CONSTRAINT mnemo_encryption_keys_pkey PRIMARY KEY (id);


--
-- Name: mnemo_entity mnemo_entity_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_entity
    ADD CONSTRAINT mnemo_entity_pkey PRIMARY KEY (id);


--
-- Name: mnemo_entity mnemo_entity_workspace_id_name_kind_key; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_entity
    ADD CONSTRAINT mnemo_entity_workspace_id_name_kind_key UNIQUE (workspace_id, name, kind);


--
-- Name: mnemo_episode mnemo_episode_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_episode
    ADD CONSTRAINT mnemo_episode_pkey PRIMARY KEY (id);


--
-- Name: mnemo_event mnemo_event_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_event
    ADD CONSTRAINT mnemo_event_pkey PRIMARY KEY (id);


--
-- Name: mnemo_fact_archive mnemo_fact_archive_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_fact_archive
    ADD CONSTRAINT mnemo_fact_archive_pkey PRIMARY KEY (id);


--
-- Name: mnemo_fact_hash mnemo_fact_hash_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_fact_hash
    ADD CONSTRAINT mnemo_fact_hash_pkey PRIMARY KEY (workspace_id, statement_hash);


--
-- Name: mnemo_fact_lsh mnemo_fact_lsh_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_fact_lsh
    ADD CONSTRAINT mnemo_fact_lsh_pkey PRIMARY KEY (workspace_id, fact_id, band_idx);


--
-- Name: mnemo_fact mnemo_fact_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_fact
    ADD CONSTRAINT mnemo_fact_pkey PRIMARY KEY (id);


--
-- Name: mnemo_federated_item mnemo_federated_item_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_federated_item
    ADD CONSTRAINT mnemo_federated_item_pkey PRIMARY KEY (local_id);


--
-- Name: mnemo_federated_item mnemo_federated_item_remote_id_workspace_id_key; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_federated_item
    ADD CONSTRAINT mnemo_federated_item_remote_id_workspace_id_key UNIQUE (remote_id, workspace_id);


--
-- Name: mnemo_health mnemo_health_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_health
    ADD CONSTRAINT mnemo_health_pkey PRIMARY KEY (id);


--
-- Name: mnemo_hot_tier_snapshot mnemo_hot_tier_snapshot_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_hot_tier_snapshot
    ADD CONSTRAINT mnemo_hot_tier_snapshot_pkey PRIMARY KEY (workspace_id, cache_key);


--
-- Name: mnemo_hyperedge mnemo_hyperedge_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_hyperedge
    ADD CONSTRAINT mnemo_hyperedge_pkey PRIMARY KEY (id);


--
-- Name: mnemo_idempotency_keys mnemo_idempotency_keys_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_idempotency_keys
    ADD CONSTRAINT mnemo_idempotency_keys_pkey PRIMARY KEY (workspace_id, key);


--
-- Name: mnemo_inference_log mnemo_inference_log_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_inference_log
    ADD CONSTRAINT mnemo_inference_log_pkey PRIMARY KEY (id);


--
-- Name: mnemo_key_escrow mnemo_key_escrow_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_key_escrow
    ADD CONSTRAINT mnemo_key_escrow_pkey PRIMARY KEY (id);


--
-- Name: mnemo_meter_event mnemo_meter_event_idempotency_key_uniq; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_meter_event
    ADD CONSTRAINT mnemo_meter_event_idempotency_key_uniq UNIQUE (idempotency_key);


--
-- Name: mnemo_meter_event mnemo_meter_event_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_meter_event
    ADD CONSTRAINT mnemo_meter_event_pkey PRIMARY KEY (id);


--
-- Name: mnemo_migration_cursor mnemo_migration_cursor_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_migration_cursor
    ADD CONSTRAINT mnemo_migration_cursor_pkey PRIMARY KEY (workspace_id, run_id);


--
-- Name: mnemo_outbox mnemo_outbox_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_outbox
    ADD CONSTRAINT mnemo_outbox_pkey PRIMARY KEY (id);


--
-- Name: mnemo_plugin_state mnemo_plugin_state_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_plugin_state
    ADD CONSTRAINT mnemo_plugin_state_pkey PRIMARY KEY (id);


--
-- Name: mnemo_prime_ctx mnemo_prime_ctx_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_prime_ctx
    ADD CONSTRAINT mnemo_prime_ctx_pkey PRIMARY KEY (id);


--
-- Name: mnemo_prompt_version mnemo_prompt_version_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_prompt_version
    ADD CONSTRAINT mnemo_prompt_version_pkey PRIMARY KEY (id);


--
-- Name: mnemo_prompt_version mnemo_prompt_version_status_check; Type: CHECK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_prompt_version
    ADD CONSTRAINT mnemo_prompt_version_status_check CHECK ((status = ANY (ARRAY['candidate'::text, 'testing'::text, 'active'::text, 'rolled_back'::text]))) NOT VALID;


--
-- Name: mnemo_query_cache mnemo_query_cache_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_query_cache
    ADD CONSTRAINT mnemo_query_cache_pkey PRIMARY KEY (id);


--
-- Name: mnemo_reasoning mnemo_reasoning_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_reasoning
    ADD CONSTRAINT mnemo_reasoning_pkey PRIMARY KEY (id);


--
-- Name: mnemo_reasoning mnemo_reasoning_status_check; Type: CHECK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_reasoning
    ADD CONSTRAINT mnemo_reasoning_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'pruned'::text, 'quarantined'::text, 'golden'::text]))) NOT VALID;


--
-- Name: mnemo_recall_log mnemo_recall_log_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_recall_log
    ADD CONSTRAINT mnemo_recall_log_pkey PRIMARY KEY (id);


--
-- Name: mnemo_relation mnemo_relation_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_relation
    ADD CONSTRAINT mnemo_relation_pkey PRIMARY KEY (id);


--
-- Name: mnemo_reminder mnemo_reminder_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_reminder
    ADD CONSTRAINT mnemo_reminder_pkey PRIMARY KEY (id);


--
-- Name: mnemo_review_item mnemo_review_item_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_review_item
    ADD CONSTRAINT mnemo_review_item_pkey PRIMARY KEY (id);


--
-- Name: mnemo_review_queue mnemo_review_queue_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_review_queue
    ADD CONSTRAINT mnemo_review_queue_pkey PRIMARY KEY (id);


--
-- Name: mnemo_salience_map mnemo_salience_map_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_salience_map
    ADD CONSTRAINT mnemo_salience_map_pkey PRIMARY KEY (id);


--
-- Name: mnemo_scoped_api_keys mnemo_scoped_api_keys_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_scoped_api_keys
    ADD CONSTRAINT mnemo_scoped_api_keys_pkey PRIMARY KEY (key_id);


--
-- Name: mnemo_scoped_key_escrow mnemo_scoped_key_escrow_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_scoped_key_escrow
    ADD CONSTRAINT mnemo_scoped_key_escrow_pkey PRIMARY KEY (id);


--
-- Name: mnemo_scoped_key_usage mnemo_scoped_key_usage_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_scoped_key_usage
    ADD CONSTRAINT mnemo_scoped_key_usage_pkey PRIMARY KEY (id);


--
-- Name: mnemo_session mnemo_session_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_session
    ADD CONSTRAINT mnemo_session_pkey PRIMARY KEY (id);


--
-- Name: mnemo_session_token mnemo_session_token_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_session_token
    ADD CONSTRAINT mnemo_session_token_pkey PRIMARY KEY (id);


--
-- Name: mnemo_session_token mnemo_session_token_token_hash_key; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_session_token
    ADD CONSTRAINT mnemo_session_token_token_hash_key UNIQUE (token_hash);


--
-- Name: mnemo_session_turn mnemo_session_turn_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_session_turn
    ADD CONSTRAINT mnemo_session_turn_pkey PRIMARY KEY (id);


--
-- Name: mnemo_skill mnemo_skill_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_skill
    ADD CONSTRAINT mnemo_skill_pkey PRIMARY KEY (id);


--
-- Name: mnemo_spatial_index mnemo_spatial_index_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_spatial_index
    ADD CONSTRAINT mnemo_spatial_index_pkey PRIMARY KEY (id);


--
-- Name: mnemo_strategy mnemo_strategy_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_strategy
    ADD CONSTRAINT mnemo_strategy_pkey PRIMARY KEY (id);


--
-- Name: mnemo_sync_cursor mnemo_sync_cursor_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_sync_cursor
    ADD CONSTRAINT mnemo_sync_cursor_pkey PRIMARY KEY (peer_id, workspace_id);


--
-- Name: mnemo_sync_supersession mnemo_sync_supersession_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_sync_supersession
    ADD CONSTRAINT mnemo_sync_supersession_pkey PRIMARY KEY (workspace_id, remote_id, superseded_local_id);


--
-- Name: mnemo_sync_tombstone mnemo_sync_tombstone_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_sync_tombstone
    ADD CONSTRAINT mnemo_sync_tombstone_pkey PRIMARY KEY (item_id, workspace_id);


--
-- Name: mnemo_task mnemo_task_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_task
    ADD CONSTRAINT mnemo_task_pkey PRIMARY KEY (id);


--
-- Name: mnemo_temporal_anchor mnemo_temporal_anchor_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_temporal_anchor
    ADD CONSTRAINT mnemo_temporal_anchor_pkey PRIMARY KEY (id);


--
-- Name: mnemo_tenant_member mnemo_tenant_member_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_tenant_member
    ADD CONSTRAINT mnemo_tenant_member_pkey PRIMARY KEY (tenant_id, user_id);


--
-- Name: mnemo_tenant mnemo_tenant_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_tenant
    ADD CONSTRAINT mnemo_tenant_pkey PRIMARY KEY (id);


--
-- Name: mnemo_user mnemo_user_email_key; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_user
    ADD CONSTRAINT mnemo_user_email_key UNIQUE (email);


--
-- Name: mnemo_user mnemo_user_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_user
    ADD CONSTRAINT mnemo_user_pkey PRIMARY KEY (id);


--
-- Name: mnemo_webhook_delivery mnemo_webhook_delivery_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_webhook_delivery
    ADD CONSTRAINT mnemo_webhook_delivery_pkey PRIMARY KEY (id);


--
-- Name: mnemo_webhook_endpoint mnemo_webhook_endpoint_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_webhook_endpoint
    ADD CONSTRAINT mnemo_webhook_endpoint_pkey PRIMARY KEY (id);


--
-- Name: mnemo_workflow mnemo_workflow_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_workflow
    ADD CONSTRAINT mnemo_workflow_pkey PRIMARY KEY (id);


--
-- Name: mnemo_workspace_config mnemo_workspace_config_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_workspace_config
    ADD CONSTRAINT mnemo_workspace_config_pkey PRIMARY KEY (workspace_id, key);


--
-- Name: mnemo_workspace_kek mnemo_workspace_kek_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_workspace_kek
    ADD CONSTRAINT mnemo_workspace_kek_pkey PRIMARY KEY (id);


--
-- Name: mnemo_workspace_member mnemo_workspace_member_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_workspace_member
    ADD CONSTRAINT mnemo_workspace_member_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: mnemo_workspace_mode mnemo_workspace_mode_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_workspace_mode
    ADD CONSTRAINT mnemo_workspace_mode_pkey PRIMARY KEY (workspace_id);


--
-- Name: mnemo_workspace mnemo_workspace_pkey; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_workspace
    ADD CONSTRAINT mnemo_workspace_pkey PRIMARY KEY (id);




--
-- Name: mnemo_embedding_cache uq_embedding_cache_ws_hash; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_embedding_cache
    ADD CONSTRAINT uq_embedding_cache_ws_hash UNIQUE (workspace_id, text_hash);


--
-- Name: mnemo_plugin_state uq_plugin_state; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_plugin_state
    ADD CONSTRAINT uq_plugin_state UNIQUE (workspace_id, plugin_id);


--
-- Name: mnemo_prompt_version uq_prompt_version; Type: CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_prompt_version
    ADD CONSTRAINT uq_prompt_version UNIQUE (workspace_id, prompt_key, version);


--
-- Name: idx_access_policy_lookup; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_access_policy_lookup ON mnemosyne.mnemo_access_policy USING btree (workspace_id, agent_id);


--
-- Name: idx_analogy_pair; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX idx_analogy_pair ON mnemosyne.mnemo_analogy_map USING btree (workspace_id, source_id, target_id);


--
-- Name: idx_analogy_source; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_analogy_source ON mnemosyne.mnemo_analogy_map USING btree (source_id, workspace_id);


--
-- Name: idx_approval_request_pending; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_approval_request_pending ON mnemosyne.mnemo_approval_request USING btree (workspace_id, status, created_at DESC) WHERE (status = 'pending'::text);


--
-- Name: idx_audit_action; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_audit_action ON ONLY mnemosyne.mnemo_audit_log USING btree (action, created_at DESC);


--
-- Name: idx_audit_log_created_brin; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_audit_log_created_brin ON ONLY mnemosyne.mnemo_audit_log USING brin (created_at);


--
-- Name: idx_audit_workspace_actor; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_audit_workspace_actor ON ONLY mnemosyne.mnemo_audit_log USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: idx_break_glass_active; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_break_glass_active ON mnemosyne.mnemo_break_glass_request USING btree (workspace_id, requested_by, status);


--
-- Name: idx_break_glass_created_brin; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_break_glass_created_brin ON mnemosyne.mnemo_break_glass_request USING brin (created_at);


--
-- Name: idx_causal_cause; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_causal_cause ON mnemosyne.mnemo_causal_chain USING btree (cause_id, workspace_id);


--
-- Name: idx_causal_effect; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_causal_effect ON mnemosyne.mnemo_causal_chain USING btree (effect_id, workspace_id);


--
-- Name: idx_composition_rule_active; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_composition_rule_active ON mnemosyne.mnemo_composition_rule USING btree (workspace_id, is_active, priority DESC) WHERE (is_active = true);


--
-- Name: idx_contradiction_pair; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX idx_contradiction_pair ON mnemosyne.mnemo_contradiction_queue USING btree (workspace_id, fact_a_id, fact_b_id) WHERE (resolved_at IS NULL);


--
-- Name: idx_contradiction_unresolved; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_contradiction_unresolved ON mnemosyne.mnemo_contradiction_queue USING btree (workspace_id, detected_at) WHERE (resolved_at IS NULL);


--
-- Name: idx_deletion_log_item; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX idx_deletion_log_item ON mnemosyne.mnemo_deletion_log USING btree (workspace_id, deleted_item_id);


--
-- Name: idx_deletion_log_workspace; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_deletion_log_workspace ON mnemosyne.mnemo_deletion_log USING btree (workspace_id, deleted_at DESC);


--
-- Name: idx_embedding_cache_lru; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_embedding_cache_lru ON mnemosyne.mnemo_embedding_cache USING btree (workspace_id, last_used_at);


--
-- Name: idx_event_occurred_brin; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_event_occurred_brin ON mnemosyne.mnemo_event USING brin (occurred_at);


--
-- Name: idx_fact_hash_fact; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_fact_hash_fact ON mnemosyne.mnemo_fact_hash USING btree (workspace_id, fact_id);


--
-- Name: idx_fact_lsh_lookup; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_fact_lsh_lookup ON mnemosyne.mnemo_fact_lsh USING btree (workspace_id, band_idx, band_hash);


--
-- Name: idx_federated_item_remote; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_federated_item_remote ON mnemosyne.mnemo_federated_item USING btree (workspace_id, remote_id) WHERE (NOT archived);


--
-- Name: idx_hot_tier_snapshot_workspace; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_hot_tier_snapshot_workspace ON mnemosyne.mnemo_hot_tier_snapshot USING btree (workspace_id);


--
-- Name: idx_hyperedge_context_hnsw; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_hyperedge_context_hnsw ON mnemosyne.mnemo_hyperedge USING hnsw (context_embedding public.halfvec_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_hyperedge_members; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_hyperedge_members ON mnemosyne.mnemo_hyperedge USING gin (member_ids);


--
-- Name: idx_inference_log_derived; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_inference_log_derived ON mnemosyne.mnemo_inference_log USING btree (workspace_id, derived_kind, derived_id) WHERE (derived_id IS NOT NULL);


--
-- Name: idx_inference_log_rule; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_inference_log_rule ON mnemosyne.mnemo_inference_log USING btree (workspace_id, rule_id, created_at DESC);


--
-- Name: idx_inference_log_workspace; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_inference_log_workspace ON mnemosyne.mnemo_inference_log USING btree (workspace_id, created_at DESC);


--
-- Name: idx_mnemo_api_keys_lookup_hash; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX idx_mnemo_api_keys_lookup_hash ON mnemosyne.mnemo_api_keys USING btree (lookup_hash) WHERE (lookup_hash IS NOT NULL);


--
-- Name: idx_mnemo_cit_memory; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_cit_memory ON mnemosyne.mnemo_citation USING btree (workspace_id, memory_kind, memory_id);


--
-- Name: idx_mnemo_cit_source; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_cit_source ON mnemosyne.mnemo_citation USING btree (workspace_id, source_kind, source_id);


--
-- Name: idx_mnemo_dec_embedding_hnsw; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_dec_embedding_hnsw ON mnemosyne.mnemo_decision USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_mnemo_dec_fts; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_dec_fts ON mnemosyne.mnemo_decision USING gin (text_lemmatized);


--
-- Name: idx_mnemo_dec_ws_kind; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_dec_ws_kind ON mnemosyne.mnemo_decision USING btree (workspace_id, kind);


--
-- Name: idx_mnemo_dec_ws_status; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_dec_ws_status ON mnemosyne.mnemo_decision USING btree (workspace_id, status);


--
-- Name: idx_mnemo_dec_ws_topic; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_dec_ws_topic ON mnemosyne.mnemo_decision USING btree (workspace_id, topic_key) WHERE (topic_key IS NOT NULL);


--
-- Name: idx_mnemo_decision_valid; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_decision_valid ON mnemosyne.mnemo_decision USING gist (tstzrange(valid_from, valid_to));


--
-- Name: idx_mnemo_entity_aliases; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_entity_aliases ON mnemosyne.mnemo_entity USING gin (aliases);


--
-- Name: idx_mnemo_entity_kind; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_entity_kind ON mnemosyne.mnemo_entity USING btree (workspace_id, kind);


--
-- Name: idx_mnemo_entity_workspace; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_entity_workspace ON mnemosyne.mnemo_entity USING btree (workspace_id);


--
-- Name: idx_mnemo_episode_real; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_episode_real ON mnemosyne.mnemo_episode USING btree (workspace_id, occurred_at DESC) WHERE (is_synthetic = false);


--
-- Name: idx_mnemo_episode_topics; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_episode_topics ON mnemosyne.mnemo_episode USING gin (topics);


--
-- Name: idx_mnemo_episode_workspace_occurred; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_episode_workspace_occurred ON mnemosyne.mnemo_episode USING btree (workspace_id, occurred_at DESC);


--
-- Name: idx_mnemo_fact_actor; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_actor ON mnemosyne.mnemo_fact USING btree (workspace_id, actor_id) WHERE ((actor_id IS NOT NULL) AND (status = 'active'::text));


--
-- Name: idx_mnemo_fact_archive_archived_at; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_archive_archived_at ON mnemosyne.mnemo_fact_archive USING btree (archived_at);


--
-- Name: idx_mnemo_fact_archive_merged_into; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_archive_merged_into ON mnemosyne.mnemo_fact_archive USING btree (merged_into_id) WHERE (merged_into_id IS NOT NULL);


--
-- Name: idx_mnemo_fact_archive_workspace; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_archive_workspace ON mnemosyne.mnemo_fact_archive USING btree (workspace_id);


--
-- Name: idx_mnemo_fact_embedding_hnsw; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_embedding_hnsw ON mnemosyne.mnemo_fact USING hnsw (embedding public.halfvec_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_mnemo_fact_entity; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_entity ON mnemosyne.mnemo_fact USING btree (workspace_id, entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: idx_mnemo_fact_episode_id; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_episode_id ON mnemosyne.mnemo_fact USING btree (workspace_id, episode_id) WHERE (episode_id IS NOT NULL);


--
-- Name: idx_mnemo_fact_fts; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_fts ON mnemosyne.mnemo_fact USING gin (text_lemmatized);


--
-- Name: idx_mnemo_fact_memory_strength; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_memory_strength ON mnemosyne.mnemo_fact USING btree (workspace_id, memory_strength) WHERE (status = 'active'::text);


--
-- Name: idx_mnemo_fact_memory_type; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_memory_type ON mnemosyne.mnemo_fact USING btree (workspace_id, memory_type) WHERE (status = 'active'::text);


--
-- Name: idx_mnemo_fact_protocol_version; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_protocol_version ON mnemosyne.mnemo_fact USING btree (workspace_id, protocol_version);


--
-- Name: idx_mnemo_fact_scope_owner; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_scope_owner ON mnemosyne.mnemo_fact USING btree (workspace_id, scope_owner) WHERE (scope_owner IS NOT NULL);


--
-- Name: idx_mnemo_fact_valid; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_valid ON mnemosyne.mnemo_fact USING gist (tstzrange(valid_from, valid_to));


--
-- Name: idx_mnemo_fact_ws_scope; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_ws_scope ON mnemosyne.mnemo_fact USING btree (workspace_id, scope, scope_ref);


--
-- Name: idx_mnemo_fact_ws_status; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_ws_status ON mnemosyne.mnemo_fact USING btree (workspace_id, status);


--
-- Name: idx_mnemo_fact_ws_subject; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_fact_ws_subject ON mnemosyne.mnemo_fact USING btree (workspace_id, subject);


--
-- Name: idx_mnemo_health_workspace; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_health_workspace ON mnemosyne.mnemo_health USING btree (workspace_id, snapshot_at DESC);


--
-- Name: idx_mnemo_prompt_version_workspace_agent_status; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_prompt_version_workspace_agent_status ON mnemosyne.mnemo_prompt_version USING btree (workspace_id, agent_id, status);


--
-- Name: idx_mnemo_qc_embedding_hnsw; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_qc_embedding_hnsw ON mnemosyne.mnemo_query_cache USING hnsw (query_embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_mnemo_qc_ws; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_qc_ws ON mnemosyne.mnemo_query_cache USING btree (workspace_id, last_used_at DESC);


--
-- Name: idx_mnemo_recall_log_memory_time; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_recall_log_memory_time ON mnemosyne.mnemo_recall_log USING btree (workspace_id, memory_id, recalled_at DESC) WHERE (memory_id IS NOT NULL);


--
-- Name: idx_mnemo_recall_log_recalled_at; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_recall_log_recalled_at ON mnemosyne.mnemo_recall_log USING btree (recalled_at);


--
-- Name: idx_mnemo_rel_pending; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_rel_pending ON mnemosyne.mnemo_relation USING btree (workspace_id, judgment_status, created_at DESC) WHERE (judgment_status = 'pending'::text);


--
-- Name: idx_mnemo_rel_source; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_rel_source ON mnemosyne.mnemo_relation USING btree (workspace_id, source_kind, source_id);


--
-- Name: idx_mnemo_rel_target; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_rel_target ON mnemosyne.mnemo_relation USING btree (workspace_id, target_kind, target_id);


--
-- Name: idx_mnemo_relation_provenance; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_relation_provenance ON mnemosyne.mnemo_relation USING btree (workspace_id, provenance) WHERE (provenance IS NOT NULL);


--
-- Name: idx_mnemo_relation_valid; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_relation_valid ON mnemosyne.mnemo_relation USING gist (tstzrange(valid_from, valid_to));


--
-- Name: idx_mnemo_reminder_condition_embedding; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_reminder_condition_embedding ON mnemosyne.mnemo_reminder USING hnsw (condition_embedding public.halfvec_cosine_ops) WITH (m='16', ef_construction='64') WHERE ((condition_embedding IS NOT NULL) AND (status = 'pending'::text));


--
-- Name: idx_mnemo_reminder_pending_time; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_reminder_pending_time ON mnemosyne.mnemo_reminder USING btree (workspace_id, trigger_at) WHERE (status = 'pending'::text);


--
-- Name: idx_mnemo_review_queue_decision_unresolved; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_review_queue_decision_unresolved ON mnemosyne.mnemo_review_queue USING btree (workspace_id, decision_id) WHERE ((decision_id IS NOT NULL) AND (resolved_at IS NULL));


--
-- Name: idx_mnemo_review_queue_workspace_unresolved; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_review_queue_workspace_unresolved ON mnemosyne.mnemo_review_queue USING btree (workspace_id) WHERE (resolved_at IS NULL);


--
-- Name: idx_mnemo_webhook_delivery_next_attempt; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_webhook_delivery_next_attempt ON mnemosyne.mnemo_webhook_delivery USING btree (next_attempt_at) WHERE ((status = 'pending'::text) AND (next_attempt_at IS NOT NULL));


--
-- Name: idx_mnemo_webhook_delivery_webhook_created; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_webhook_delivery_webhook_created ON mnemosyne.mnemo_webhook_delivery USING btree (webhook_id, created_at DESC);


--
-- Name: idx_mnemo_webhook_delivery_workspace_created; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_webhook_delivery_workspace_created ON mnemosyne.mnemo_webhook_delivery USING btree (workspace_id, created_at DESC);


--
-- Name: idx_mnemo_webhook_endpoint_failure_count; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_webhook_endpoint_failure_count ON mnemosyne.mnemo_webhook_endpoint USING btree (workspace_id, failure_count) WHERE (disabled_at IS NULL);


--
-- Name: idx_mnemo_webhook_endpoint_workspace_active; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mnemo_webhook_endpoint_workspace_active ON mnemosyne.mnemo_webhook_endpoint USING btree (workspace_id) WHERE (is_active = true);


--
-- Name: idx_mv_conditional_patterns_q; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mv_conditional_patterns_q ON mnemosyne.mv_conditional_patterns USING btree (workspace_id, query_key, confidence DESC);


--
-- Name: idx_mv_periodic_patterns_slot; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mv_periodic_patterns_slot ON mnemosyne.mv_periodic_patterns USING btree (workspace_id, day_of_week, hour_bucket, slot_share DESC);


--
-- Name: idx_mv_sequential_patterns_pred; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_mv_sequential_patterns_pred ON mnemosyne.mv_sequential_patterns USING btree (workspace_id, predecessor_id, confidence DESC);


--
-- Name: idx_outbox_next_attempt; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_outbox_next_attempt ON mnemosyne.mnemo_outbox USING btree (next_attempt_at) WHERE ((processed_at IS NULL) AND (claimed_at IS NULL));


--
-- Name: idx_outbox_pending; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_outbox_pending ON mnemosyne.mnemo_outbox USING btree (created_at) WHERE (processed_at IS NULL);


--
-- Name: idx_outbox_workspace; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_outbox_workspace ON mnemosyne.mnemo_outbox USING btree (workspace_id, created_at) WHERE (processed_at IS NULL);


--
-- Name: idx_prime_ctx_session; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_prime_ctx_session ON mnemosyne.mnemo_prime_ctx USING btree (session_id);


--
-- Name: idx_reasoning_embedding_hnsw; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_reasoning_embedding_hnsw ON mnemosyne.mnemo_reasoning USING hnsw (embedding public.halfvec_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_reasoning_servable; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_reasoning_servable ON mnemosyne.mnemo_reasoning USING btree (workspace_id) WHERE ((status = ANY (ARRAY['active'::text, 'golden'::text])) AND (embedding IS NOT NULL));


--
-- Name: idx_reasoning_topic_key; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_reasoning_topic_key ON mnemosyne.mnemo_reasoning USING btree (workspace_id, topic_key) WHERE (topic_key IS NOT NULL);


--
-- Name: idx_recall_log_fact; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_recall_log_fact ON mnemosyne.mnemo_recall_log USING btree (fact_id, recalled_at DESC);


--
-- Name: idx_recall_log_session; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_recall_log_session ON mnemosyne.mnemo_recall_log USING btree (session_id) WHERE (session_id IS NOT NULL);


--
-- Name: idx_review_item_ws_status; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_review_item_ws_status ON mnemosyne.mnemo_review_item USING btree (workspace_id, status);


--
-- Name: idx_salience_topic; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX idx_salience_topic ON mnemosyne.mnemo_salience_map USING btree (workspace_id, topic);


--
-- Name: idx_session_token_expires; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_session_token_expires ON mnemosyne.mnemo_session_token USING btree (workspace_id, expires_at);


--
-- Name: idx_session_token_hash; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_session_token_hash ON mnemosyne.mnemo_session_token USING btree (workspace_id, token_hash);


--
-- Name: idx_session_turn_pinned; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_session_turn_pinned ON mnemosyne.mnemo_session_turn USING btree (session_id) WHERE (pinned = true);


--
-- Name: idx_session_turn_session; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_session_turn_session ON mnemosyne.mnemo_session_turn USING btree (session_id, turn_index);


--
-- Name: idx_session_workspace; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_session_workspace ON mnemosyne.mnemo_session USING btree (workspace_id, status, started_at DESC);


--
-- Name: idx_skill_embedding_hnsw; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_skill_embedding_hnsw ON mnemosyne.mnemo_skill USING hnsw (embedding public.halfvec_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_spatial_fact; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_spatial_fact ON mnemosyne.mnemo_spatial_index USING btree (fact_id);


--
-- Name: idx_strategy_embedding_hnsw; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_strategy_embedding_hnsw ON mnemosyne.mnemo_strategy USING hnsw (embedding public.halfvec_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_task_blocked_by; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_task_blocked_by ON mnemosyne.mnemo_task USING gin (blocked_by);


--
-- Name: idx_task_open; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_task_open ON mnemosyne.mnemo_task USING btree (workspace_id, priority, due_at) WHERE (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'blocked'::text]));


--
-- Name: idx_temporal_fact; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_temporal_fact ON mnemosyne.mnemo_temporal_anchor USING btree (fact_id);


--
-- Name: idx_temporal_range; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX idx_temporal_range ON mnemosyne.mnemo_temporal_anchor USING btree (anchor_start, anchor_end);


--
-- Name: mnemo_actor_dek_actor_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_actor_dek_actor_idx ON mnemosyne.mnemo_actor_dek USING btree (workspace_id, actor_id) WHERE (status = 'active'::text);


--
-- Name: mnemo_audit_log_y2026m01_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m01_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m01 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m01_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m01_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m01 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m01_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m01_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m01 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m02_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m02_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m02 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m02_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m02_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m02 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m02_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m02_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m02 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m03_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m03_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m03 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m03_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m03_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m03 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m03_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m03_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m03 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m04_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m04_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m04 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m04_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m04_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m04 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m04_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m04_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m04 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m05_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m05_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m05 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m05_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m05_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m05 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m05_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m05_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m05 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m06_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m06_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m06 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m06_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m06_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m06 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m06_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m06_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m06 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m07_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m07_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m07 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m07_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m07_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m07 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m07_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m07_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m07 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m08_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m08_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m08 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m08_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m08_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m08 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m08_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m08_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m08 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m09_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m09_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m09 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m09_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m09_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m09 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m09_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m09_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m09 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m10_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m10_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m10 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m10_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m10_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m10 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m10_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m10_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m10 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m11_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m11_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m11 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m11_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m11_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m11 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m11_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m11_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m11 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m12_action_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m12_action_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m12 USING btree (action, created_at DESC);


--
-- Name: mnemo_audit_log_y2026m12_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m12_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m12 USING brin (created_at);


--
-- Name: mnemo_audit_log_y2026m12_workspace_id_actor_id_created_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_audit_log_y2026m12_workspace_id_actor_id_created_at_idx ON mnemosyne.mnemo_audit_log_y2026m12 USING btree (workspace_id, actor_id, created_at DESC);


--
-- Name: mnemo_idempotency_reap_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_idempotency_reap_idx ON mnemosyne.mnemo_idempotency_keys USING btree (created_at);


--
-- Name: mnemo_key_escrow_key_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_key_escrow_key_idx ON mnemosyne.mnemo_key_escrow USING btree (key_id, escrowed_at DESC);


--
-- Name: mnemo_key_escrow_ws_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_key_escrow_ws_idx ON mnemosyne.mnemo_key_escrow USING btree (workspace_id, escrowed_at DESC);


--
-- Name: mnemo_meter_event_occurred_brin; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_meter_event_occurred_brin ON mnemosyne.mnemo_meter_event USING brin (occurred_at);


--
-- Name: mnemo_meter_event_ws_occurred_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_meter_event_ws_occurred_idx ON mnemosyne.mnemo_meter_event USING btree (workspace_id, occurred_at);


--
-- Name: mnemo_scoped_key_usage_key_at_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_scoped_key_usage_key_at_idx ON mnemosyne.mnemo_scoped_key_usage USING btree (key_id, at DESC);


--
-- Name: mnemo_workspace_kek_ws_idx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE INDEX mnemo_workspace_kek_ws_idx ON mnemosyne.mnemo_workspace_kek USING btree (workspace_id, rotated_at DESC);


--
-- Name: mnemo_workspace_kek_ws_version_uidx; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX mnemo_workspace_kek_ws_version_uidx ON mnemosyne.mnemo_workspace_kek USING btree (workspace_id, kek_version);


--
-- Name: uniq_mnemo_decision_topic; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX uniq_mnemo_decision_topic ON mnemosyne.mnemo_decision USING btree (workspace_id, topic_key) WHERE ((topic_key IS NOT NULL) AND (status = 'active'::text) AND (valid_to IS NULL));


--
-- Name: uniq_mnemo_fact_dedup; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX uniq_mnemo_fact_dedup ON mnemosyne.mnemo_fact USING btree (workspace_id, scope, COALESCE(scope_ref, ''::text), subject, md5(statement)) WHERE ((status = 'active'::text) AND (valid_to IS NULL));


--
-- Name: uniq_mnemo_workspace_tenant_slug; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX uniq_mnemo_workspace_tenant_slug ON mnemosyne.mnemo_workspace USING btree (tenant_id, slug) WHERE (slug IS NOT NULL);


--
-- Name: uq_break_glass_one_pending; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX uq_break_glass_one_pending ON mnemosyne.mnemo_break_glass_request USING btree (workspace_id, requested_by) WHERE (status = 'pending'::text);


--
-- Name: uq_mv_conditional_patterns; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX uq_mv_conditional_patterns ON mnemosyne.mv_conditional_patterns USING btree (workspace_id, query_key, fact_id);


--
-- Name: uq_mv_confidence_map; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX uq_mv_confidence_map ON mnemosyne.mv_confidence_map USING btree (workspace_id, entity_id);


--
-- Name: uq_mv_knowledge_gaps; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX uq_mv_knowledge_gaps ON mnemosyne.mv_knowledge_gaps USING btree (workspace_id, topic_key);


--
-- Name: uq_mv_periodic_patterns; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX uq_mv_periodic_patterns ON mnemosyne.mv_periodic_patterns USING btree (workspace_id, memory_id, day_of_week, hour_bucket);


--
-- Name: uq_mv_sequential_patterns; Type: INDEX; Schema: mnemosyne; Owner: -
--

CREATE UNIQUE INDEX uq_mv_sequential_patterns ON mnemosyne.mv_sequential_patterns USING btree (workspace_id, predecessor_id, successor_id);


--
-- Name: mnemo_audit_log_y2026m01_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m01_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m01_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m01_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m01_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m01_pkey;


--
-- Name: mnemo_audit_log_y2026m01_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m01_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m02_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m02_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m02_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m02_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m02_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m02_pkey;


--
-- Name: mnemo_audit_log_y2026m02_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m02_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m03_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m03_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m03_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m03_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m03_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m03_pkey;


--
-- Name: mnemo_audit_log_y2026m03_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m03_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m04_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m04_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m04_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m04_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m04_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m04_pkey;


--
-- Name: mnemo_audit_log_y2026m04_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m04_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m05_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m05_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m05_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m05_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m05_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m05_pkey;


--
-- Name: mnemo_audit_log_y2026m05_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m05_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m06_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m06_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m06_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m06_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m06_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m06_pkey;


--
-- Name: mnemo_audit_log_y2026m06_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m06_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m07_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m07_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m07_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m07_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m07_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m07_pkey;


--
-- Name: mnemo_audit_log_y2026m07_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m07_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m08_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m08_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m08_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m08_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m08_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m08_pkey;


--
-- Name: mnemo_audit_log_y2026m08_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m08_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m09_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m09_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m09_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m09_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m09_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m09_pkey;


--
-- Name: mnemo_audit_log_y2026m09_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m09_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m10_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m10_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m10_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m10_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m10_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m10_pkey;


--
-- Name: mnemo_audit_log_y2026m10_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m10_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m11_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m11_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m11_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m11_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m11_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m11_pkey;


--
-- Name: mnemo_audit_log_y2026m11_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m11_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m12_action_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_action ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m12_action_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m12_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_log_created_brin ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m12_created_at_idx;


--
-- Name: mnemo_audit_log_y2026m12_pkey; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.mnemo_audit_log_pkey ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m12_pkey;


--
-- Name: mnemo_audit_log_y2026m12_workspace_id_actor_id_created_at_idx; Type: INDEX ATTACH; Schema: mnemosyne; Owner: -
--

ALTER INDEX mnemosyne.idx_audit_workspace_actor ATTACH PARTITION mnemosyne.mnemo_audit_log_y2026m12_workspace_id_actor_id_created_at_idx;


--
-- Name: mnemo_audit_log enforce_audit_immutable; Type: TRIGGER; Schema: mnemosyne; Owner: -
--

CREATE TRIGGER enforce_audit_immutable BEFORE DELETE OR UPDATE ON mnemosyne.mnemo_audit_log FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_audit_immutable();


--
-- Name: mnemo_deletion_log enforce_deletion_log_immutable; Type: TRIGGER; Schema: mnemosyne; Owner: -
--

CREATE TRIGGER enforce_deletion_log_immutable BEFORE DELETE OR UPDATE ON mnemosyne.mnemo_deletion_log FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_deletion_log_immutable();


--
-- Name: mnemo_decision mnemo_decision_updated_at; Type: TRIGGER; Schema: mnemosyne; Owner: -
--

CREATE TRIGGER mnemo_decision_updated_at BEFORE UPDATE ON mnemosyne.mnemo_decision FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_decision_set_updated_at();


--
-- Name: mnemo_fact mnemo_fact_updated_at; Type: TRIGGER; Schema: mnemosyne; Owner: -
--

CREATE TRIGGER mnemo_fact_updated_at BEFORE UPDATE ON mnemosyne.mnemo_fact FOR EACH ROW EXECUTE FUNCTION mnemosyne.mnemo_fact_set_updated_at();


--
-- Name: mnemo_migration_cursor trg_migration_cursor_updated_at; Type: TRIGGER; Schema: mnemosyne; Owner: -
--

CREATE TRIGGER trg_migration_cursor_updated_at BEFORE UPDATE ON mnemosyne.mnemo_migration_cursor FOR EACH ROW EXECUTE FUNCTION mnemosyne.update_migration_cursor_updated_at();


--
-- Name: mnemo_citation mnemo_citation_judge_relation_id_fkey; Type: FK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_citation
    ADD CONSTRAINT mnemo_citation_judge_relation_id_fkey FOREIGN KEY (judge_relation_id) REFERENCES mnemosyne.mnemo_relation(id) ON DELETE SET NULL;


--
-- Name: mnemo_decision mnemo_decision_superseded_by_id_fkey; Type: FK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_decision
    ADD CONSTRAINT mnemo_decision_superseded_by_id_fkey FOREIGN KEY (superseded_by_id) REFERENCES mnemosyne.mnemo_decision(id) ON DELETE SET NULL;


--
-- Name: mnemo_fact mnemo_fact_episode_id_fkey; Type: FK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_fact
    ADD CONSTRAINT mnemo_fact_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES mnemosyne.mnemo_episode(id) ON DELETE SET NULL;


--
-- Name: mnemo_fact mnemo_fact_merged_into_id_fkey; Type: FK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_fact
    ADD CONSTRAINT mnemo_fact_merged_into_id_fkey FOREIGN KEY (merged_into_id) REFERENCES mnemosyne.mnemo_fact(id) ON DELETE SET NULL;


--
-- Name: mnemo_inference_log mnemo_inference_log_rule_id_fkey; Type: FK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_inference_log
    ADD CONSTRAINT mnemo_inference_log_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES mnemosyne.mnemo_composition_rule(id);


--
-- Name: mnemo_prime_ctx mnemo_prime_ctx_session_id_fkey; Type: FK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_prime_ctx
    ADD CONSTRAINT mnemo_prime_ctx_session_id_fkey FOREIGN KEY (session_id) REFERENCES mnemosyne.mnemo_session(id) ON DELETE CASCADE;


--
-- Name: mnemo_recall_log mnemo_recall_log_session_id_fkey; Type: FK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_recall_log
    ADD CONSTRAINT mnemo_recall_log_session_id_fkey FOREIGN KEY (session_id) REFERENCES mnemosyne.mnemo_session(id) ON DELETE SET NULL;


--
-- Name: mnemo_relation mnemo_relation_superseded_by_relation_id_fkey; Type: FK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_relation
    ADD CONSTRAINT mnemo_relation_superseded_by_relation_id_fkey FOREIGN KEY (superseded_by_relation_id) REFERENCES mnemosyne.mnemo_relation(id) ON DELETE SET NULL;


--
-- Name: mnemo_session_turn mnemo_session_turn_session_id_fkey; Type: FK CONSTRAINT; Schema: mnemosyne; Owner: -
--

ALTER TABLE ONLY mnemosyne.mnemo_session_turn
    ADD CONSTRAINT mnemo_session_turn_session_id_fkey FOREIGN KEY (session_id) REFERENCES mnemosyne.mnemo_session(id) ON DELETE CASCADE;


--
-- Name: mnemo_access_policy; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_access_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_access_policy mnemo_access_policy_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_access_policy_ws ON mnemosyne.mnemo_access_policy USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_actor_dek; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_actor_dek ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_actor_dek mnemo_actor_dek_ws_isolation; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_actor_dek_ws_isolation ON mnemosyne.mnemo_actor_dek USING ((workspace_id = current_setting('mnemosyne.workspace_id'::text, true)));


--
-- Name: mnemo_agent_profile; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_agent_profile ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_agent_profile mnemo_agent_profile_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_agent_profile_ws ON mnemosyne.mnemo_agent_profile USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_analogy_map; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_analogy_map ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_analogy_map mnemo_analogy_map_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_analogy_map_ws ON mnemosyne.mnemo_analogy_map USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_approval_request; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_approval_request ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_approval_request mnemo_approval_request_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_approval_request_ws ON mnemosyne.mnemo_approval_request USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_audit_log; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_audit_log mnemo_audit_log_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_audit_log_ws ON mnemosyne.mnemo_audit_log FOR SELECT USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_break_glass_request; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_break_glass_request ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_break_glass_request mnemo_break_glass_request_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_break_glass_request_ws ON mnemosyne.mnemo_break_glass_request USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_causal_chain; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_causal_chain ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_causal_chain mnemo_causal_chain_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_causal_chain_ws ON mnemosyne.mnemo_causal_chain USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_citation; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_citation ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_citation mnemo_citation_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_citation_ws ON mnemosyne.mnemo_citation USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_composition_rule; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_composition_rule ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_composition_rule mnemo_composition_rule_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_composition_rule_ws ON mnemosyne.mnemo_composition_rule USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_contradiction_queue; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_contradiction_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_contradiction_queue mnemo_contradiction_queue_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_contradiction_queue_ws ON mnemosyne.mnemo_contradiction_queue USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_decision; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_decision ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_decision mnemo_decision_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_decision_ws ON mnemosyne.mnemo_decision USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_embedding_cache; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_embedding_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_embedding_cache mnemo_embedding_cache_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_embedding_cache_ws ON mnemosyne.mnemo_embedding_cache USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_encryption_keys; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_encryption_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_encryption_keys mnemo_encryption_keys_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_encryption_keys_ws ON mnemosyne.mnemo_encryption_keys USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_entity; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_entity ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_entity mnemo_entity_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_entity_ws ON mnemosyne.mnemo_entity USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_episode; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_episode ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_episode mnemo_episode_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_episode_ws ON mnemosyne.mnemo_episode USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_event; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_event ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_event mnemo_event_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_event_ws ON mnemosyne.mnemo_event USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_fact; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_fact ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_fact mnemo_fact_actor_isolation_select; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_fact_actor_isolation_select ON mnemosyne.mnemo_fact AS RESTRICTIVE FOR SELECT USING (((current_setting('app.enforce_actor_isolation'::text, true) IS DISTINCT FROM 'true'::text) OR (actor_id IS NULL) OR (actor_id = current_setting('app.actor_id'::text, true))));


--
-- Name: mnemo_fact_archive; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_fact_archive ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_fact_archive mnemo_fact_archive_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_fact_archive_ws ON mnemosyne.mnemo_fact_archive USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_fact_hash; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_fact_hash ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_fact_hash mnemo_fact_hash_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_fact_hash_ws ON mnemosyne.mnemo_fact_hash USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_fact_lsh; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_fact_lsh ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_fact_lsh mnemo_fact_lsh_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_fact_lsh_ws ON mnemosyne.mnemo_fact_lsh USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_fact mnemo_fact_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_fact_ws ON mnemosyne.mnemo_fact USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_federated_item; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_federated_item ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_federated_item mnemo_federated_item_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_federated_item_ws ON mnemosyne.mnemo_federated_item USING ((workspace_id = (current_setting('app.current_workspace_id'::text))::uuid));


--
-- Name: mnemo_health; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_health ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_health mnemo_health_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_health_ws ON mnemosyne.mnemo_health USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_hyperedge; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_hyperedge ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_hyperedge mnemo_hyperedge_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_hyperedge_ws ON mnemosyne.mnemo_hyperedge USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_idempotency_keys; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_idempotency_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_idempotency_keys mnemo_idempotency_reap; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_idempotency_reap ON mnemosyne.mnemo_idempotency_keys TO mnemo_app_role USING (((recovery_point <> 'completed'::text) AND (created_at < (now() - '72:00:00'::interval))));


--
-- Name: mnemo_idempotency_keys mnemo_idempotency_ws_isolation; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_idempotency_ws_isolation ON mnemosyne.mnemo_idempotency_keys USING ((workspace_id = current_setting('mnemosyne.workspace_id'::text, true)));


--
-- Name: mnemo_inference_log; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_inference_log ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_inference_log mnemo_inference_log_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_inference_log_ws ON mnemosyne.mnemo_inference_log USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_key_escrow; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_key_escrow ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_key_escrow mnemo_key_escrow_rls; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_key_escrow_rls ON mnemosyne.mnemo_key_escrow USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_meter_event; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_meter_event ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_meter_event mnemo_meter_event_workspace_isolation; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_meter_event_workspace_isolation ON mnemosyne.mnemo_meter_event USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_migration_cursor; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_migration_cursor ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_migration_cursor mnemo_migration_cursor_workspace_isolation; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_migration_cursor_workspace_isolation ON mnemosyne.mnemo_migration_cursor USING ((workspace_id = current_setting('app.workspace_id'::text, true)));


--
-- Name: mnemo_plugin_state; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_plugin_state ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_plugin_state mnemo_plugin_state_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_plugin_state_ws ON mnemosyne.mnemo_plugin_state USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_prime_ctx; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_prime_ctx ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_prime_ctx mnemo_prime_ctx_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_prime_ctx_ws ON mnemosyne.mnemo_prime_ctx USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_prompt_version; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_prompt_version ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_prompt_version mnemo_prompt_version_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_prompt_version_ws ON mnemosyne.mnemo_prompt_version USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_query_cache; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_query_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_query_cache mnemo_query_cache_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_query_cache_ws ON mnemosyne.mnemo_query_cache USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_reasoning; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_reasoning ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_reasoning mnemo_reasoning_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_reasoning_ws ON mnemosyne.mnemo_reasoning USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_recall_log; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_recall_log ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_recall_log mnemo_recall_log_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_recall_log_ws ON mnemosyne.mnemo_recall_log USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_relation; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_relation ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_relation mnemo_relation_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_relation_ws ON mnemosyne.mnemo_relation USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_reminder; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_reminder ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_reminder mnemo_reminder_workspace_isolation; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_reminder_workspace_isolation ON mnemosyne.mnemo_reminder USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text))::uuid));


--
-- Name: mnemo_review_item; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_review_item ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_review_item mnemo_review_item_isolation; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_review_item_isolation ON mnemosyne.mnemo_review_item USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_review_queue; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_review_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_review_queue mnemo_review_queue_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_review_queue_ws ON mnemosyne.mnemo_review_queue USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_salience_map; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_salience_map ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_salience_map mnemo_salience_map_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_salience_map_ws ON mnemosyne.mnemo_salience_map USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_session; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_session ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_session_token; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_session_token ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_session_token mnemo_session_token_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_session_token_ws ON mnemosyne.mnemo_session_token USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_session_turn; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_session_turn ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_session_turn mnemo_session_turn_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_session_turn_ws ON mnemosyne.mnemo_session_turn USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_session mnemo_session_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_session_ws ON mnemosyne.mnemo_session USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_skill; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_skill ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_skill mnemo_skill_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_skill_ws ON mnemosyne.mnemo_skill USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_spatial_index; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_spatial_index ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_spatial_index mnemo_spatial_index_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_spatial_index_ws ON mnemosyne.mnemo_spatial_index USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_strategy; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_strategy ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_strategy mnemo_strategy_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_strategy_ws ON mnemosyne.mnemo_strategy USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_sync_cursor; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_sync_cursor ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_sync_cursor mnemo_sync_cursor_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_sync_cursor_ws ON mnemosyne.mnemo_sync_cursor USING ((workspace_id = (current_setting('app.current_workspace_id'::text))::uuid));


--
-- Name: mnemo_sync_supersession; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_sync_supersession ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_sync_supersession mnemo_sync_supersession_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_sync_supersession_ws ON mnemosyne.mnemo_sync_supersession USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_sync_tombstone; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_sync_tombstone ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_sync_tombstone mnemo_sync_tombstone_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_sync_tombstone_ws ON mnemosyne.mnemo_sync_tombstone USING ((workspace_id = (current_setting('app.current_workspace_id'::text))::uuid));


--
-- Name: mnemo_task; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_task ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_task mnemo_task_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_task_ws ON mnemosyne.mnemo_task USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_temporal_anchor; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_temporal_anchor ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_temporal_anchor mnemo_temporal_anchor_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_temporal_anchor_ws ON mnemosyne.mnemo_temporal_anchor USING ((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_tenant; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_tenant ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_tenant_member; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_tenant_member ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_tenant_member mnemo_tenant_member_read; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_tenant_member_read ON mnemosyne.mnemo_tenant_member FOR SELECT USING (((tenant_id = current_setting('mnemosyne.actor_tenant_id'::text, true)) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) = ''::text) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) IS NULL)));


--
-- Name: mnemo_tenant_member mnemo_tenant_member_write; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_tenant_member_write ON mnemosyne.mnemo_tenant_member USING (((tenant_id = current_setting('mnemosyne.actor_tenant_id'::text, true)) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) = ''::text) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) IS NULL)));


--
-- Name: mnemo_tenant mnemo_tenant_read; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_tenant_read ON mnemosyne.mnemo_tenant FOR SELECT USING (true);


--
-- Name: mnemo_tenant mnemo_tenant_write; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_tenant_write ON mnemosyne.mnemo_tenant USING (((id = current_setting('mnemosyne.actor_tenant_id'::text, true)) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) = ''::text) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) IS NULL)));


--
-- Name: mnemo_user; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_user ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_user mnemo_user_own; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_user_own ON mnemosyne.mnemo_user USING (((id = current_setting('mnemosyne.actor_user_id'::text, true)) OR (current_setting('mnemosyne.actor_user_id'::text, true) = ''::text) OR (current_setting('mnemosyne.actor_user_id'::text, true) IS NULL)));


--
-- Name: mnemo_webhook_delivery; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_webhook_delivery ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_webhook_delivery mnemo_webhook_delivery_workspace_isolation; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_webhook_delivery_workspace_isolation ON mnemosyne.mnemo_webhook_delivery USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text))::uuid));


--
-- Name: mnemo_webhook_endpoint; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_webhook_endpoint ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_webhook_endpoint mnemo_webhook_endpoint_workspace_isolation; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_webhook_endpoint_workspace_isolation ON mnemosyne.mnemo_webhook_endpoint USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text))::uuid));


--
-- Name: mnemo_webhook_endpoint mnemo_webhook_endpoint_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_webhook_endpoint_ws ON mnemosyne.mnemo_webhook_endpoint USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_workflow; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_workflow ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_workflow mnemo_workflow_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_workflow_ws ON mnemosyne.mnemo_workflow USING (((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id'::text, true))::uuid));


--
-- Name: mnemo_workspace; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_workspace ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_workspace_config; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_workspace_config ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_workspace_config mnemo_workspace_config_ws; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_workspace_config_ws ON mnemosyne.mnemo_workspace_config USING (((workspace_id = (current_setting('mnemosyne.workspace_id'::text, true))::uuid) OR (workspace_id = '00000000-0000-0000-0000-000000000000'::uuid)));


--
-- Name: mnemo_workspace_kek; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_workspace_kek ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_workspace_kek mnemo_workspace_kek_rls; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_workspace_kek_rls ON mnemosyne.mnemo_workspace_kek USING ((workspace_id = current_setting('mnemosyne.workspace_id'::text, true)));


--
-- Name: mnemo_workspace_member; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_workspace_member ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_workspace_member mnemo_workspace_member_read; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_workspace_member_read ON mnemosyne.mnemo_workspace_member FOR SELECT USING (((EXISTS ( SELECT 1
   FROM mnemosyne.mnemo_workspace_member self
  WHERE ((self.workspace_id = mnemo_workspace_member.workspace_id) AND (self.user_id = current_setting('mnemosyne.actor_user_id'::text, true))))) OR (user_id = current_setting('mnemosyne.actor_user_id'::text, true)) OR (current_setting('mnemosyne.actor_user_id'::text, true) = ''::text) OR (current_setting('mnemosyne.actor_user_id'::text, true) IS NULL)));


--
-- Name: mnemo_workspace_member mnemo_workspace_member_write; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_workspace_member_write ON mnemosyne.mnemo_workspace_member USING (((EXISTS ( SELECT 1
   FROM mnemosyne.mnemo_workspace_member admin_check
  WHERE ((admin_check.workspace_id = mnemo_workspace_member.workspace_id) AND (admin_check.user_id = current_setting('mnemosyne.actor_user_id'::text, true)) AND (admin_check.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (current_setting('mnemosyne.actor_user_id'::text, true) = ''::text) OR (current_setting('mnemosyne.actor_user_id'::text, true) IS NULL)));


--
-- Name: mnemo_workspace_mode; Type: ROW SECURITY; Schema: mnemosyne; Owner: -
--

ALTER TABLE mnemosyne.mnemo_workspace_mode ENABLE ROW LEVEL SECURITY;

--
-- Name: mnemo_workspace_mode mnemo_workspace_mode_rls; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_workspace_mode_rls ON mnemosyne.mnemo_workspace_mode USING ((workspace_id = current_setting('mnemosyne.workspace_id'::text, true)));


--
-- Name: mnemo_workspace mnemo_workspace_read; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_workspace_read ON mnemosyne.mnemo_workspace FOR SELECT USING ((((tenant_id = current_setting('mnemosyne.actor_tenant_id'::text, true)) AND ((visibility = 'public'::text) OR (EXISTS ( SELECT 1
   FROM mnemosyne.mnemo_workspace_member wm
  WHERE ((wm.workspace_id = mnemo_workspace.id) AND (wm.user_id = current_setting('mnemosyne.actor_user_id'::text, true))))) OR (owner_user_id = current_setting('mnemosyne.actor_user_id'::text, true)))) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) = ''::text) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) IS NULL)));


--
-- Name: mnemo_workspace mnemo_workspace_write; Type: POLICY; Schema: mnemosyne; Owner: -
--

CREATE POLICY mnemo_workspace_write ON mnemosyne.mnemo_workspace USING (((tenant_id = current_setting('mnemosyne.actor_tenant_id'::text, true)) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) = ''::text) OR (current_setting('mnemosyne.actor_tenant_id'::text, true) IS NULL)));


--
-- Grant DML access on public.mnemo_semantic_neighbor to mnemo_app_role.
-- The table is created by core migration 0073; this conditional grant closes
-- the access gap for the adapter-postgres baseline.
--

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mnemo_semantic_neighbor'
  ) THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.mnemo_semantic_neighbor
      TO mnemo_app_role;
  END IF;
END $$;


--
-- Seed built-in composition rule templates (from migrations 0044 + 0052).
-- Idempotent: ON CONFLICT (id) DO NOTHING.
-- The 3 verb-specific templates are inserted with the corrected confidences
-- and verbs from RDD-7 (0052_fix_composition_rule_confidences.sql).
--

INSERT INTO mnemosyne.mnemo_composition_rule_template
  (id, name, description, condition_dsl, action_dsl, priority)
VALUES
(
  'builtin_transitive_part_of',
  'transitive_part_of',
  'A part_of B, B part_of C → A is transitively part of C (part-whole hierarchy flattening)',
  '{"all":[{"op":"relation","from":"$a","to":"$b","verb":"part_of"},{"op":"relation","from":"$b","to":"$c","verb":"part_of"}]}'::jsonb,
  '{"op":"derive_fact","statementTemplate":"$a is transitively part of $c (via $b)","baseConfidence":0.8,"sensitivity":"internal","type":"fact","kind":"relationship"}'::jsonb,
  110
),
(
  'builtin_conflict_propagation',
  'conflict_propagation',
  'A conflicts_with B, B supersedes C → A may conflict with C (transitive conflict warning)',
  '{"all":[{"op":"relation","from":"$a","to":"$b","verb":"conflicts_with"},{"op":"relation","from":"$b","to":"$c","verb":"supersedes"}]}'::jsonb,
  '{"op":"derive_warning","statementTemplate":"⚠️ $a may conflict with $c (transitively via $b which conflicts with $a)","baseConfidence":0.5,"sensitivity":"internal","type":"warning","kind":"concern"}'::jsonb,
  95
),
(
  'builtin_scope_inheritance',
  'scope_inheritance',
  'A scoped B, B scoped C → A scope may extend to C (scope propagation)',
  '{"all":[{"op":"relation","from":"$a","to":"$b","verb":"scoped"},{"op":"relation","from":"$c","to":"$b","verb":"scoped"}]}'::jsonb,
  '{"op":"derive_fact","statementTemplate":"$a scope may extend to $c through $b (scope inheritance)","baseConfidence":0.6,"sensitivity":"internal","type":"fact","kind":"relationship"}'::jsonb,
  85
)
ON CONFLICT (id) DO NOTHING;


--
-- Schema-level USAGE and per-table/sequence/function grants for mnemo_app_role
-- and related roles. These mirror the pg_dump grant section from main, ensuring
-- NOSUPERUSER NOBYPASSRLS connections that inherit mnemo_app_role can fully
-- operate on all mnemosyne.* objects.
--

GRANT USAGE ON SCHEMA mnemosyne TO mnemo_app_role;
GRANT USAGE ON SCHEMA mnemosyne TO mnemo_v3_app_role;
GRANT USAGE ON SCHEMA mnemosyne TO mnemo_owner;

GRANT ALL ON FUNCTION mnemosyne.mnemo_metacognition_trends(p_workspace_id uuid) TO mnemo_app_role;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_refresh_anticipation() FROM PUBLIC;
GRANT ALL ON FUNCTION mnemosyne.mnemo_refresh_anticipation() TO mnemo_app_role;
GRANT ALL ON FUNCTION mnemosyne.mnemo_refresh_metacognition() TO mnemo_app_role;
GRANT ALL ON FUNCTION mnemosyne.mnemo_seed_builtin_rules(p_workspace_id uuid) TO mnemo_app_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_access_policy TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_actor_dek TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_agent_profile TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_analogy_map TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_api_keys TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_approval_request TO mnemo_app_role;
GRANT SELECT,INSERT ON TABLE mnemosyne.mnemo_audit_log TO mnemo_app_role;
GRANT USAGE ON SEQUENCE mnemosyne.mnemo_audit_log_id_seq TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_break_glass_request TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_causal_chain TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_citation TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_composition_rule TO mnemo_app_role;
GRANT SELECT,INSERT ON TABLE mnemosyne.mnemo_composition_rule TO mnemo_owner;
GRANT SELECT ON TABLE mnemosyne.mnemo_composition_rule_template TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mnemo_composition_rule_template TO mnemo_owner;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_contradiction_queue TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_decision TO mnemo_app_role;
GRANT INSERT ON TABLE mnemosyne.mnemo_deletion_log TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_encryption_keys TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_entity TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mnemo_entity TO mnemo_owner;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_episode TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_event TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_fact TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mnemo_fact TO mnemo_owner;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_fact_archive TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_fact_hash TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_fact_lsh TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_federated_item TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_health TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_hyperedge TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_idempotency_keys TO mnemo_app_role;
GRANT SELECT,INSERT ON TABLE mnemosyne.mnemo_inference_log TO mnemo_app_role;
GRANT SELECT,INSERT ON TABLE mnemosyne.mnemo_meter_event TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_migration_cursor TO mnemo_app_role;
GRANT SELECT,INSERT ON TABLE mnemosyne.mnemo_outbox TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_plugin_state TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_prime_ctx TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_prompt_version TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_query_cache TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_reasoning TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_recall_log TO mnemo_app_role;
GRANT SELECT,INSERT ON TABLE mnemosyne.mnemo_recall_log TO mnemo_owner;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_relation TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_reminder TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_review_queue TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_salience_map TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_session TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mnemo_session TO mnemo_owner;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_session_token TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_session_turn TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_skill TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_spatial_index TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_strategy TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mnemo_strategy TO mnemo_owner;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_sync_cursor TO mnemo_app_role;
GRANT SELECT,INSERT ON TABLE mnemosyne.mnemo_sync_supersession TO mnemo_app_role;
GRANT SELECT,INSERT ON TABLE mnemosyne.mnemo_sync_tombstone TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_task TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_temporal_anchor TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_tenant TO app_user;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_tenant TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_tenant_member TO app_user;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_tenant_member TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_user TO app_user;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_user TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_webhook_delivery TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_webhook_endpoint TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_workflow TO mnemo_app_role;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_workspace TO app_user;
GRANT SELECT,INSERT,UPDATE ON TABLE mnemosyne.mnemo_workspace TO mnemo_app_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_workspace_config TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mnemo_workspace_config TO app_user;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_workspace_member TO app_user;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mnemosyne.mnemo_workspace_member TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mv_conditional_patterns TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mv_confidence_map TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mv_knowledge_gaps TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mv_periodic_patterns TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mv_sequential_patterns TO mnemo_app_role;

-- Direct grants for app_user (absorbed from 0004_fix_app_user_role_grant.sql +
-- 0005_fix_app_user_schema_access.sql).
--
-- These cannot be expressed through the IF NOT EXISTS role-creation block above
-- because that block is skipped when app_user was pre-created by the core
-- migration stream (0015_mnemo_rls_foundation.sql).  The unconditional GRANT
-- below ensures membership even on DBs where app_user already existed.
GRANT mnemo_app_role TO app_user;

-- Direct USAGE + search_path for app_user so that SET LOCAL ROLE app_user
-- (executed by withMnemoTx when the connecting role is a superuser) can resolve
-- mnemosyne.* objects without relying solely on inherited mnemo_app_role USAGE.
-- In PG17, SET LOCAL ROLE re-evaluates effective search_path from ALTER ROLE
-- config; without these lines, unqualified table refs in withMnemoTx transactions
-- connecting as a superuser (e.g. mnemo) fail with "relation does not exist".
GRANT USAGE ON SCHEMA mnemosyne TO app_user;
ALTER ROLE app_user SET search_path TO mnemosyne, public;

-- Direct INSERT grant on mnemo_session for app_user — ensures POST /session/start
-- succeeds regardless of whether inherited table grants via mnemo_app_role are
-- re-evaluated after SET LOCAL ROLE in the PG17 session context.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_session TO app_user;


--
-- Populate materialized views after all tables are created.
-- Views were created WITH NO DATA; initial non-concurrent REFRESH is required
-- so queries against them don't fail with "has not been populated".
--

REFRESH MATERIALIZED VIEW mnemosyne.mv_sequential_patterns;
REFRESH MATERIALIZED VIEW mnemosyne.mv_periodic_patterns;
REFRESH MATERIALIZED VIEW mnemosyne.mv_conditional_patterns;
REFRESH MATERIALIZED VIEW mnemosyne.mv_confidence_map;
REFRESH MATERIALIZED VIEW mnemosyne.mv_knowledge_gaps;


--
-- PostgreSQL database dump complete
--

