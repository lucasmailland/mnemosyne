import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { randomBytes, randomUUID } from "node:crypto";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { NotFoundError } from "../errors.js";
import { signWebhookPayload, buildSignatureHeaders } from "../webhookSigner.js";
import { injectTraceContext } from "../telemetry/otel.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";
import { HttpError } from "../errors.js";
import { checkWebhookUrl } from "../webhook-url-guard.js";

/** APP-005: refuse a webhook target the server must not be made to call. */
async function assertWebhookUrl(url: string): Promise<void> {
  const verdict = await checkWebhookUrl(url);
  if (verdict.ok) return;
  const details = { reason: verdict.reason };
  // One literal per reason: the error-template table translates literals.
  switch (verdict.reason) {
    case "invalid_url":
      throw new HttpError(400, "invalid_webhook_url", "The webhook URL is not a valid URL.", details);
    case "must_be_https":
      throw new HttpError(
        400,
        "invalid_webhook_url",
        "The webhook URL must use https (an operator can allow http with MNEMO_WEBHOOK_ALLOW_HTTP=true).",
        details
      );
    case "credentials_in_url":
      throw new HttpError(
        400,
        "invalid_webhook_url",
        "The webhook URL must not carry a user name or password.",
        details
      );
    case "private_address":
      throw new HttpError(
        400,
        "invalid_webhook_url",
        "The webhook URL points at a loopback, private or link-local address (an operator can allow internal receivers with MNEMO_WEBHOOK_ALLOW_PRIVATE=true).",
        details
      );
  }
}

const WebhookEndpointSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    url: z.url(),
    events: z.array(z.string()),
    isActive: z.boolean(),
    description: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("WebhookEndpoint");

const WebhookEndpointWithSecretSchema = WebhookEndpointSchema.extend({
  secret: z.string().openapi({
    description:
      "Returned ONLY at creation time. Store it securely — it will never be shown again.",
  }),
}).openapi("WebhookEndpointWithSecret");

const CreateWebhookSchema = z
  .object({
    url: z.url(),
    events: z.array(z.string()).min(1),
    description: z.string().optional(),
  })
  .openapi("CreateWebhookRequest");

const UpdateWebhookSchema = z
  .object({
    url: z.url().optional(),
    events: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
    description: z.string().nullable().optional(),
  })
  .openapi("UpdateWebhookRequest");

const IdParamSchema = z.object({ id: z.string() });

