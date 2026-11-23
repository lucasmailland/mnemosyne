/**
 * APP-005 (audit 2026-11-22): the webhook routes and the delivery worker refuse
 * internal targets, do not follow redirects, and POST /webhooks/:id/test no
 * longer hands the receiver's response body back to the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountWebhooks } from "../../routes/webhooks.js";
import { runWebhookDeliveryBatch } from "../../cron/webhookDelivery.js";

const WS = "ws-ssrf";

function makeApp(storage: Record<string, unknown>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("actorId", "actor-1");
    await next();
  });
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status);
  });
  mountWebhooks(app as never, { storage } as unknown as ServerDeps);
  return app;
}

const endpoint = (url: string) => ({
  id: "ep-1",
  workspaceId: WS,
  url,
  events: ["*"],
  isActive: true,
  secretHash: "secret",
  description: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  failureCount: 0,
  disabledAt: null,
});

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("internal secret") });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("registering a webhook", () => {
  it.each([
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1:5432/",
    "https://localhost/x",
    "http://ollama:11434/api/tags",
  ])("refuses %s with 400 invalid_webhook_url and stores nothing", async (url) => {
    const createWebhookEndpoint = vi.fn();
    const app = makeApp({ createWebhookEndpoint, appendAuditEntry: vi.fn() });
    const res = await app.request("/webhooks", json({ url, events: ["fact.created"] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_webhook_url");
    expect(createWebhookEndpoint).not.toHaveBeenCalled();
  });

  it("refuses moving an existing endpoint to an internal target", async () => {
    const updateWebhookEndpoint = vi.fn();
    const app = makeApp({
      getWebhookEndpoint: vi.fn().mockResolvedValue(endpoint("https://hooks.example.com/x")),
      updateWebhookEndpoint,
      appendAuditEntry: vi.fn(),
    });
    const res = await app.request("/webhooks/ep-1", {
      ...json({ url: "https://10.0.0.7/hook" }),
      method: "PATCH",
    });
    expect(res.status).toBe(400);
    expect(updateWebhookEndpoint).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/:id/test", () => {
  it("does not send to an endpoint that points inside, even one stored before the rule", async () => {
    const app = makeApp({
      getWebhookEndpoint: vi.fn().mockResolvedValue(endpoint("https://127.0.0.1/x")),
      recordWebhookDelivery: vi.fn(),
      appendAuditEntry: vi.fn(),
    });
    const res = await app.request("/webhooks/ep-1/test", { method: "POST" });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow redirects and does not return the receiver's body", async () => {
    const app = makeApp({
      getWebhookEndpoint: vi.fn().mockResolvedValue(endpoint("https://203.0.113.10/hook")),
      recordWebhookDelivery: vi.fn().mockResolvedValue(undefined),
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    });
    const res = await app.request("/webhooks/ep-1/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as { redirect?: string }).redirect).toBe("manual");
    const body = (await res.json()) as { success: boolean; statusCode: number; responseBody: unknown };
    expect(body).toMatchObject({ success: true, statusCode: 200, responseBody: null });
    expect(JSON.stringify(body)).not.toContain("internal secret");
  });
});

describe("the delivery worker", () => {
  const telemetry = { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const delivery = { id: "d-1", webhookId: "ep-1", workspaceId: WS, eventType: "fact.created", payload: {}, attempt: 1 };

  it("fails a delivery to an internal target without making the request", async () => {
    const updateWebhookDelivery = vi.fn().mockResolvedValue(undefined);
    const storage = {
      listPendingWebhookDeliveries: vi.fn().mockResolvedValue([delivery]),
      getWebhookEndpoint: vi.fn().mockResolvedValue(endpoint("https://172.18.0.4/api/tags")),
      updateWebhookDelivery,
      updateWebhookEndpoint: vi.fn().mockResolvedValue(undefined),
    };
    await runWebhookDeliveryBatch({ storage, logger, telemetry } as unknown as Parameters<typeof runWebhookDeliveryBatch>[0]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateWebhookDelivery).toHaveBeenCalledWith(
      "d-1",
      WS,
      expect.objectContaining({ status: "failed", responseBody: expect.stringContaining("private_address") })
    );
  });

  it("sends an allowed delivery without following redirects", async () => {
    const storage = {
      listPendingWebhookDeliveries: vi.fn().mockResolvedValue([delivery]),
      getWebhookEndpoint: vi.fn().mockResolvedValue(endpoint("https://203.0.113.10/hook")),
      updateWebhookDelivery: vi.fn().mockResolvedValue(undefined),
      updateWebhookEndpoint: vi.fn().mockResolvedValue(undefined),
    };
    await runWebhookDeliveryBatch({ storage, logger, telemetry } as unknown as Parameters<typeof runWebhookDeliveryBatch>[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as { redirect?: string }).redirect).toBe("manual");
  });
});

// Re-audit 2026-11-22: the worker checks the name, then fetch() resolves it
// again, so a rebinding resolver could still aim a delivery inside; the first
// 2,000 characters of whatever answered were stored and served by
// GET /webhooks/:id/deliveries to any read key. What a receiver answers is no
// longer kept: only its status code.
describe("the receiver's answer is not kept", () => {
  const telemetry = { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const delivery = { id: "d-1", webhookId: "ep-1", workspaceId: WS, eventType: "fact.created", payload: {}, attempt: 1 };

  it.each([
    [200, true],
    [500, false],
  ])("the worker stores status %i and not the body", async (status, ok) => {
    fetchMock.mockResolvedValue({ ok, status, text: () => Promise.resolve("internal secret") });
    const updateWebhookDelivery = vi.fn().mockResolvedValue(undefined);
    const storage = {
      listPendingWebhookDeliveries: vi.fn().mockResolvedValue([delivery]),
      getWebhookEndpoint: vi.fn().mockResolvedValue(endpoint("https://203.0.113.10/hook")),
      updateWebhookDelivery,
      updateWebhookEndpoint: vi.fn().mockResolvedValue(undefined),
    };
    await runWebhookDeliveryBatch({ storage, logger, telemetry } as unknown as Parameters<typeof runWebhookDeliveryBatch>[0]);
    expect(updateWebhookDelivery).toHaveBeenCalledWith("d-1", WS, expect.objectContaining({ responseStatus: status }));
    expect(JSON.stringify(updateWebhookDelivery.mock.calls)).not.toContain("internal secret");
  });

  it("POST /webhooks/:id/test does not log the body either", async () => {
    const recordWebhookDelivery = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      getWebhookEndpoint: vi.fn().mockResolvedValue(endpoint("https://203.0.113.10/hook")),
      recordWebhookDelivery,
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    });
    expect((await app.request("/webhooks/ep-1/test", { method: "POST" })).status).toBe(200);
    expect(recordWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({ responseStatus: 200 }));
    expect(JSON.stringify(recordWebhookDelivery.mock.calls)).not.toContain("internal secret");
  });

  it("GET /webhooks/:id/deliveries serves no body a receiver wrote, even on rows stored before", async () => {
    const row = (id: string, responseStatus: number | undefined, responseBody: string) => ({
      id,
      webhookId: "ep-1",
      workspaceId: WS,
      eventType: "fact.created",
      payload: {},
      status: "failed",
      responseStatus,
      responseBody,
      attempt: 1,
      deliveredAt: null,
      createdAt: new Date(0),
    });
    const app = makeApp({
      getWebhookEndpoint: vi.fn().mockResolvedValue(endpoint("https://203.0.113.10/hook")),
      listWebhookDeliveries: vi
        .fn()
        .mockResolvedValue([row("d-old", 200, "internal secret"), row("d-refused", undefined, "refused: private_address")]),
    });
    const res = await app.request("/webhooks/ep-1/deliveries");
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Array<{ id: string; responseBody: string | null }> };
    expect(items.find((i) => i.id === "d-old")!.responseBody).toBeNull();
    // the server's own diagnostic, written when no receiver answered, stays
    expect(items.find((i) => i.id === "d-refused")!.responseBody).toBe("refused: private_address");
  });
});
