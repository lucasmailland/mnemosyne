import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createPublicKey, createHash } from "node:crypto";
import { signServiceJwt, InMemoryJtiStore } from "@mnemo-ai/core";
import { authenticateFederationRequest } from "../../federation/authenticateFederationRequest.js";

// Independent copy of the SHA-256 hex fingerprint idiom, used only to assert
// against — NOT imported from production code — so the parity test below is a
// real anti-drift check against the module-private helper in
// authenticateFederationRequest.ts (design D2).
function certFingerprint(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pinnedDer = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
const AUD = "mnemo:instance:self";

const peerStore = {
  async get(id: string) {
    return id === "peer-a"
      ? {
          peerId: "peer-a",
          pinnedCertDer: pinnedDer,
          trustWeight: 1,
          approvedAt: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
          enabled: true,
        }
      : null;
  },
} as any;

// Note: use null (not undefined) to suppress the default parameter — in JS, passing
// undefined triggers the default value, but null does not.
function ctx(over: Record<string, string | undefined> = {}, prefix: string | null = "mk_fed_") {
  const token = signServiceJwt(privateKey, { iss: "peer-a", aud: AUD, workspaceScope: ["ws_1"] });
  const headers = new Map<string, string | undefined>([
    ["x-mnemo-service-jwt", token],
    ["x-mnemo-peer-id", "peer-a"],
    ["x-mnemo-client-cert", Buffer.from(pinnedDer).toString("base64url")],
    ["x-mnemo-tls-protocol", "TLSv1.3"],
    ...Object.entries(over),
  ]);
  return {
    req: { header: (k: string) => headers.get(k.toLowerCase()) },
    get: (key: string) => (key === "apiKeyPrefix" ? (prefix ?? undefined) : undefined),
  };
}

describe("authenticateFederationRequest — §6 mTLS + service JWT", () => {
  // x-mnemo-tls-protocol in ctx() is what a trusted TLS proxy would set.
  const deps = {
    peerStore,
    jtiStore: new InMemoryJtiStore(),
    selfAudience: AUD,
    transport: { trustProxyHeaders: true },
  };

  it("accepts a fully bound, signed, pinned request", async () => {
    const r = await authenticateFederationRequest(ctx(), deps as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workspaceScope).toEqual(["ws_1"]);
  });

  it("rejects when TLS < 1.3", async () => {
    const r = await authenticateFederationRequest(
      ctx({ "x-mnemo-tls-protocol": "TLSv1.2" }),
      deps as any
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an unpinned cert (length mismatch — never reaches the byte comparison) and carries audit metadata (p56)", async () => {
    const tamperedDer = Buffer.from([9, 9, 9]);
    const r = await authenticateFederationRequest(
      ctx({ "x-mnemo-client-cert": tamperedDer.toString("base64url") }),
      deps as any
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.auditAction).toBe("federation_cert_pin_mismatch");
      expect(r.peerId).toBe("peer-a");
      expect(r.presentedCertFingerprint).toBe(certFingerprint(tamperedDer));
      expect(r.pinnedCertFingerprint).toBe(certFingerprint(pinnedDer));
    }
  });

  it("rejects a same-length cert that differs in content (P55: exercises the constant-time byte compare itself, not just the length guard) and carries audit metadata (p56)", async () => {
    // pinnedDer is the DER-encoded ed25519 public key fixture. Build a
    // same-length buffer that differs at a single byte offset so the
    // comparison must actually walk (and fail on) content, not length.
    const tamperedDer = new Uint8Array(pinnedDer);
    tamperedDer[tamperedDer.length - 1] = (tamperedDer[tamperedDer.length - 1]! ^ 0xff) & 0xff;
    expect(tamperedDer.length).toBe(pinnedDer.length);
    expect(tamperedDer).not.toEqual(pinnedDer);

    const r = await authenticateFederationRequest(
      ctx({ "x-mnemo-client-cert": Buffer.from(tamperedDer).toString("base64url") }),
      deps as any
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.auditAction).toBe("federation_cert_pin_mismatch");
      expect(r.peerId).toBe("peer-a");
      expect(r.presentedCertFingerprint).toBe(certFingerprint(tamperedDer));
      expect(r.pinnedCertFingerprint).toBe(certFingerprint(pinnedDer));
      expect(r.presentedCertFingerprint).not.toBe(r.pinnedCertFingerprint);
    }
  });

  it("does NOT carry audit metadata for a non-cert-pin failure (unknown peer) (p56)", async () => {
    const r = await authenticateFederationRequest(
      ctx({ "x-mnemo-peer-id": "peer-unknown" }),
      deps as any
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown peer");
      expect(r.auditAction).toBeUndefined();
      expect(r.peerId).toBeUndefined();
      expect(r.presentedCertFingerprint).toBeUndefined();
      expect(r.pinnedCertFingerprint).toBeUndefined();
    }
  });

  it("rejects when apiKeyPrefix is a non-federation prefix (mk_admin_ etc)", async () => {
    // Previously c.get() returned undefined (no key arg), hiding this check.
    // Now that we pass the key, a wrong prefix is correctly evaluated.
    const r = await authenticateFederationRequest(ctx({}, "mk_admin_"), deps as any);
    expect(r.ok).toBe(false);
  });

  it("rejects when apiKeyPrefix is undefined", async () => {
    // Previously c.get() always returned "mk_fed_" from the test stub (no key arg),
    // so this path was untestable. Now we confirm the bug is fixed.
    // Pass null (not undefined) so the default parameter is not triggered.
    const r = await authenticateFederationRequest(ctx({}, null), deps as any);
    expect(r.ok).toBe(false);
  });
});

