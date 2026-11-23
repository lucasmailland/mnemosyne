import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthVariables } from "../../auth.js";
import { mountWebhooks } from "../../routes/webhooks.js";
import { toErrorBody } from "../../errors.js";
import { signWebhookPayload } from "../../webhookSigner.js";
import type { ServerDeps } from "../../deps.js";

const WS = "ws-test-route";
const ENDPOINT_ID = "ep-test-1";
const KNOWN_SECRET = "the-decrypted-signing-secret";
const ENCRYPTED_BLOB = "enc::" + KNOWN_SECRET; // fake ciphertext

function makeApp(deps: Partial<ServerDeps>) {
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
  // mountWebhooks takes the /v1-prefixed app; we mount without prefix so the
  // route path is exactly /webhooks/:id/test in this mini-app.
  mountWebhooks(app as never, deps as ServerDeps);
  return app;
}

describe("POST /webhooks/:id/test — cipher present", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let recordWebhookDelivery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("ok"),
    });
    vi.stubGlobal("fetch", fetchMock);
    recordWebhookDelivery = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns { success, statusCode, signature } and calls recordWebhookDelivery", async () => {
    const storage = {
      getWebhookEndpoint: vi.fn().mockResolvedValue({
        id: ENDPOINT_ID,
        workspaceId: WS,
        url: "https://example.com/hook",
        events: ["*"],
        isActive: true,
        secretHash: ENCRYPTED_BLOB,
        description: null,
        createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        failureCount: 0,
        disabledAt: null,
      }),
      recordWebhookDelivery,
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    };

    const webhookSecretCipher = {
      decrypt: vi.fn().mockReturnValue(KNOWN_SECRET),
      encrypt: vi.fn(),
    };

    const app = makeApp({ storage: storage as never, webhookSecretCipher });

    const res = await app.request(`/webhooks/${ENDPOINT_ID}/test`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      statusCode: number | null;
      responseBody: string | null;
      signature: string;
    };

    // Shape check
    expect(typeof body.success).toBe("boolean");
    expect(body.success).toBe(true);
    expect(body.statusCode).toBe(200);
    expect(typeof body.signature).toBe("string");

    // Signature must match what we'd compute with the DECRYPTED secret, not the ciphertext
    // We extract the timestamp from the returned signature so we can recompute.
    const tPart = body.signature.split(",").find((p: string) => p.startsWith("t="));
    expect(tPart).toBeDefined();
    const ts = parseInt(tPart!.slice(2), 10);

    // Reconstruct the body the route would have used
    const capturedFetchCall = fetchMock.mock.calls[0];
    const sentBody = capturedFetchCall[1].body as string;

    const expectedSig = signWebhookPayload(KNOWN_SECRET, sentBody, ts);
    expect(body.signature).toBe(expectedSig);

    // The cipher must have been called with the encrypted blob
    expect(webhookSecretCipher.decrypt).toHaveBeenCalledWith(WS, ENCRYPTED_BLOB);

    // recordWebhookDelivery must have been called
    expect(recordWebhookDelivery).toHaveBeenCalledOnce();
    const deliveryArg = recordWebhookDelivery.mock.calls[0][0];
    expect(deliveryArg.webhookId).toBe(ENDPOINT_ID);
    expect(deliveryArg.workspaceId).toBe(WS);
    expect(deliveryArg.eventType).toBe("test");
    expect(deliveryArg.status).toBe("delivered");
  });

  it("returns success=false and still calls recordWebhookDelivery when remote returns 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("Service Unavailable"),
      })
    );

    const storage = {
      getWebhookEndpoint: vi.fn().mockResolvedValue({
        id: ENDPOINT_ID,
        workspaceId: WS,
        url: "https://example.com/hook",
        events: ["*"],
        isActive: true,
        secretHash: ENCRYPTED_BLOB,
        description: null,
        createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        failureCount: 0,
        disabledAt: null,
      }),
      recordWebhookDelivery,
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    };

    const webhookSecretCipher = {
      decrypt: vi.fn().mockReturnValue(KNOWN_SECRET),
      encrypt: vi.fn(),
    };

    const app = makeApp({ storage: storage as never, webhookSecretCipher });

    const res = await app.request(`/webhooks/${ENDPOINT_ID}/test`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; statusCode: number | null };
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(503);

    expect(recordWebhookDelivery).toHaveBeenCalledOnce();
    const deliveryArg = recordWebhookDelivery.mock.calls[0][0];
    expect(deliveryArg.status).toBe("failed");
  });

  it("returns 404 when endpoint does not exist", async () => {
    const storage = {
      getWebhookEndpoint: vi.fn().mockResolvedValue(null),
      recordWebhookDelivery,
    };

    const app = makeApp({ storage: storage as never });

    const res = await app.request(`/webhooks/no-such-id/test`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("uses decrypted secret (not ciphertext) for HMAC — cross-check against raw plaintext", async () => {
    // This test proves the cipher path is used: signing with the ciphertext
    // would produce a DIFFERENT signature than signing with KNOWN_SECRET.
    const storage = {
      getWebhookEndpoint: vi.fn().mockResolvedValue({
        id: ENDPOINT_ID,
        workspaceId: WS,
        url: "https://example.com/hook",
        events: ["*"],
        isActive: true,
        secretHash: ENCRYPTED_BLOB,
        description: null,
        createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        failureCount: 0,
        disabledAt: null,
      }),
      recordWebhookDelivery,
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    };

    const webhookSecretCipher = {
      decrypt: vi.fn().mockReturnValue(KNOWN_SECRET),
      encrypt: vi.fn(),
    };

    const app = makeApp({ storage: storage as never, webhookSecretCipher });
    const res = await app.request(`/webhooks/${ENDPOINT_ID}/test`, { method: "POST" });
    const body = (await res.json()) as { signature: string };

    // The signature must NOT be computable with the ciphertext blob
    const tPart = body.signature.split(",").find((p: string) => p.startsWith("t="));
    const ts = parseInt(tPart!.slice(2), 10);
    const sentBody = (fetchMock.mock.calls[0][1] as RequestInit).body as string;

    const sigWithCiphertext = signWebhookPayload(ENCRYPTED_BLOB, sentBody, ts);
    const sigWithDecrypted = signWebhookPayload(KNOWN_SECRET, sentBody, ts);

    // The returned sig must equal the decrypted-secret sig, not the ciphertext sig
    expect(body.signature).toBe(sigWithDecrypted);
    expect(body.signature).not.toBe(sigWithCiphertext);
  });
});

describe("POST /webhooks/:id/test — no cipher (dev mode)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses secretHash directly as signing secret when cipher is absent", async () => {
    const PLAIN_SECRET = "plain-secret-no-encryption";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("ok"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const recordWebhookDelivery = vi.fn().mockResolvedValue(undefined);

    const storage = {
      getWebhookEndpoint: vi.fn().mockResolvedValue({
        id: ENDPOINT_ID,
        workspaceId: WS,
        url: "https://example.com/hook",
        events: ["*"],
        isActive: true,
        secretHash: PLAIN_SECRET,
        description: null,
        createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        failureCount: 0,
        disabledAt: null,
      }),
      recordWebhookDelivery,
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    };

    // No webhookSecretCipher in deps
    const app = makeApp({ storage: storage as never });
    const res = await app.request(`/webhooks/${ENDPOINT_ID}/test`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signature: string };

    const tPart = body.signature.split(",").find((p: string) => p.startsWith("t="));
    const ts = parseInt(tPart!.slice(2), 10);
    const sentBody = (fetchMock.mock.calls[0][1] as RequestInit).body as string;

    expect(body.signature).toBe(signWebhookPayload(PLAIN_SECRET, sentBody, ts));
    expect(recordWebhookDelivery).toHaveBeenCalledOnce();
  });
});
