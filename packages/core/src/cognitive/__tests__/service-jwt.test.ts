import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signServiceJwt, verifyServiceJwt, InMemoryJtiStore } from "../service-jwt.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const ISS = "mnemo:instance:a.example.com";
const AUD = "mnemo:instance:b.example.com";

function mkToken(over: Partial<{ workspaceScope: string[]; ttlSeconds: number; jti: string }> = {}) {
  return signServiceJwt(privateKey, {
    iss: ISS, aud: AUD, workspaceScope: over.workspaceScope ?? ["ws_123"],
    ttlSeconds: over.ttlSeconds ?? 300, jti: over.jti,
  });
}

describe("service JWT — spec §6 (lines 536-550)", () => {
  it("signs and verifies a valid token with the right claims", async () => {
    const jti = new InMemoryJtiStore();
    const token = mkToken();
    const r = await verifyServiceJwt(token, { publicKey, expectedAud: AUD, jtiStore: jti });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.sub).toBe("federation");
      expect(r.claims.iss).toBe(ISS);
      expect(r.claims.workspace_scope).toEqual(["ws_123"]);
    }
  });

  it("rejects a replayed jti", async () => {
    const jti = new InMemoryJtiStore();
    const token = mkToken({ jti: "fixed-jti-1" });
    expect((await verifyServiceJwt(token, { publicKey, expectedAud: AUD, jtiStore: jti })).ok).toBe(true);
    const second = await verifyServiceJwt(token, { publicKey, expectedAud: AUD, jtiStore: jti });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toMatch(/replay|jti/i);
  });

  it("rejects an expired token", async () => {
    const jti = new InMemoryJtiStore();
    const token = signServiceJwt(privateKey, { iss: ISS, aud: AUD, workspaceScope: ["ws_1"], ttlSeconds: -10 });
    const r = await verifyServiceJwt(token, { publicKey, expectedAud: AUD, jtiStore: jti });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/expired/i);
  });

  it("rejects exp horizon beyond 5 minutes", async () => {
    const jti = new InMemoryJtiStore();
    const token = signServiceJwt(privateKey, { iss: ISS, aud: AUD, workspaceScope: ["ws_1"], ttlSeconds: 3600 });
    const r = await verifyServiceJwt(token, { publicKey, expectedAud: AUD, jtiStore: jti });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/horizon|5\s*min/i);
  });

  it("rejects audience mismatch", async () => {
    const jti = new InMemoryJtiStore();
    const r = await verifyServiceJwt(mkToken(), { publicKey, expectedAud: "mnemo:instance:c.example.com", jtiStore: jti });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/aud/i);
  });

  it("rejects a tampered payload", async () => {
    const jti = new InMemoryJtiStore();
    const token = mkToken();
    const [h, , s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: "federation", workspace_scope: ["ws_evil"] })).toString("base64url")}.${s}`;
    const r = await verifyServiceJwt(forged, { publicKey, expectedAud: AUD, jtiStore: jti });
    expect(r.ok).toBe(false);
  });
});
