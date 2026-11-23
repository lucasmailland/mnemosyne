import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { runWebhookDeliveryBatch } from "../webhookDelivery.js";

// ─── Test A: runWebhookDeliveryBatch uses the spec ladder on failure ──────────

describe("runWebhookDeliveryBatch — spec ladder", () => {
  const webhookId = "wh-1";
  const workspaceId = "ws-1";
  let storage: InMemoryStorageAdapter;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    // Seed an active endpoint so the cron can find its URL and secret
    await storage.createWebhookEndpoint({
      id: webhookId,
      workspaceId,
      url: "https://example.com/webhook",
      events: ["test.event"],
      secretHash: "test-secret",
    });
  });

  it("advances attempt and sets nextAttemptAt ≈ now+300s on first failure", async () => {
    // Seed a pending delivery row (attempt=1, due now — nextAttemptAt is null)
    await storage.recordWebhookDelivery({
      id: "del-1",
      webhookId,
      workspaceId,
      eventType: "test.event",
      payload: { hello: "world" },
      status: "pending",
      attempt: 1,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const telemetry = {
      counter: vi.fn(),
      histogram: vi.fn(),
      startSpan: vi.fn(),
      gauge: vi.fn(),
      shutdown: vi.fn(),
    };

    const before = Date.now(); // determinism-ok: used only as lower bound with ±5s tolerance in assertions
    await runWebhookDeliveryBatch({ storage, logger, telemetry } as unknown as Parameters<
      typeof runWebhookDeliveryBatch
    >[0]);

    // After one failure, delivery row should have attempt=2 and nextAttemptAt ≈ now+300s
    const deliveries = await storage.listWebhookDeliveries(webhookId, workspaceId, 10);
    const row = deliveries[0];
    expect(row).toBeDefined();
    expect(row!.attempt).toBe(2);
    // Still pending — MAX_ATTEMPTS not reached yet
    expect(row!.status).toBe("pending");

    const expectedNextAttempt = before + 300_000;
    expect(row!.nextAttemptAt).not.toBeNull();
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(expectedNextAttempt - 5_000);
    expect(row!.nextAttemptAt!.getTime()).toBeLessThan(expectedNextAttempt + 5_000);

    vi.unstubAllGlobals();
  });

  it("marks delivery as failed (dead-letter) after MAX_ATTEMPTS failures", async () => {
    // Seed a delivery at attempt=5 (the last allowed attempt)
    await storage.recordWebhookDelivery({
      id: "del-max",
      webhookId,
      workspaceId,
      eventType: "test.event",
      payload: { hello: "world" },
      status: "pending",
      attempt: 5,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve("Service Unavailable"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const telemetry = {
      counter: vi.fn(),
      histogram: vi.fn(),
      startSpan: vi.fn(),
      gauge: vi.fn(),
      shutdown: vi.fn(),
    };

    await runWebhookDeliveryBatch({ storage, logger, telemetry } as unknown as Parameters<
      typeof runWebhookDeliveryBatch
    >[0]);

    const deliveries = await storage.listWebhookDeliveries(webhookId, workspaceId, 10);
    const row = deliveries[0];
    expect(row).toBeDefined();
    // Dead-lettered: status=failed
    expect(row!.status).toBe("failed");
    expect(row!.nextAttemptAt).toBeNull();

    vi.unstubAllGlobals();
  });

  it("marks delivery as delivered on HTTP 200", async () => {
    await storage.recordWebhookDelivery({
      id: "del-ok",
      webhookId,
      workspaceId,
      eventType: "test.event",
      payload: { hello: "world" },
      status: "pending",
      attempt: 1,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("ok"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const telemetry = {
      counter: vi.fn(),
      histogram: vi.fn(),
      startSpan: vi.fn(),
      gauge: vi.fn(),
      shutdown: vi.fn(),
    };

    await runWebhookDeliveryBatch({ storage, logger, telemetry } as unknown as Parameters<
      typeof runWebhookDeliveryBatch
    >[0]);

    const deliveries = await storage.listWebhookDeliveries(webhookId, workspaceId, 10);
    const row = deliveries[0];
    expect(row).toBeDefined();
    expect(row!.status).toBe("delivered");
    expect(row!.deliveredAt).not.toBeNull();
    expect(row!.nextAttemptAt).toBeNull();

    vi.unstubAllGlobals();
  });

  it("skips delivery and marks it failed if endpoint is inactive", async () => {
    // Disable the endpoint
    await storage.updateWebhookEndpoint(webhookId, workspaceId, { isActive: false });

    await storage.recordWebhookDelivery({
      id: "del-disabled",
      webhookId,
      workspaceId,
      eventType: "test.event",
      payload: {},
      status: "pending",
      attempt: 1,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const telemetry = {
      counter: vi.fn(),
      histogram: vi.fn(),
      startSpan: vi.fn(),
      gauge: vi.fn(),
      shutdown: vi.fn(),
    };

    await runWebhookDeliveryBatch({ storage, logger, telemetry } as unknown as Parameters<
      typeof runWebhookDeliveryBatch
    >[0]);

    // fetch should NOT be called for a disabled endpoint
    expect(fetchMock).not.toHaveBeenCalled();

    const deliveries = await storage.listWebhookDeliveries(webhookId, workspaceId, 10);
    const row = deliveries[0];
    expect(row!.status).toBe("failed");

    vi.unstubAllGlobals();
  });
});

// ─── Test D: F12 cipher — HMAC uses decrypted secret, not ciphertext ─────────

describe("runWebhookDeliveryBatch — F12 webhookSecretCipher", () => {
  const webhookId = "wh-cipher";
  const workspaceId = "ws-cipher";
  const PLAIN_SECRET = "decrypted-signing-secret";
  const ENCRYPTED_BLOB = "enc::" + PLAIN_SECRET; // fake ciphertext

  it("HMAC is computed from the DECRYPTED secret when webhookSecretCipher is provided", async () => {
    const storage = new InMemoryStorageAdapter();
    // Endpoint stores an ENCRYPTED secretHash (as it would in production)
    await storage.createWebhookEndpoint({
      id: webhookId,
      workspaceId,
      url: "https://example.com/webhook",
      events: ["fact.created"],
      secretHash: ENCRYPTED_BLOB,
    });

    await storage.recordWebhookDelivery({
      id: "del-cipher",
      webhookId,
      workspaceId,
      eventType: "fact.created",
      payload: { factId: "f-cipher" },
      status: "pending",
      attempt: 1,
    });

    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>)
      );
      capturedBody = init.body as string;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("ok"),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const telemetry = {
      counter: vi.fn(),
      histogram: vi.fn(),
      startSpan: vi.fn(),
      gauge: vi.fn(),
      shutdown: vi.fn(),
    };

    const decryptMock = vi.fn().mockReturnValue(PLAIN_SECRET);
    const webhookSecretCipher = { decrypt: decryptMock };

    await runWebhookDeliveryBatch({
      storage,
      logger,
      telemetry,
      webhookSecretCipher,
    } as unknown as Parameters<typeof runWebhookDeliveryBatch>[0]);

    // The cipher must have been called with the encrypted blob
    expect(decryptMock).toHaveBeenCalledWith(workspaceId, ENCRYPTED_BLOB);

    // Extract the signature header
    const sigHeader = capturedHeaders["Mnemosyne-Signature"];
    expect(sigHeader).toBeDefined();
    expect(sigHeader).toMatch(/^t=\d+,v1=[0-9a-f]+$/);

    // Recompute HMAC with the PLAIN_SECRET using the same timestamp
    const { createHmac } = await import("node:crypto");
    const tPart = sigHeader.split(",").find((p: string) => p.startsWith("t="));
    const ts = parseInt(tPart!.slice(2), 10);
    const expectedSig = `t=${ts},v1=${createHmac("sha256", PLAIN_SECRET).update(`${ts}.${capturedBody}`, "utf8").digest("hex")}`;
    const ciphertextSig = `t=${ts},v1=${createHmac("sha256", ENCRYPTED_BLOB).update(`${ts}.${capturedBody}`, "utf8").digest("hex")}`;

    expect(sigHeader).toBe(expectedSig);
    expect(sigHeader).not.toBe(ciphertextSig);

    vi.unstubAllGlobals();
  });

  it("falls back to secretHash when cipher.decrypt throws (legacy plaintext row)", async () => {
    const storage = new InMemoryStorageAdapter();
    const LEGACY_SECRET = "legacy-plaintext-secret";
    await storage.createWebhookEndpoint({
      id: webhookId + "-legacy",
      workspaceId,
      url: "https://example.com/webhook",
      events: ["fact.created"],
      secretHash: LEGACY_SECRET,
    });

    await storage.recordWebhookDelivery({
      id: "del-legacy",
      webhookId: webhookId + "-legacy",
      workspaceId,
      eventType: "fact.created",
      payload: { factId: "f-legacy" },
      status: "pending",
      attempt: 1,
    });

    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const fetchMock2 = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>)
      );
      capturedBody = init.body as string;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("ok"),
      });
    });
    vi.stubGlobal("fetch", fetchMock2);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const telemetry = {
      counter: vi.fn(),
      histogram: vi.fn(),
      startSpan: vi.fn(),
      gauge: vi.fn(),
      shutdown: vi.fn(),
    };

    // cipher.decrypt always throws (simulates legacy row)
    const webhookSecretCipher = {
      decrypt: vi.fn().mockImplementation(() => {
        throw new Error("not encrypted");
      }),
    };

    await runWebhookDeliveryBatch({
      storage,
      logger,
      telemetry,
      webhookSecretCipher,
    } as unknown as Parameters<typeof runWebhookDeliveryBatch>[0]);

    // Fetch must have been called (not short-circuited)
    expect(fetchMock2).toHaveBeenCalledOnce();

    const { createHmac } = await import("node:crypto");
    const sigHeader = capturedHeaders["Mnemosyne-Signature"];
    const tPart = sigHeader.split(",").find((p: string) => p.startsWith("t="));
    const ts = parseInt(tPart!.slice(2), 10);
    const expectedSig = `t=${ts},v1=${createHmac("sha256", LEGACY_SECRET).update(`${ts}.${capturedBody}`, "utf8").digest("hex")}`;

    // Signature was computed with the raw secretHash (fallback path)
    expect(sigHeader).toBe(expectedSig);

    vi.unstubAllGlobals();
  });
});

