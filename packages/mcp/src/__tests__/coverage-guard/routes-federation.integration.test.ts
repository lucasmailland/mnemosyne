/**
 * B4.1 — HTTP route coverage fill-in: federation peer-admin surface
 * (design.md "B4. Coverage fill-in", spec.md Requirement 13).
 *
 * `mountFederation` no-ops entirely (`if (!deps.federation) return`) unless
 * federation deps are wired — the live-surface harness now wires a real
 * `InMemoryPeerStore`/`MtlsAuthAdapter` pair (see live-surface.ts) so these
 * 5 peer-admin routes genuinely mount and can be exercised end-to-end.
 *
 * The 4 data-plane routes (`GET /memory/federation/items`,
 * `POST /memory/federation/sync`, `GET /memory/federation/sync/:jobId`,
 * `POST /memory/federation/resolve`) are NOT exercised here — see
 * `registry.ts`'s skip entries for the discovered reason (the same
 * `Authorization` header would need to simultaneously be a bcrypt-verified
 * `mk_fed_` API key AND an EdDSA-signed service JWT, which a single local
 * live-surface instance cannot legitimately construct).
 */
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";

let surface: LiveSurface;
let peerId: string;

function newPeerCertDer(): Uint8Array {
  const { publicKey } = generateKeyPairSync("ed25519");
  return new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
}

beforeAll(async () => {
  surface = await startLiveSurface();

  peerId = `peer-b4-${randomUUID().slice(0, 8)}`;
  await surface.federationPeerStore.seed({
    peerId,
    pinnedCertDer: newPeerCertDer(),
    trustWeight: 1,
    approvedAt: new Date().toISOString(), // determinism-ok: throwaway fixture seed value, not asserted
    enabled: true,
  });
}, 120_000);

afterAll(async () => {
  await surface.close();
});

describe("federation peer-admin routes (B4.1)", () => {
  it("GET /memory/federation/peers — lists the seeded peer", async () => {
    const res = await surface.http("GET", "/memory/federation/peers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { peers: Array<{ peerId: string }> };
    expect(body.peers.some((p) => p.peerId === peerId)).toBe(true);
  });

  it("POST /memory/federation/peers — provisions a peer, 409 on a repeat", async () => {
    const created = `peer-b4-${randomUUID().slice(0, 8)}`;
    const body = JSON.stringify({
      peerId: created,
      pinnedCertDer: Buffer.from(newPeerCertDer()).toString("base64"),
      trustWeight: 0.5,
    });
    const init = { headers: { "content-type": "application/json" }, body };
    const res = await surface.http("POST", "/memory/federation/peers", init);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { peerId: string }).peerId).toBe(created);

    const again = await surface.http("POST", "/memory/federation/peers", init);
    expect(again.status).toBe(409);
  });

  it("GET /memory/federation/peers/pending — always empty (no mDNS discovery)", async () => {
    const res = await surface.http("GET", "/memory/federation/peers/pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { peers: unknown[]; discovery: { enabled: boolean } };
    expect(body.peers).toEqual([]);
    expect(body.discovery.enabled).toBe(false);
  });

  it("POST /memory/federation/peers/:id/approve — operator pre-approved cert rotation", async () => {
    const newCertDer = Buffer.from(newPeerCertDer()).toString("base64");
    const res = await surface.http("POST", `/memory/federation/peers/${peerId}/approve`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newCertDer }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean; reason: string };
    expect(body.accepted).toBe(true);
    expect(body.reason).toBe("operator_approved");
  });

  it("POST /memory/federation/peers/:id/approve-key — explicit key-rotation approval", async () => {
    const newCertDer = Buffer.from(newPeerCertDer()).toString("base64");
    const res = await surface.http("POST", `/memory/federation/peers/${peerId}/approve-key`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newCertDer }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: boolean; peerId: string };
    expect(body.approved).toBe(true);
    expect(body.peerId).toBe(peerId);
  });

  it("POST /memory/federation/peers/:id/approve-key — 422 for an unprovisioned peer", async () => {
    const res = await surface.http("POST", `/memory/federation/peers/does-not-exist/approve-key`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newCertDer: Buffer.from(newPeerCertDer()).toString("base64") }),
    });
    expect(res.status).toBe(422);
  });

  it("DELETE /memory/federation/peers/:id — removes the peer", async () => {
    const res = await surface.http("DELETE", `/memory/federation/peers/${peerId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; peerId: string };
    expect(body.deleted).toBe(true);
    expect(body.peerId).toBe(peerId);

    const listRes = await surface.http("GET", "/memory/federation/peers");
    const listBody = (await listRes.json()) as { peers: Array<{ peerId: string }> };
    expect(listBody.peers.some((p) => p.peerId === peerId)).toBe(false);
  });
});
