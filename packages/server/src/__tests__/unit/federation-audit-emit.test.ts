/**
 * Unit tests for p50-audit-log-emitters PR4 — federation.ts audit emission.
 *
 * Covers tasks 4.1/4.2: POST /memory/federation/sync emits a `federation_sync`
 * AuditLogEntry SYNCHRONOUSLY at accept time — right after `jobStore.create`,
 * before the 202 response — never from inside the `setImmediate` fire-and-
 * forget block (design D7: no request context is available in there, so
 * `resolveProvenance(c)` cannot run inside it).
 *
 * Pattern: mirrors federation-since.test.ts's mTLS + service-JWT peer-gate
 * fixture, plus keys-audit-emit.test.ts's `deps.storage.appendAuditEntry` spy.
 *
 * Note: fake timers are intentionally NOT used and setImmediate is never
 * flushed in these tests — this is deliberate. If the emitter were
 * (incorrectly) placed inside the `setImmediate` block, `appendAuditEntry`
 * would NOT have been called by the time `app.request(...)` resolves, since
 * that block never runs during the test. This is the direct proof of D7.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { AuditLogEntry } from "@mnemo-ai/types";
import { mountFederation } from "../../routes/federation.js";
import { toErrorBody } from "../../errors.js";
import { signServiceJwt, InMemoryJtiStore } from "@mnemo-ai/core";

// ── Crypto fixtures ─────────────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pinnedDer = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
const AUD = "mnemo:instance:self";
const WORKSPACE = "ws_fed_audit_test";
const USER_ID = "user-p50-federation-001";
const RAW_ACTOR_ID = "key-p50-federation-001";

// ── Auth + federation deps fixtures ─────────────────────────────────────────────

function makeFedDeps() {
  const token = signServiceJwt(privateKey, {
    iss: "peer-a",
    aud: AUD,
    workspaceScope: [WORKSPACE],
  });

  const peerStore = {
    async get(id: string) {
      return id === "peer-a"
        ? {
            peerId: "peer-a",
            pinnedCertDer: pinnedDer,
            trustWeight: 1,
            approvedAt: "2026-01-01T00:00:00.000Z",
            enabled: true,
          }
        : null;
    },
    async list() {
      return [];
    },
  };

  const jtiStore = new InMemoryJtiStore();

  return {
    peerStore,
    jtiStore,
    selfAudience: AUD,
    token,
    mtls: {
      processAnnounce: vi.fn(),
      approveKeyRotation: vi.fn(),
    },
    jobStore: {
      create: vi.fn(),
      update: vi.fn(),
      get: vi.fn(),
    },
    syncEngine: null,
    serveCrypto: undefined,
    // These requests carry x-mnemo-tls-protocol as a TLS proxy would set it.
    transport: { trustProxyHeaders: true },
  };
}

function withFedAuth(app: OpenAPIHono<{ Variables: AuthVariables }>, keyPrefix: string): void {
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE);
    c.set("apiKeyPrefix", keyPrefix);
    // P55: /peers/:id/approve and /peers/:id/approve-key now require
    // federation:admin (inline requireScopes() defence-in-depth). This
    // harness tests audit emission, not authz — grant the scope so these
    // pre-existing cases keep exercising the audit path unmodified.
    c.set("scopes", ["federation:admin"]);
    c.set("userId", USER_ID);
    c.set("actorId", RAW_ACTOR_ID);
    c.set("actorType", "federation");
    await next();
  });
}

function makeFedRequest(
  fedDeps: ReturnType<typeof makeFedDeps>,
  path: string,
  body: Record<string, unknown>,
  headerOverrides: Record<string, string | undefined> = {}
): Request {
  const url = `http://localhost${path}`;
  const headers: Record<string, string> = {
    "x-mnemo-service-jwt": fedDeps.token,
    "x-mnemo-peer-id": "peer-a",
    "x-mnemo-client-cert": Buffer.from(pinnedDer).toString("base64url"),
    "x-mnemo-tls-protocol": "TLSv1.3",
    "content-type": "application/json",
  };
  for (const [k, v] of Object.entries(headerOverrides)) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeSimpleRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function certFingerprint(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}

// A peer's requests carry its mk_fed_ key; POST /sync is a local action, so its
// tests pass a local key prefix.
function makeApp(keyPrefix = "mk_fed_") {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err, undefined);
    return c.json(body, status as 400 | 403 | 404 | 500);
  });
  withFedAuth(app, keyPrefix);

  const fedDeps = makeFedDeps();
  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);

  const deps = {
    core: {},
    federation: fedDeps,
    storage: { appendAuditEntry } as unknown as ServerDeps["storage"],
    telemetry: {
      startSpan: () => ({
        setAttribute() {},
        setStatus() {},
        end() {},
      }),
    },
  } as unknown as ServerDeps;

  mountFederation(app, deps);

  return { app, fedDeps, appendAuditEntry };
}

function firstEntry(spy: ReturnType<typeof vi.fn>): Omit<AuditLogEntry, "id" | "createdAt"> {
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0]![0] as Omit<AuditLogEntry, "id" | "createdAt">;
}

describe("POST /memory/federation/sync — federation_sync audit emission", () => {
  it("emits federation_sync SYNCHRONOUSLY (before setImmediate runs), partitioned on the caller's workspace", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp("mk_live_");

    const res = await app.request(
      makeFedRequest(fedDeps, "/memory/federation/sync", {
        peerId: "peer-a",
        conflictResolution: "theirs_wins",
      })
    );

    expect(res.status).toBe(202);
    const bodyJson = (await res.json()) as { jobId: string; status: string };

    // The critical D7 assertion: appendAuditEntry was already called by the
    // time the response resolved — setImmediate's callback never ran in this
    // test (no fake timers, no flush), so this can ONLY pass if the emitter
    // runs synchronously in the request handler, not inside the deferred block.
    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("federation_sync");
    expect(entry.resourceKind).toBe("federation_sync");
    expect(entry.resourceId).toBe(bodyJson.jobId);
    expect(entry.isTerminal).toBe(false);
    expect(entry.workspaceId).toBe(WORKSPACE);
    expect(entry.actorType).toBe("federation");
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(entry.detail).toMatchObject({
      userId: USER_ID,
      peerId: "peer-a",
      conflictResolution: "theirs_wins",
      phase: "accepted",
    });
  });

  it("does NOT emit federation_sync when peerId is missing (400 bad_request)", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp("mk_live_");

    const res = await app.request(makeFedRequest(fedDeps, "/memory/federation/sync", {}));

    expect(res.status).toBe(400);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("still returns 202 when appendAuditEntry rejects (swallow-and-log)", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp("mk_live_");
    appendAuditEntry.mockRejectedValueOnce(new Error("merkle lock failed"));

    const res = await app.request(
      makeFedRequest(fedDeps, "/memory/federation/sync", { peerId: "peer-a" })
    );

    expect(res.status).toBe(202);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
  });

  it("refuses a peer's mk_fed_ key: a peer cannot make this server pull (403, no audit)", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp("mk_fed_");

    const res = await app.request(
      makeFedRequest(fedDeps, "/memory/federation/sync", { peerId: "peer-a" })
    );

    expect(res.status).toBe(403);
    expect(appendAuditEntry).not.toHaveBeenCalled();
    expect(fedDeps.jobStore.create).not.toHaveBeenCalled();
  });
});

// ─── P54 — federation_cert_rotated on /approve and /approve-key ───────────────

describe("POST /memory/federation/peers/:id/approve — federation_cert_rotated audit emission", () => {
  it("[4.1] emits federation_cert_rotated with method=operator_approved and both fingerprints when accepted", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp();
    const newCertDer = new Uint8Array([9, 9, 9, 9]);
    fedDeps.mtls.processAnnounce.mockResolvedValueOnce({
      accepted: true,
      reason: "operator_approved",
    });

    const res = await app.request(
      makeSimpleRequest("/memory/federation/peers/peer-a/approve", {
        newCertDer: Buffer.from(newCertDer).toString("base64"),
      })
    );

    expect(res.status).toBe(200);
    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("federation_cert_rotated");
    expect(entry.resourceKind).toBe("federation_peer");
    expect(entry.resourceId).toBe("peer-a");
    expect(entry.isTerminal).toBe(false);
    expect(entry.workspaceId).toBe(WORKSPACE);
    expect(entry.actorType).toBe("federation");
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);

    const detail = entry.detail as Record<string, unknown>;
    expect(detail["method"]).toBe("operator_approved");
    expect(detail["peerId"]).toBe("peer-a");
    expect(detail["userId"]).toBe(USER_ID);

    const oldFp = detail["oldCertFingerprint"] as string;
    const newFp = detail["newCertFingerprint"] as string;
    expect(oldFp).toMatch(/^[0-9a-f]{64}$/);
    expect(newFp).toMatch(/^[0-9a-f]{64}$/);
    expect(oldFp).toBe(certFingerprint(pinnedDer));
    expect(newFp).toBe(certFingerprint(newCertDer));
    expect(oldFp).not.toBe(newFp);
  });

  it("[4.3] does NOT emit when processAnnounce rejects the announce (422)", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp();
    fedDeps.mtls.processAnnounce.mockResolvedValueOnce({
      accepted: false,
      reason: "invalid_cross_signature",
    });

    const res = await app.request(
      makeSimpleRequest("/memory/federation/peers/peer-a/approve", {
        newCertDer: Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"),
      })
    );

    expect(res.status).toBe(422);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("[4.5] does NOT emit when newCertDer is missing (400 bad_request)", async () => {
    const { app, appendAuditEntry } = makeApp();

    const res = await app.request(makeSimpleRequest("/memory/federation/peers/peer-a/approve", {}));

    expect(res.status).toBe(400);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("[4.7a] omits oldCertFingerprint entirely (not null) on brand-new peer enrollment", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp();
    fedDeps.mtls.processAnnounce.mockResolvedValueOnce({
      accepted: true,
      reason: "operator_approved",
    });

    const res = await app.request(
      makeSimpleRequest("/memory/federation/peers/peer-new/approve", {
        newCertDer: Buffer.from(new Uint8Array([5, 5, 5])).toString("base64"),
      })
    );

    expect(res.status).toBe(200);
    const entry = firstEntry(appendAuditEntry);
    const detail = entry.detail as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(detail, "oldCertFingerprint")).toBe(false);
    expect(detail["newCertFingerprint"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[4.7b] still emits with equal fingerprints on a byte-identical no-op rotation", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp();
    fedDeps.mtls.processAnnounce.mockResolvedValueOnce({
      accepted: true,
      reason: "operator_approved",
    });

    const res = await app.request(
      makeSimpleRequest("/memory/federation/peers/peer-a/approve", {
        newCertDer: Buffer.from(pinnedDer).toString("base64"),
      })
    );

    expect(res.status).toBe(200);
    const entry = firstEntry(appendAuditEntry);
    const detail = entry.detail as Record<string, unknown>;
    expect(detail["oldCertFingerprint"]).toBe(detail["newCertFingerprint"]);
  });

  it("[4.6] reads peerStore.get eagerly, before processAnnounce mutates the pin (D2/D4 ordering)", async () => {
    const { app, fedDeps } = makeApp();
    const callOrder: string[] = [];
    vi.spyOn(fedDeps.peerStore, "get").mockImplementation(async (id: string) => {
      callOrder.push("peerStore.get");
      return id === "peer-a"
        ? {
            peerId: "peer-a",
            pinnedCertDer: pinnedDer,
            trustWeight: 1,
            approvedAt: "2026-01-01T00:00:00.000Z",
            enabled: true,
          }
        : null;
    });
    fedDeps.mtls.processAnnounce.mockImplementationOnce(async () => {
      callOrder.push("processAnnounce");
      return { accepted: true, reason: "operator_approved" };
    });

    await app.request(
      makeSimpleRequest("/memory/federation/peers/peer-a/approve", {
        newCertDer: Buffer.from(new Uint8Array([7, 7, 7])).toString("base64"),
      })
    );

    expect(callOrder[0]).toBe("peerStore.get");
    expect(callOrder.indexOf("peerStore.get")).toBeLessThan(callOrder.indexOf("processAnnounce"));
  });
});

describe("POST /memory/federation/peers/:id/approve-key — federation_cert_rotated audit emission", () => {
  it("[4.2] emits federation_cert_rotated with method=operator_key_rotation_approved and both fingerprints", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp();
    const newCertDer = new Uint8Array([3, 1, 4, 1, 5]);

    const res = await app.request(
      makeSimpleRequest("/memory/federation/peers/peer-a/approve-key", {
        newCertDer: Buffer.from(newCertDer).toString("base64"),
      })
    );

    expect(res.status).toBe(200);
    expect(fedDeps.mtls.approveKeyRotation).toHaveBeenCalledTimes(1);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("federation_cert_rotated");
    expect(entry.resourceKind).toBe("federation_peer");
    expect(entry.resourceId).toBe("peer-a");
    expect(entry.isTerminal).toBe(false);
    expect(entry.actorType).toBe("federation");
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);

    const detail = entry.detail as Record<string, unknown>;
    expect(detail["method"]).toBe("operator_key_rotation_approved");
    expect(detail["peerId"]).toBe("peer-a");
    expect(detail["oldCertFingerprint"]).toBe(certFingerprint(pinnedDer));
    expect(detail["newCertFingerprint"]).toBe(certFingerprint(newCertDer));
  });

  it("[4.4] does NOT emit when the peer is unknown (422)", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp();

    const res = await app.request(
      makeSimpleRequest("/memory/federation/peers/peer-unknown/approve-key", {
        newCertDer: Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"),
      })
    );

    expect(res.status).toBe(422);
    expect(appendAuditEntry).not.toHaveBeenCalled();
    expect(fedDeps.mtls.approveKeyRotation).not.toHaveBeenCalled();
  });

  it("[4.5] does NOT emit when newCertDer is missing (400 bad_request)", async () => {
    const { app, appendAuditEntry } = makeApp();

    const res = await app.request(
      makeSimpleRequest("/memory/federation/peers/peer-a/approve-key", {})
    );

    expect(res.status).toBe(400);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

// ─── p56 — federation_cert_pin_mismatch on gateFederationRequest() denial ─────

function makeFedGetRequest(
  fedDeps: ReturnType<typeof makeFedDeps>,
  path: string,
  headerOverrides: Record<string, string | undefined> = {}
): Request {
  const headers: Record<string, string> = {
    "x-mnemo-service-jwt": fedDeps.token,
    "x-mnemo-peer-id": "peer-a",
    "x-mnemo-client-cert": Buffer.from(pinnedDer).toString("base64url"),
    "x-mnemo-tls-protocol": "TLSv1.3",
  };
  for (const [k, v] of Object.entries(headerOverrides)) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return new Request(`http://localhost${path}`, { method: "GET", headers });
}

describe("GET /memory/federation/items gate — federation_cert_pin_mismatch audit emission (p56)", () => {
  it("emits federation_cert_pin_mismatch with both fingerprints, then still returns the unchanged 403", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp();
    const tamperedDer = new Uint8Array(pinnedDer);
    tamperedDer[tamperedDer.length - 1] = (tamperedDer[tamperedDer.length - 1]! ^ 0xff) & 0xff;

    const res = await app.request(
      makeFedGetRequest(fedDeps, "/memory/federation/items", {
        "x-mnemo-client-cert": Buffer.from(tamperedDer).toString("base64url"),
      })
    );

    expect(res.status).toBe(403);
    const bodyJson = await res.json();
    expect(bodyJson).toEqual({ error: { code: "unauthorized", message: "cert pin mismatch" } });

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("federation_cert_pin_mismatch");
    expect(entry.resourceKind).toBe("federation_peer");
    expect(entry.resourceId).toBe("peer-a");
    expect(entry.isTerminal).toBe(false);
    expect(entry.workspaceId).toBe(WORKSPACE);
    expect(entry.actorType).toBe("federation");
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);

    const detail = entry.detail as Record<string, unknown>;
    expect(detail["userId"]).toBe(USER_ID);
    expect(detail["peerId"]).toBe("peer-a");
    expect(detail["presentedCertFingerprint"]).toBe(certFingerprint(tamperedDer));
    expect(detail["pinnedCertFingerprint"]).toBe(certFingerprint(pinnedDer));
    expect(detail["presentedCertFingerprint"]).not.toBe(detail["pinnedCertFingerprint"]);
    expect(detail["reason"]).toBe("cert pin mismatch");
  });

  it("does NOT emit when appendAuditEntry rejects — the 403 stays unchanged (non-escalation)", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp();
    appendAuditEntry.mockRejectedValueOnce(new Error("merkle lock failed"));
    const tamperedDer = new Uint8Array(pinnedDer);
    tamperedDer[0] = (tamperedDer[0]! ^ 0xff) & 0xff;

    const res = await app.request(
      makeFedGetRequest(fedDeps, "/memory/federation/items", {
        "x-mnemo-client-cert": Buffer.from(tamperedDer).toString("base64url"),
      })
    );

    expect(res.status).toBe(403);
    const bodyJson = await res.json();
    expect(bodyJson).toEqual({ error: { code: "unauthorized", message: "cert pin mismatch" } });
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
  });

  it("does NOT emit for the 6 other rejection reasons", async () => {
    const { app, fedDeps, appendAuditEntry } = makeApp();

    // Add extra fixture peers for the "disabled" and "key parse error" cases.
    const badKeyDer = new Uint8Array([1, 2, 3, 4]); // not valid SPKI DER
    vi.spyOn(fedDeps.peerStore, "get").mockImplementation(async (id: string) => {
      if (id === "peer-a") {
        return {
          peerId: "peer-a",
          pinnedCertDer: pinnedDer,
          trustWeight: 1,
          approvedAt: "2026-01-01T00:00:00.000Z",
          enabled: true,
        };
      }
      if (id === "peer-disabled") {
        return {
          peerId: "peer-disabled",
          pinnedCertDer: pinnedDer,
          trustWeight: 1,
          approvedAt: "2026-01-01T00:00:00.000Z",
          enabled: false,
        };
      }
      if (id === "peer-badkey") {
        return {
          peerId: "peer-badkey",
          pinnedCertDer: badKeyDer,
          trustWeight: 1,
          approvedAt: "2026-01-01T00:00:00.000Z",
          enabled: true,
        };
      }
      return null;
    });

    const cases: Array<{ name: string; headers: Record<string, string | undefined> }> = [
      { name: "missing peer id", headers: { "x-mnemo-peer-id": undefined } },
      { name: "unknown peer", headers: { "x-mnemo-peer-id": "peer-ghost" } },
      { name: "peer disabled", headers: { "x-mnemo-peer-id": "peer-disabled" } },
      { name: "missing/malformed JWT", headers: { "x-mnemo-service-jwt": undefined } },
      {
        name: "peer key parse error",
        headers: {
          "x-mnemo-peer-id": "peer-badkey",
          "x-mnemo-client-cert": Buffer.from(badKeyDer).toString("base64url"),
        },
      },
      {
        name: "JWT verification failure",
        headers: { "x-mnemo-service-jwt": "not-a-real-jwt" },
      },
    ];

    for (const { headers } of cases) {
      const res = await app.request(
        makeFedGetRequest(fedDeps, "/memory/federation/items", headers)
      );
      expect(res.status).toBe(403);
    }

    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});
