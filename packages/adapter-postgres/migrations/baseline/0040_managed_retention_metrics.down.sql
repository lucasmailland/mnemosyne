-- Restores the 0001 definition, in which a NULL outcome_rating is averaged in as 0.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_metacognition_trends(p_workspace_id uuid)
RETURNS TABLE(recall_hit_rate_cur numeric, recall_hit_rate_prev numeric, avg_recall_latency_cur numeric, avg_recall_latency_prev numeric, session_collapse_qual_cur numeric, session_collapse_qual_prev numeric, strategy_success_rate_cur numeric, strategy_success_rate_prev numeric)
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
