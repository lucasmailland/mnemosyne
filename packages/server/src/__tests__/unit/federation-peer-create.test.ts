/**
 * POST /memory/federation/peers — the only path that provisions a federation
 * peer. Covers strict validation (400), the scope gate (403), duplicates (409),
 * the created peer as the rest of the federation surface sees it, and the audit
 * entry. Uses the real InMemoryPeerStore; scope checks without app.ts's central
 * guard, like federation-peer-authz.test.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { InMemoryPeerStore, MtlsAuthAdapter } from "@mnemo-ai/federation";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountFederation } from "../../routes/federation.js";
import { toErrorBody } from "../../errors.js";

const CERT_B64 = Buffer.from([0x30, 0x2a, 0x01, 0x02]).toString("base64");

function makeApp(scopes: string[] = ["federation:admin"]) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err, undefined);
    return c.json(body, status as 400 | 403 | 409 | 500);
  });
  app.use("*", async (c, next) => {
    c.set("workspaceId", "ws_peer_create_test");
    c.set("apiKeyPrefix", "mk_live_");
    c.set("scopes", scopes);
    c.set("userId", "user-peer-create-001");
    c.set("actorId", "key-peer-create-001");
    c.set("actorType", "agent");
    await next();
  });

  const peerStore = new InMemoryPeerStore();
  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
  const deps = {
    core: {},
    federation: {
      peerStore,
      mtls: new MtlsAuthAdapter(peerStore),
      jobStore: { create: vi.fn(), update: vi.fn(), get: vi.fn() },
    },
    storage: { appendAuditEntry } as unknown as ServerDeps["storage"],
    telemetry: { startSpan: () => ({ setAttribute() {}, setStatus() {}, end() {} }) },
  } as unknown as ServerDeps;
  mountFederation(app, deps);

  const post = (body: unknown) =>
    app.request("/memory/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, peerStore, appendAuditEntry, post };
}

describe("POST /memory/federation/peers", () => {
  it("creates the peer with server-time approvedAt and audits it", async () => {
    const { peerStore, appendAuditEntry, post } = makeApp();
    const res = await post({
      peerId: "acme.example",
      pinnedCertDer: CERT_B64,
      trustWeight: 0.6,
      url: "https://acme.example",
      apiKey: "mk_fed_fixture",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean; peerId: string; approvedAt: string };
    expect(body).toMatchObject({ created: true, peerId: "acme.example" });

    const stored = await peerStore.get("acme.example");
    expect(stored).toMatchObject({
      trustWeight: 0.6,
      enabled: true,
      url: "https://acme.example",
      apiKey: "mk_fed_fixture",
      approvedAt: body.approvedAt,
    });
    expect(Buffer.from(stored!.pinnedCertDer).toString("base64")).toBe(CERT_B64);

    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    const entry = appendAuditEntry.mock.calls[0]![0] as {
      action: string;
      resourceKind: string;
      resourceId: string;
      detail: Record<string, unknown>;
    };
    expect(entry).toMatchObject({
      action: "create",
      resourceKind: "federation_peer",
      resourceId: "acme.example",
    });
    expect(entry.detail["certFingerprint"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry.detail)).not.toContain("mk_fed_fixture");
  });

  it("then lets key rotation work for that peer", async () => {
    const { app, post } = makeApp();
    await post({ peerId: "acme.example", pinnedCertDer: CERT_B64, trustWeight: 1 });
    const res = await app.request("/memory/federation/peers/acme.example/approve-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newCertDer: Buffer.from([9, 9]).toString("base64") }),
    });
    expect(res.status).toBe(200);
  });

  it("409s on an existing peerId and keeps the first peer", async () => {
    const { peerStore, post } = makeApp();
    expect(
      (await post({ peerId: "acme.example", pinnedCertDer: CERT_B64, trustWeight: 0.2 })).status
    ).toBe(201);
    const res = await post({ peerId: "acme.example", pinnedCertDer: CERT_B64, trustWeight: 0.9 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("conflict");
    expect((await peerStore.get("acme.example"))?.trustWeight).toBe(0.2);
  });

  it("403s without federation:admin", async () => {
    const { peerStore, post } = makeApp(["memory:federation"]);
    const res = await post({ peerId: "acme.example", pinnedCertDer: CERT_B64, trustWeight: 0.5 });
    expect(res.status).toBe(403);
    expect(await peerStore.list()).toEqual([]);
  });

  const valid = { peerId: "acme.example", pinnedCertDer: CERT_B64, trustWeight: 0.5 };
  const { publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const sym = Buffer.alloc(32, 7).toString("base64");

  it.each([
    ["no body", null],
    ["missing peerId", { pinnedCertDer: CERT_B64, trustWeight: 0.5 }],
    ["peerId with a slash", { ...valid, peerId: "acme/example" }],
    ["missing pin", { peerId: "acme.example", trustWeight: 0.5 }],
    ["pin not base64", { ...valid, pinnedCertDer: "not base64!" }],
    ["trustWeight above 1", { ...valid, trustWeight: 1.5 }],
    ["trustWeight below 0", { ...valid, trustWeight: -0.1 }],
    ["enabled not boolean", { ...valid, enabled: "yes" }],
    ["http url", { ...valid, url: "http://acme.example" }],
    ["approvedAt from the body", { ...valid, approvedAt: "2020-01-01T00:00:00Z" }],
    [
      "symmetricKey of 16 bytes",
      { ...valid, signingPublicKey: pem, symmetricKey: Buffer.alloc(16).toString("base64") },
    ],
    ["signingPublicKey without symmetricKey", { ...valid, signingPublicKey: pem }],
    ["signingPublicKey not a key", { ...valid, signingPublicKey: "nope", symmetricKey: sym }],
  ])("400s on %s", async (_name, body) => {
    const { peerStore, post } = makeApp();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    expect(await peerStore.list()).toEqual([]);
  });

  it("accepts a peer with app-layer crypto keys", async () => {
    const { post } = makeApp();
    const res = await post({ ...valid, enabled: false, signingPublicKey: pem, symmetricKey: sym });
    expect(res.status).toBe(201);
  });
});

describe("GET /memory/federation/peers", () => {
  it("never returns the peer's apiKey or symmetricKey, only whether they are set", async () => {
    const { app, post } = makeApp();
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const sym = Buffer.alloc(32, 7).toString("base64");
    await post({
      peerId: "acme.example",
      pinnedCertDer: CERT_B64,
      trustWeight: 0.5,
      apiKey: "mk_fed_secret_fixture",
      signingPublicKey: pem,
      symmetricKey: sym,
    });
    await post({ peerId: "larkspur.example", pinnedCertDer: CERT_B64, trustWeight: 0.5 });

    const res = await app.request("/memory/federation/peers");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("mk_fed_secret_fixture");
    expect(text).not.toContain(sym);
    const { peers } = JSON.parse(text) as { peers: Array<Record<string, unknown>> };
    expect(peers.map((p) => [p["peerId"], p["hasApiKey"], p["hasSymmetricKey"]])).toEqual([
      ["acme.example", true, true],
      ["larkspur.example", false, false],
    ]);
    for (const p of peers) {
      expect(p).not.toHaveProperty("apiKey");
      expect(p).not.toHaveProperty("symmetricKey");
      expect(p).not.toHaveProperty("pinnedCertDer");
      expect(p["certFingerprint"]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
