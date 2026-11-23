-- Migration 0019: add mnemo_session.label (EPISODE-1).
--
-- `memory_episode_start` accepted a `label` argument ("Etiqueta legible
-- para el episodio ... Facilita búsqueda y depuración posterior"), and the
-- server's POST /v1/session/start Zod schema already accepted it in the
-- request body, but `mnemo_session` had no column to hold it and the
-- handler never forwarded it to `core.startSession()`. The label was
-- silently discarded end to end.
--
-- Nullable, no default, no backfill: the safest possible additive column
-- per migration-safety.ts. Existing sessions simply have label = NULL.
-- No GRANT/RLS change — covered by the existing mnemo_session policies.

ALTER TABLE mnemosyne.mnemo_session
  ADD COLUMN label text;