// ─── Test C: Dual signature headers (Mnemosyne-Signature + legacy alias) ─────

describe("runWebhookDeliveryBatch — dual signature headers (Task 6.5)", () => {
  const webhookId = "wh-sig";
  const workspaceId = "ws-sig";
  let storage: InMemoryStorageAdapter;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    await storage.createWebhookEndpoint({
      id: webhookId,
      workspaceId,
      url: "https://example.com/webhook",
      events: ["fact.created"],
      secretHash: "test-secret",
    });
  });

  it("sends both Mnemosyne-Signature (spec) and X-Mnemosyne-Signature (legacy) headers with equal values", async () => {
    await storage.recordWebhookDelivery({
      id: "del-sig",
      webhookId,
      workspaceId,
      eventType: "fact.created",
      payload: { factId: "f-1" },
      status: "pending",
      attempt: 1,
    });

    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>)
      );
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("ok"),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const telemetry = {
      counter: vi.fn(),
      histogram: vi.fn(),
      startSpan: vi.fn(),
      gauge: vi.fn(),
      shutdown: vi.fn(),
    };

    await runWebhookDeliveryBatch({ storage, logger, telemetry } as unknown as Parameters<
      typeof runWebhookDeliveryBatch
    >[0]);

    // Spec header must be present
    expect(capturedHeaders["Mnemosyne-Signature"]).toBeDefined();
    expect(capturedHeaders["Mnemosyne-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]+$/);

    // Legacy alias must be present and carry the same value
    expect(capturedHeaders["X-Mnemosyne-Signature"]).toBeDefined();
    expect(capturedHeaders["X-Mnemosyne-Signature"]).toBe(capturedHeaders["Mnemosyne-Signature"]);

    vi.unstubAllGlobals();
  });
});

