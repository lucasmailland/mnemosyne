import { createHmac } from "node:crypto";
import type { StorageAdapter, Telemetry } from "@mnemo-ai/types";
import { buildSignatureHeaders } from "../webhookSigner.js";
import { injectTraceContext } from "../telemetry/otel.js";
import { checkWebhookUrl } from "../webhook-url-guard.js";

// Backoff ladder in seconds: attempt index → delay before next retry
// attempt 1 = immediate (0s), attempt 2 = 5m, attempt 3 = 30m, attempt 4 = 2h, attempt 5 = 24h
const BACKOFF_SECONDS = [0, 300, 1800, 7200, 86400] as const;
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
const ENDPOINT_STRIKE_THRESHOLD = 3;

function signPayload(secret: string, body: string): string {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return `t=${t},v1=${sig}`;
}

export interface WebhookDeliveryDeps {
  storage: StorageAdapter;
  logger: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
    error?(o: object, m?: string): void;
  };
  telemetry: Telemetry;
  /**
   * F12: decrypts the workspace-KEK-encrypted signing secret before HMAC. When
   * absent (dev), endpoint.secretHash is treated as the raw secret.
   */
  webhookSecretCipher?: {
    decrypt(workspaceId: string, blob: string): string;
  };
}

export async function runWebhookDeliveryBatch(
  deps: WebhookDeliveryDeps,
  batchSize = 100
): Promise<{ delivered: number; failed: number; retried: number }> {
  const deliveries = await deps.storage.listPendingWebhookDeliveries(batchSize);
  if (deliveries.length === 0) return { delivered: 0, failed: 0, retried: 0 };

  let delivered = 0;
  let failed = 0;
  let retried = 0;

  for (const delivery of deliveries) {
    const endpoint = await deps.storage
      .getWebhookEndpoint(delivery.webhookId, delivery.workspaceId)
      .catch(() => null);

    if (!endpoint || !endpoint.isActive) {
      await deps.storage.updateWebhookDelivery(delivery.id, delivery.workspaceId, {
        status: "failed",
        responseBody: endpoint ? "endpoint disabled" : "endpoint not found",
      });
      failed++;
      continue;
    }

    // APP-005: checked on every attempt, since a name accepted at registration
    // can be re-pointed afterwards. A refused target is not retried.
    const verdict = await checkWebhookUrl(endpoint.url);
    if (!verdict.ok) {
      await deps.storage.updateWebhookDelivery(delivery.id, delivery.workspaceId, {
        status: "failed",
        responseBody: `refused: ${verdict.reason}`,
        nextAttemptAt: null,
      });
      failed++;
      deps.telemetry.counter("mnemo_webhook_delivery_total", 1, { status: "refused" });
      continue;
    }

    const body = JSON.stringify({ eventType: delivery.eventType, data: delivery.payload });
    // F12: secretHash holds the workspace-KEK-encrypted signing secret. Decrypt
    // before signing; legacy plaintext rows that pre-date F12 fail decrypt and
    // fall back to passthrough (one-time backfill).
    let signingSecret: string;
    if (deps.webhookSecretCipher) {
      try {
        signingSecret = deps.webhookSecretCipher.decrypt(delivery.workspaceId, endpoint.secretHash);
      } catch {
        // Legacy plaintext row not yet backfilled — use as-is.
        signingSecret = endpoint.secretHash;
      }
    } else {
      signingSecret = endpoint.secretHash;
    }
    const sig = signPayload(signingSecret, body);

    let responseStatus: number | undefined;
    let responseBody: string | undefined;
    let success = false;

    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        redirect: "manual",
        headers: injectTraceContext({
          "Content-Type": "application/json",
          ...buildSignatureHeaders(sig),
          "X-Mnemosyne-Event": delivery.eventType,
        }),
        body,
        signal: AbortSignal.timeout(10_000),
      });

      responseStatus = res.status;
      // Only the status is kept. The name was checked above, but fetch()
      // resolves it again, so whatever answered may sit inside; its body was
      // stored and served by GET /webhooks/:id/deliveries (re-audit 2026-11-22).
      await res.body?.cancel().catch(() => undefined);
      success = res.ok;
    } catch (err) {
      responseBody = err instanceof Error ? err.message : String(err);
    }

    if (success) {
      await deps.storage.updateWebhookDelivery(delivery.id, delivery.workspaceId, {
        status: "delivered",
        responseStatus,
        responseBody,
        deliveredAt: new Date(),
        nextAttemptAt: null,
      });
      delivered++;
      deps.telemetry.counter("mnemo_webhook_delivery_total", 1, { status: "delivered" });
    } else {
      const nextAttemptIdx = delivery.attempt; // attempt 1 → index 1 (300s), etc.
      if (delivery.attempt >= MAX_ATTEMPTS) {
        // Dead-letter: no more retries
        await deps.storage.updateWebhookDelivery(delivery.id, delivery.workspaceId, {
          status: "failed",
          responseStatus,
          responseBody,
          nextAttemptAt: null,
        });
        failed++;
        deps.telemetry.counter("mnemo_webhook_delivery_total", 1, { status: "dead_letter" });

        // 3-strike auto-disable
        const newFailureCount = (endpoint.failureCount ?? 0) + 1;
        if (newFailureCount >= ENDPOINT_STRIKE_THRESHOLD) {
          await deps.storage
            .updateWebhookEndpoint(delivery.webhookId, delivery.workspaceId, {
              isActive: false,
              failureCount: newFailureCount,
              disabledAt: new Date(),
            })
            .catch((err) => {
              deps.logger.warn?.(
                { err, webhookId: delivery.webhookId },
                "webhook.endpoint_disable_failed"
              );
            });
          deps.telemetry.counter("mnemo_webhook_endpoint_disabled_total", 1, {});
        } else {
          await deps.storage
            .updateWebhookEndpoint(delivery.webhookId, delivery.workspaceId, {
              failureCount: newFailureCount,
            })
            .catch(() => undefined);
        }
      } else {
        const delaySec = BACKOFF_SECONDS[nextAttemptIdx] ?? 86400;
        const nextAttemptAt = new Date(Date.now() + delaySec * 1000);
        await deps.storage.updateWebhookDelivery(delivery.id, delivery.workspaceId, {
          attempt: delivery.attempt + 1,
          responseStatus,
          responseBody,
          nextAttemptAt,
        });
        retried++;
        deps.telemetry.counter("mnemo_webhook_delivery_total", 1, { status: "retried" });
      }

      deps.logger.warn?.(
        { deliveryId: delivery.id, attempt: delivery.attempt, responseStatus },
        "webhook.delivery_failed"
      );
    }
  }

  return { delivered, failed, retried };
}