describe("authenticateFederationRequest — transport and proof of possession", () => {
  const fresh = (transport: Record<string, boolean> = { trustProxyHeaders: true }) => ({
    peerStore,
    jtiStore: new InMemoryJtiStore(),
    selfAudience: AUD,
    transport,
  });

  it("ignores a client-sent x-mnemo-tls-protocol unless a TLS proxy is declared", async () => {
    const r = await authenticateFederationRequest(ctx(), fresh({}) as any);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/TLS 1\.3/) });
  });

  it("takes the TLS version from its own TLS socket, never from the header", async () => {
    const tls = (protocol: string) => ({
      ...ctx({ "x-mnemo-tls-protocol": "TLSv1.3" }),
      env: { incoming: { socket: { encrypted: true, getProtocol: () => protocol } } },
    });
    expect((await authenticateFederationRequest(tls("TLSv1.3"), fresh({}) as any)).ok).toBe(true);
    expect((await authenticateFederationRequest(tls("TLSv1.2"), fresh({}) as any)).ok).toBe(false);
  });

  it("MNEMO_TRUSTED_PROXY_IP: the proxy headers count only from that socket, never from X-Forwarded-For", async () => {
    const from = (remoteAddress: string) => ({
      ...ctx({ "x-forwarded-for": "10.0.0.5" }),
      env: { incoming: { socket: { remoteAddress } } },
    });
    const behindProxy = () =>
      fresh({ trustProxyHeaders: true, trustedProxyIp: "10.0.0.5" } as never) as any;
    expect((await authenticateFederationRequest(from("::ffff:10.0.0.5"), behindProxy())).ok).toBe(
      true
    );
    expect(await authenticateFederationRequest(from("127.0.0.1"), behindProxy())).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no client certificate/),
    });
  });

  it("MNEMO_FED_INSECURE_TRANSPORT accepts plain HTTP but still needs the signed JWT", async () => {
    const plain = ctx({ "x-mnemo-tls-protocol": undefined });
    expect(
      (await authenticateFederationRequest(plain, fresh({ allowInsecure: true }) as any)).ok
    ).toBe(true);
    const unsigned = ctx({ "x-mnemo-tls-protocol": undefined, "x-mnemo-service-jwt": undefined });
    expect(
      await authenticateFederationRequest(unsigned, fresh({ allowInsecure: true }) as any)
    ).toMatchObject({ ok: false, reason: "missing service JWT" });
  });

  it("no longer reads the JWT from Authorization (that header is the mk_fed_ API key)", async () => {
    const token = signServiceJwt(privateKey, { iss: "peer-a", aud: AUD, workspaceScope: [] });
    const r = await authenticateFederationRequest(
      ctx({ "x-mnemo-service-jwt": undefined, authorization: `Bearer ${token}` }),
      fresh() as any
    );
    expect(r).toMatchObject({ ok: false, reason: "missing service JWT" });
  });

  it("refuses a JWT signed by another key, even with the pinned key in the cert header", async () => {
    const intruder = generateKeyPairSync("ed25519").privateKey;
    const forged = signServiceJwt(intruder, { iss: "peer-a", aud: AUD, workspaceScope: [] });
    const r = await authenticateFederationRequest(
      ctx({ "x-mnemo-service-jwt": forged }),
      fresh() as any
    );
    expect(r).toMatchObject({ ok: false, reason: "invalid signature" });
  });

  it("refuses a JWT whose issuer is not the claimed peer", async () => {
    const other = signServiceJwt(privateKey, { iss: "peer-b", aud: AUD, workspaceScope: [] });
    const r = await authenticateFederationRequest(
      ctx({ "x-mnemo-service-jwt": other }),
      fresh() as any
    );
    expect(r).toMatchObject({ ok: false, reason: "JWT issuer is not the peer" });
  });

  it("refuses a replayed JWT", async () => {
    const deps = fresh();
    const token = signServiceJwt(privateKey, { iss: "peer-a", aud: AUD, workspaceScope: [] });
    const req = () => ctx({ "x-mnemo-service-jwt": token });
    expect((await authenticateFederationRequest(req(), deps as any)).ok).toBe(true);
    expect(await authenticateFederationRequest(req(), deps as any)).toMatchObject({
      ok: false,
      reason: "jti replay rejected",
    });
  });
});
