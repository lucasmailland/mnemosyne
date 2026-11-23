/**
 * OPS-6 — Webhook event dispatcher.
 *
 * For every domain event that reaches the server bus, this module fans out
 * `webhook_fire` outbox entries to all active endpoints that have subscribed
 * to the event type (or the wildcard "*"). The OutboxWorker then drains those
 * entries and performs the actual HTTP delivery with retries.
 *
 * Design:
 *  - Errors listing endpoints or appending individual entries are logged but
 *    never thrown — a broken webhook must not break the originating request.
 *  - `deps.storage` is optional because ServerDeps.storage is optional; when
 *    absent the function is a no-op so callers need no guard.
 */

import type { ServerDeps } from "./deps.js";
import { logger } from "./logging.js";

const ABOVE_INTERNAL = new Set(["confidential", "restricted"]);
/** Fields that carry the content of a memory, as opposed to its metadata. */
const TEXT_FIELDS = [
  "statement",
  "content",
  "title",
  "body",
  "description",
  "narrative",
  "summary",
  "question",
  "conclusion",
  "chain",
  "trigger",
  "action",
  "context",
  "promptTemplate",
  "outcome",
  "lessonsLearned",
  "query",
  "hits",
];

/** The payload with its text removed when its tier is above `internal`. */
export function redactForEgress(payload: Record<string, unknown>): Record<string, unknown> {
  const tier = payload["sensitivity"];
  if (typeof tier !== "string" || !ABOVE_INTERNAL.has(tier)) return payload;
  const out: Record<string, unknown> = { ...payload, redacted: true };
  for (const field of TEXT_FIELDS) delete out[field];
  return out;
}

export async function dispatchWebhookEvent(
  deps: Pick<ServerDeps, "storage" | "webhookSecretCipher">,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!deps.storage) return;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
    logger.warn({ workspaceId, eventType }, "webhook_dispatch.invalid_workspace_id");
    return;
  }

  let endpoints;
  try {
    endpoints = await deps.storage.listWebhookEndpoints(workspaceId);
  } catch (err) {
    logger.warn({ err, workspaceId, eventType }, "webhook_dispatch.list_failed");
    return;
  }

  const subscribed = endpoints.filter(
    (e) => e.isActive && (e.events.includes(eventType) || e.events.includes("*"))
  );

  // APP-006: a webhook is egress to a third party. Text above `internal` never
  // leaves in it, the same line MNEMO_SENSITIVE_TEXT_TO_PROVIDERS draws for model
  // providers; the receiver gets the id and the metadata and reads the text back
  // through the API with a key that may see it.
  const outgoing = redactForEgress(payload);
  for (const e of subscribed) {
    try {
      // APP-030: the signing secret is NOT copied into the outbox (no RLS there,
      // rows kept until retention). The delivery worker decrypts it from the
      // endpoint row when it sends.
      await deps.storage.appendOutbox({
        workspaceId,
        eventType: "webhook_fire",
        payload: {
          webhookId: e.id,
          workspaceId,
          url: e.url,
          eventType,
          payload: outgoing,
        },
      });
    } catch (err) {
      logger.warn(
        { err, webhookId: e.id, workspaceId, eventType },
        "webhook_dispatch.append_failed"
      );
    }
  }
}
