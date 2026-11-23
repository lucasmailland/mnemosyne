-- Migration 0066: pulled items carry the registered peer id as their origin.
--
-- mnemo_federated_item.peer_domain is the origin the sync engine compares: a
-- tombstone archives a copy, and a newer version replaces it, only when it
-- comes from that same origin. Servers before the sync job stamped the peer id
-- stored the serving peer's host name there instead (the host of the request
-- URL). Those copies never match a peer id, so their own peer could no longer
-- update or delete them.
--
-- This renames them once, from host to peer id, only where exactly one
-- registered peer has that host in its url and no peer uses the host as its id.
-- An ambiguous host, or one no peer has (a proxy that rewrote Host, a peer
-- since removed), is left as it is: those copies count as another origin, so
-- no peer can delete or overwrite them. The engine does not alias host names
-- at runtime, so a peer registered later with a reused host never gains them.
--
-- Both tables are under FORCE RLS. The migration role normally bypasses RLS (a
-- superuser or BYPASSRLS role, as every backfill here assumes). Without that,
-- the policy of mnemo_federated_item would fail on the missing GUC, so the
-- rename is skipped with a notice and the rows stay as they are.
--
-- DEPLOYMENT ORDER. Any time; the server runs the same either way.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  renamed bigint;
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE NOTICE '0066: % cannot bypass RLS; federated item origins left unchanged', current_user;
    RETURN;
  END IF;

  WITH peer_host AS (
    SELECT peer_id,
           lower(substring(url FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?(\[[^]]*\]|[^/?#:]*)')) AS host
    FROM mnemosyne.mnemo_federation_peer
    WHERE url IS NOT NULL
  ),
  unambiguous AS (
    SELECT host, min(peer_id) AS peer_id
    FROM peer_host
    WHERE host IS NOT NULL AND host <> ''
    GROUP BY host
    HAVING count(*) = 1
       AND host NOT IN (SELECT peer_id FROM mnemosyne.mnemo_federation_peer)
  )
  UPDATE mnemosyne.mnemo_federated_item AS fi
     SET peer_domain = u.peer_id
    FROM unambiguous AS u
   WHERE fi.peer_domain = u.host;
  GET DIAGNOSTICS renamed = ROW_COUNT;
  RAISE NOTICE '0066: % federated item(s) now name their peer id', renamed;
END
$$;
