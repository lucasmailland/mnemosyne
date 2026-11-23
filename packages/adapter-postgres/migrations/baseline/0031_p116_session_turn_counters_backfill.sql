-- P116 — resync mnemo_session.turn_count / token_count with mnemo_session_turn.
--
-- `appendTurn` inserted the turn row and never updated the parent counters, so
-- every session written before that fix reports turn_count = 0 regardless of how
-- many turns it actually holds. Two of the three auto-collapse triggers read
-- those counters (`turn_count >= 5 OR token_count >= 1024` in the sweep
-- predicate), so stale zeros keep suppressing early collapse for the existing
-- corpus even after the write path is corrected.
--
-- Derived, not guessed: both values are recomputed FROM the turn rows, which are
-- the source of truth. Idempotent — re-running recomputes the same numbers.
-- Sessions with no turns are left alone (their 0 is already correct).
--
-- COALESCE on the token sum matters: token_count is nullable on
-- mnemo_session_turn, and SUM() over an all-NULL group returns NULL, which would
-- violate the NOT NULL on the parent column.

UPDATE mnemosyne.mnemo_session s
   SET turn_count  = t.n,
       token_count = t.tokens
  FROM (
        SELECT session_id,
               COUNT(*)::int                        AS n,
               COALESCE(SUM(token_count), 0)::int   AS tokens
          FROM mnemosyne.mnemo_session_turn
         GROUP BY session_id
       ) AS t
 WHERE s.id = t.session_id
   AND (s.turn_count IS DISTINCT FROM t.n OR s.token_count IS DISTINCT FROM t.tokens);