const WebhookDeliverySchema = z
  .object({
    id: z.string(),
    webhookId: z.string(),
    workspaceId: z.string(),
    eventType: z.string(),
    payload: z.record(z.string(), z.unknown()),
    status: z.enum(["pending", "delivered", "failed"]),
    responseStatus: z.number().int().nullable(),
    responseBody: z.string().nullable(),
    attempt: z.number().int(),
    deliveredAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("WebhookDelivery");

export function mountWebhooks(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // POST /webhooks — create
  app.openapi(
    createRoute({
      method: "post",
      path: "/webhooks",
      tags: ["webhooks"],
      summary: "Register a new webhook endpoint. Secret is returned ONCE — store it immediately.",
      request: {
        body: { content: { "application/json": { schema: CreateWebhookSchema } }, required: true },
      },
      responses: {
        201: {
          description: "Webhook created. The `secret` field will not be returned again.",
          content: { "application/json": { schema: WebhookEndpointWithSecretSchema } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const provenance = resolveProvenance(c);
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");
      await assertWebhookUrl(body.url);

      const id = randomBytes(16).toString("hex");
      const secret = randomBytes(32).toString("hex");

      // F12: store the signing secret encrypted under the workspace KEK. The
      // plaintext `secret` is returned to the caller ONCE (below) and never
      // persisted in the clear.
      const storedSecret = deps.webhookSecretCipher
        ? deps.webhookSecretCipher.encrypt(workspaceId, secret)
        : secret;

      const endpoint = await deps.storage.createWebhookEndpoint({
        id,
        workspaceId,
        url: body.url,
        events: body.events,
        secretHash: storedSecret,
        description: body.description,
      });

      await emitAudit(deps, {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "create",
        resourceKind: "webhook_endpoint",
        resourceId: endpoint.id,
        isTerminal: false,
        detail: { events: endpoint.events },
      });

      return c.json(
        {
          id: endpoint.id,
          workspaceId: endpoint.workspaceId,
          url: endpoint.url,
          events: endpoint.events,
          isActive: endpoint.isActive,
          description: endpoint.description,
          createdAt: endpoint.createdAt.toISOString(),
          updatedAt: endpoint.updatedAt.toISOString(),
          secret,
        },
        201
      );
    }
  );

  // GET /webhooks — list
  app.openapi(
    createRoute({
      method: "get",
      path: "/webhooks",
      tags: ["webhooks"],
      summary: "List webhook endpoints for this workspace.",
      responses: {
        200: {
          description: "List of webhook endpoints (secret never included).",
          content: {
            "application/json": {
              schema: z
                .object({ items: z.array(WebhookEndpointSchema) })
                .openapi("ListWebhooksResponse"),
            },
          },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new Error("storage adapter not available");

      const endpoints = await deps.storage.listWebhookEndpoints(workspaceId);
      return c.json(
        {
          items: endpoints.map((e) => ({
            id: e.id,
            workspaceId: e.workspaceId,
            url: e.url,
            events: e.events,
            isActive: e.isActive,
            description: e.description,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
          })),
        },
        200
      );
    }
  );

  // GET /webhooks/:id — single endpoint
  app.openapi(
    createRoute({
      method: "get",
      path: "/webhooks/{id}",
      tags: ["webhooks"],
      summary: "Get a single webhook endpoint.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "The webhook endpoint.",
          content: { "application/json": { schema: WebhookEndpointSchema } },
        },
        404: { description: "Webhook not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new Error("storage adapter not available");

      const endpoint = await deps.storage.getWebhookEndpoint(id, workspaceId);
      if (!endpoint) throw new NotFoundError(`Webhook ${id} not found`);

      return c.json(
        {
          id: endpoint.id,
          workspaceId: endpoint.workspaceId,
          url: endpoint.url,
          events: endpoint.events,
          isActive: endpoint.isActive,
          description: endpoint.description,
          createdAt: endpoint.createdAt.toISOString(),
          updatedAt: endpoint.updatedAt.toISOString(),
        },
        200
      );
    }
  );

  // PATCH /webhooks/:id — update
  app.openapi(
    createRoute({
      method: "patch",
      path: "/webhooks/{id}",
      tags: ["webhooks"],
      summary: "Update a webhook endpoint.",
      request: {
        params: IdParamSchema,
        body: { content: { "application/json": { schema: UpdateWebhookSchema } }, required: true },
      },
      responses: {
        200: {
          description: "Updated endpoint.",
          content: { "application/json": { schema: WebhookEndpointSchema } },
        },
        404: { description: "Webhook not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      const provenance = resolveProvenance(c);
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      const existing = await deps.storage.getWebhookEndpoint(id, workspaceId);
      if (!existing) throw new NotFoundError(`Webhook ${id} not found`);
      if (body.url !== undefined) await assertWebhookUrl(body.url);

      const updated = await deps.storage.updateWebhookEndpoint(id, workspaceId, {
        url: body.url,
        events: body.events,
        isActive: body.isActive,
        description: body.description ?? undefined,
      });

      await emitAudit(deps, {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "update",
        resourceKind: "webhook_endpoint",
        resourceId: id,
        isTerminal: false,
        detail: { isActive: updated.isActive },
      });

      return c.json(
        {
          id: updated.id,
          workspaceId: updated.workspaceId,
          url: updated.url,
          events: updated.events,
          isActive: updated.isActive,
          description: updated.description,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
        200
      );
    }
  );

  // DELETE /webhooks/:id — remove
  app.openapi(
    createRoute({
      method: "delete",
      path: "/webhooks/{id}",
      tags: ["webhooks"],
      summary: "Delete a webhook endpoint.",
      request: { params: IdParamSchema },
      responses: {
        204: { description: "Deleted." },
        404: { description: "Webhook not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      const provenance = resolveProvenance(c);
      if (!deps.storage) throw new Error("storage adapter not available");

      const existing = await deps.storage.getWebhookEndpoint(id, workspaceId);
      if (!existing) throw new NotFoundError(`Webhook ${id} not found`);

      await deps.storage.deleteWebhookEndpoint(id, workspaceId);

      await emitAudit(deps, {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "delete",
        resourceKind: "webhook_endpoint",
        resourceId: id,
        isTerminal: false,
      });

      return c.body(null, 204);
    }
  );

  // GET /webhooks/:id/deliveries — recent delivery log
  app.openapi(
    createRoute({
      method: "get",
      path: "/webhooks/{id}/deliveries",
      tags: ["webhooks"],
      summary: "List recent delivery attempts for a webhook endpoint (newest first, max 50).",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "Recent deliveries.",
          content: {
            "application/json": {
              schema: z
                .object({ items: z.array(WebhookDeliverySchema) })
                .openapi("ListWebhookDeliveriesResponse"),
            },
          },
        },
        404: { description: "Webhook not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new Error("storage adapter not available");

      const existing = await deps.storage.getWebhookEndpoint(id, workspaceId);
      if (!existing) throw new NotFoundError(`Webhook ${id} not found`);

      const deliveries = await deps.storage.listWebhookDeliveries(id, workspaceId, 50);
      return c.json(
        {
          items: deliveries.map((d) => ({
            id: d.id,
            webhookId: d.webhookId,
            workspaceId: d.workspaceId,
            eventType: d.eventType,
            payload: d.payload,
            status: d.status,
            responseStatus: d.responseStatus,
            // A body on a row that has a status was written by the receiver
            // (rows from before it stopped being stored): never served. Without
            // a status it is the server's own note (refused, transport error).
            responseBody: d.responseStatus == null ? d.responseBody : null,
            attempt: d.attempt,
            deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
            createdAt: d.createdAt.toISOString(),
          })),
        },
        200
      );
    }
  );

  // POST /webhooks/:id/test — Wave V §36
  // Fires a synthetic test event immediately (bypasses the outbox).
  // Uses the new Stripe-style HMAC signature format: t=<ts>,v1=<sig>
  app.openapi(
    createRoute({
      method: "post",
      path: "/webhooks/{id}/test",
      tags: ["webhooks"],
      summary:
        "Send a test event to a webhook endpoint immediately. Validates reachability and signature flow.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "Test delivery result.",
          content: {
            "application/json": {
              schema: z
                .object({
                  success: z.boolean(),
                  statusCode: z.number().int().nullable(),
                  responseBody: z.string().nullable(),
                  signature: z.string(),
                })
                .openapi("WebhookTestResponse"),
            },
          },
        },
        404: { description: "Webhook not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      const provenance = resolveProvenance(c);
      if (!deps.storage) throw new Error("storage adapter not available");

      const endpoint = await deps.storage.getWebhookEndpoint(id, workspaceId);
      if (!endpoint) throw new NotFoundError(`Webhook ${id} not found`);

      // F12: secretHash holds the workspace-KEK-encrypted signing secret. Decrypt
      // it just-in-time to sign; when no cipher is configured (dev) it is the raw
      // secret for backward compatibility. Legacy plaintext rows that pre-date
      // F12 fail decrypt and fall back to passthrough (one-time backfill).
      let secret: string;
      if (deps.webhookSecretCipher) {
        try {
          secret = deps.webhookSecretCipher.decrypt(workspaceId, endpoint.secretHash);
        } catch {
          // Legacy plaintext row not yet backfilled — use as-is.
          secret = endpoint.secretHash;
        }
      } else {
        secret = endpoint.secretHash;
      }

      const testPayload = {
        eventType: "test",
        data: {
          message: "This is a Mnemosyne webhook test event.",
          webhookId: id,
          workspaceId,
          timestamp: new Date().toISOString(),
        },
      };
      const body = JSON.stringify(testPayload);
      const sig = signWebhookPayload(secret, body);

      // An endpoint stored before the rule existed, or a name re-pointed since.
      await assertWebhookUrl(endpoint.url);

      let statusCode: number | null = null;
      let responseBody: string | null = null;
      let success = false;

      try {
        const res = await fetch(endpoint.url, {
          method: "POST",
          redirect: "manual",
          headers: injectTraceContext({
            "Content-Type": "application/json",
            ...buildSignatureHeaders(sig),
            "X-Mnemosyne-Event": "test",
          }),
          body,
          signal: AbortSignal.timeout(10_000),
        });
        statusCode = res.status;
        // Status only: the receiver's body is not logged (see cron/webhookDelivery.ts).
        await res.body?.cancel().catch(() => undefined);
        success = res.ok;
      } catch (err) {
        responseBody = err instanceof Error ? err.message : String(err);
      }

      // Log the test delivery
      try {
        await deps.storage.recordWebhookDelivery({
          id: randomUUID(),
          webhookId: id,
          workspaceId,
          eventType: "test",
          payload: testPayload.data,
          status: success ? "delivered" : "failed",
          responseStatus: statusCode ?? undefined,
          responseBody: responseBody ?? undefined,
          attempt: 1,
          deliveredAt: success ? new Date() : undefined,
        });
      } catch {
        // Non-fatal
      }

      await emitAudit(deps, {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "admin_access",
        resourceKind: "webhook_endpoint",
        resourceId: id,
        isTerminal: false,
        detail: { success, statusCode },
      });

      // The receiver's body is neither logged nor echoed here (APP-005: this
      // response was the read-back half of the SSRF).
      return c.json({ success, statusCode, responseBody: null, signature: sig }, 200);
    }
  );
}
