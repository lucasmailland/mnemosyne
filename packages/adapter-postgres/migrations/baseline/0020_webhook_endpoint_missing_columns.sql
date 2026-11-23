-- Migration 0020: add mnemo_webhook_endpoint.description and .updated_at.
--
-- WEBHOOK-1: packages/adapter-postgres/src/schema/infrastructure.ts's
-- webhookEndpointTable, and the pure domain type MnemoWebhookEndpoint
-- (packages/types/src/ports.ts), have declared `description` and `updatedAt`
-- as first-class fields since before this migration existed -- and
-- routes/webhooks.ts's CreateWebhookSchema/UpdateWebhookSchema genuinely
-- accept `description` from real callers. This was never a speculative or
-- dead field; the migration that should have created these two columns was
-- simply never written.
--
-- Effect until this fix: `createWebhookEndpoint` always writes `description`
-- (even `null` when the caller omits one) and `updateWebhookEndpoint` always
-- writes `updatedAt`, both unconditionally, on every call -- so EVERY route
-- in routes/webhooks.ts (POST, GET list, GET :id, PATCH, DELETE,
-- GET :id/deliveries, POST :id/test) 500'd under a real, correctly-migrated
-- Postgres with "column does not exist". Proven red-before/green-after in
-- packages/server/src/__tests__/integration/webhook-endpoint-schema.integration.test.ts.
--
-- `last_success_at` (already on the live table) is NOT part of
-- MnemoWebhookEndpoint and is not referenced anywhere in WebhookRepository.ts
-- -- an orphaned column, deliberately left alone here. Dropping it or wiring
-- it into the delivery-success path is a separate decision (see
-- docs/remediation/2026-07-31-post-audit-followups.md, WEBHOOK-1), not
-- required to fix this bug, and carries needless risk for zero benefit.
--
-- Catalog-only for `description` (nullable, no default). `updated_at` is
-- NOT NULL with a DEFAULT (satisfies migration-safety.ts's ADD COLUMN NOT
-- NULL guard) -- `now()` is a volatile default, so Postgres will rewrite the
-- table to backfill it, but mnemo_webhook_endpoint is empty in every real
-- deployment today (nothing could ever successfully INSERT into it before
-- this fix), so the rewrite is a no-op in practice. No GRANT/RLS change.

ALTER TABLE mnemosyne.mnemo_webhook_endpoint
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
