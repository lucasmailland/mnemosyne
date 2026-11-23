-- Migration 0021: SECURITY DEFINER claim function for pending webhook deliveries.
--
-- WEBHOOK-2 (docs/remediation/2026-07-31-post-audit-followups.md): the
-- delivery-worker cron (packages/server/src/cron/webhookDelivery.ts,
-- runWebhookDeliveryBatch) polls pending deliveries ACROSS ALL WORKSPACES in
-- one batch -- there is no single workspaceId to scope the query to, by
-- design (a cron job, not a per-request call). But
-- mnemo_webhook_delivery_workspace_isolation's RLS policy (USING
-- workspace_id::uuid = current_setting('mnemosyne.workspace_id')::uuid, no
-- missing_ok flag) throws "unrecognized configuration parameter" under a
-- real NOSUPERUSER FORCE-RLS role with the GUC never set -- there being no
-- single workspace to set it to. The delivery cron has likely never
-- successfully polled a single delivery against a real, correctly-secured
-- Postgres deployment.
--
-- Fix: a SECURITY DEFINER function, the exact same mechanism this codebase
-- already uses for mnemo_refresh_anticipation() (also touches RLS-protected
-- tables on behalf of a cross-tenant background job). The function body
-- executes as its owner (the migration-running superuser), which always
-- bypasses RLS regardless of FORCE ROW LEVEL SECURITY -- so this ONE,
-- narrowly-scoped, read-only claim query legitimately sees pending
-- deliveries across every workspace, while every other access path to
-- mnemo_webhook_delivery (GET /webhooks/:id/deliveries, recordWebhookDelivery,
-- updateWebhookDelivery -- all already workspace-scoped and GUC-fixed by
-- WEBHOOK-1) keeps real per-workspace RLS isolation as a genuine security
-- boundary. This is deliberately NOT "disable RLS on the table" (the
-- mnemo_outbox precedent) -- that would remove workspace isolation from the
-- correctly-scoped per-request paths too, which is a real regression this
-- fix must not cause.
--
-- Same query mnemo_webhook_delivery.ts's listPendingWebhookDeliveries already
-- ran (status='pending' AND next_attempt_at due), just behind the function
-- boundary. No GRANT changes on the table itself -- only EXECUTE on the new
-- function.

CREATE FUNCTION mnemosyne.mnemo_claim_pending_webhook_deliveries(p_limit integer)
    RETURNS SETOF mnemosyne.mnemo_webhook_delivery
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'public'
    AS $$
  SELECT * FROM mnemosyne.mnemo_webhook_delivery
  WHERE status = 'pending'
    AND (next_attempt_at IS NULL OR next_attempt_at <= now())
  ORDER BY created_at
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_claim_pending_webhook_deliveries(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_claim_pending_webhook_deliveries(integer) TO mnemo_app_role;
