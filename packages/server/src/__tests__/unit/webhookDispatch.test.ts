import { describe, it, expect, vi } from "vitest";
import { dispatchWebhookEvent } from "../../webhookDispatch.js";

const WS = "11111111-1111-4111-8111-111111111111";

describe("dispatchWebhookEvent", () => {
  it("appends one webhook_fire per subscribed active endpoint", async () => {
    const appendOutbox = vi.fn().mockResolvedValue(undefined);
    const storage = {
      listWebhookEndpoints: vi.fn().mockResolvedValue([
        { id: "w1", url: "http://a", events: ["event.recorded"], isActive: true, secretHash: "s1" },
        { id: "w2", url: "http://b", events: ["other"], isActive: true, secretHash: "s2" },
        { id: "w3", url: "http://c", events: ["*"], isActive: true, secretHash: "s3" },
        {
          id: "w4",
          url: "http://d",
          events: ["event.recorded"],
          isActive: false,
          secretHash: "s4",
        },
      ]),
      appendOutbox,
    } as any;

    await dispatchWebhookEvent({ storage } as any, WS, "event.recorded", { x: 1 });

    // w1 (exact match, active) + w3 (* wildcard, active); w2 (wrong event) and w4 (inactive) skipped
    expect(appendOutbox).toHaveBeenCalledTimes(2);

    const ids = appendOutbox.mock.calls.map((c: any[]) => (c[0] as any).payload.webhookId).sort();
    expect(ids).toEqual(["w1", "w3"]);

    // Each entry must use the webhook_fire outbox event type
    expect((appendOutbox.mock.calls[0][0] as any).eventType).toBe("webhook_fire");

    // APP-030 (audit 2026-11-22): the signing secret is not copied into the
    // outbox. mnemo_outbox has no RLS and keeps rows until retention; the
    // delivery worker decrypts the secret from the endpoint row itself.
    const w1Call = appendOutbox.mock.calls.find(
      (c: any[]) => (c[0] as any).payload.webhookId === "w1"
    )![0];
    expect(w1Call.payload).not.toHaveProperty("secret");
    expect(w1Call.payload).not.toHaveProperty("secretHash");
  });

  it("is a no-op when storage is missing", async () => {
    await expect(
      dispatchWebhookEvent({} as any, "ws", "event.recorded", {})
    ).resolves.toBeUndefined();
  });

  it("skips non-UUID workspaces without querying the repository", async () => {
    const storage = {
      listWebhookEndpoints: vi.fn(),
      appendOutbox: vi.fn(),
    } as any;

    await expect(
      dispatchWebhookEvent({ storage } as any, "global", "health.alert", {})
    ).resolves.toBeUndefined();

    expect(storage.listWebhookEndpoints).not.toHaveBeenCalled();
    expect(storage.appendOutbox).not.toHaveBeenCalled();
  });

  it("logs and continues when listWebhookEndpoints throws", async () => {
    const storage = {
      listWebhookEndpoints: vi.fn().mockRejectedValue(new Error("db down")),
      appendOutbox: vi.fn(),
    } as any;

    // Should not throw
    await expect(
      dispatchWebhookEvent({ storage } as any, WS, "event.recorded", {})
    ).resolves.toBeUndefined();

    expect(storage.appendOutbox).not.toHaveBeenCalled();
  });

  it("logs and continues when appendOutbox throws for one endpoint", async () => {
    const appendOutbox = vi
      .fn()
      .mockRejectedValueOnce(new Error("outbox write failed"))
      .mockResolvedValueOnce(undefined);
    const storage = {
      listWebhookEndpoints: vi.fn().mockResolvedValue([
        { id: "w1", url: "http://a", events: ["*"], isActive: true, secretHash: "s1" },
        { id: "w2", url: "http://b", events: ["*"], isActive: true, secretHash: "s2" },
      ]),
      appendOutbox,
    } as any;

    // Should not throw even when first append fails
    await expect(
      dispatchWebhookEvent({ storage } as any, WS, "event.recorded", {})
    ).resolves.toBeUndefined();

    // Both endpoints were attempted; second succeeded
    expect(appendOutbox).toHaveBeenCalledTimes(2);
  });
});

// APP-006 (audit 2026-11-22): measured live, a webhook delivery carried the
// plaintext of a restricted fact (readable through GET /webhooks/:id/deliveries),
// and the outbox row held it in clear while the fact itself was encrypted at rest.
describe("dispatchWebhookEvent — text above internal does not leave", () => {
  const storageWith = (appendOutbox: ReturnType<typeof vi.fn>) =>
    ({
      listWebhookEndpoints: vi.fn().mockResolvedValue([
        { id: "w1", url: "https://a.example", events: ["*"], isActive: true, secretHash: "s1" },
      ]),
      appendOutbox,
    }) as any;

  it.each(["confidential", "restricted"])("a %s fact goes out as id and metadata only", async (tier) => {
    const appendOutbox = vi.fn().mockResolvedValue(undefined);
    await dispatchWebhookEvent({ storage: storageWith(appendOutbox) } as any, WS, "fact.created", {
      id: "f1",
      workspaceId: WS,
      statement: "RESTRICTED-CANARY board payroll is 4.1M",
      subject: "payroll",
      sensitivity: tier,
      tags: ["hr"],
    });
    const sent = appendOutbox.mock.calls[0]![0].payload.payload;
    expect(JSON.stringify(sent)).not.toContain("CANARY");
    expect(sent).toMatchObject({ id: "f1", workspaceId: WS, sensitivity: tier, redacted: true });
    expect(sent).not.toHaveProperty("statement");
  });

  it("an internal fact goes out whole", async () => {
    const appendOutbox = vi.fn().mockResolvedValue(undefined);
    await dispatchWebhookEvent({ storage: storageWith(appendOutbox) } as any, WS, "fact.created", {
      id: "f1",
      statement: "deploys are on tuesday",
      sensitivity: "internal",
    });
    expect(appendOutbox.mock.calls[0]![0].payload.payload.statement).toBe("deploys are on tuesday");
  });
});