// ─── Test B: OutboxWorker webhook_fire enqueues a pending delivery row ────────

describe("OutboxWorker webhook_fire — enqueue pending delivery (RDD-8)", () => {
  it("records a pending delivery row instead of delivering inline", async () => {
    const { OutboxWorker } = await import("@mnemo-ai/adapter-postgres");
    const storage = new InMemoryStorageAdapter();

    // No endpoint needs to be seeded — OutboxWorker just inserts the delivery row
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };

    // Build a minimal OutboxEntry for webhook_fire
    const entry = {
      id: "outbox-1",
      workspaceId: "ws-1",
      eventType: "webhook_fire" as const,
      payload: {
        webhookId: "wh-outbox",
        workspaceId: "ws-1",
        eventType: "fact.created",
        payload: { factId: "f-1" },
        // Legacy fields that the old handler used — the new handler MUST NOT use them
        url: "https://example.com/should-not-be-called",
        secret: "should-not-be-used",
      },
      attempts: 0,
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    };

    const worker = new OutboxWorker(
      storage,
      {} as never, // vector
      {} as never, // cache
      {} as never, // queue
      logger,
      {} // config
    );

    // Call the internal process method directly
    // @ts-expect-error — accessing private for test
    await worker.process(entry);

    // fetch must NOT have been called (delivery is deferred)
    expect(fetchMock).not.toHaveBeenCalled();

    // A pending delivery row must exist
    const deliveries = await storage.listWebhookDeliveries("wh-outbox", "ws-1", 10);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe("pending");
    expect(deliveries[0]!.attempt).toBe(1);
    expect(deliveries[0]!.webhookId).toBe("wh-outbox");
    expect(deliveries[0]!.eventType).toBe("fact.created");

    vi.unstubAllGlobals();
  });
});
