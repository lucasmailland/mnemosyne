import { describe, it, expect } from "vitest";
import { assertFederationBinding } from "../binding.js";

const cert = new Uint8Array([1, 2, 3]);

describe("assertFederationBinding — spec §3/§6", () => {
  it("accepts mk_fed_ key + client cert + TLS 1.3", () => {
    expect(
      assertFederationBinding({ keyType: "mk_fed_", clientCert: cert, tlsProtocol: "TLSv1.3" }).ok
    ).toBe(true);
  });
  it("rejects a non-federation key class", () => {
    const r = assertFederationBinding({
      keyType: "mk_live_",
      clientCert: cert,
      tlsProtocol: "TLSv1.3",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/mk_fed_|federation key/i);
  });
  it("rejects when no client certificate", () => {
    const r = assertFederationBinding({
      keyType: "mk_fed_",
      clientCert: undefined,
      tlsProtocol: "TLSv1.3",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/mtls|certificate/i);
  });
  it("rejects TLS below 1.3", () => {
    const r = assertFederationBinding({
      keyType: "mk_fed_",
      clientCert: cert,
      tlsProtocol: "TLSv1.2",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/tls\s*1\.3/i);
  });
  it("allowInsecureTransport accepts a request with no TLS at all, never a weaker TLS", () => {
    const base = { keyType: "mk_fed_", clientCert: cert };
    expect(assertFederationBinding({ ...base, tlsProtocol: undefined }).ok).toBe(false);
    expect(
      assertFederationBinding({ ...base, tlsProtocol: undefined, allowInsecureTransport: true }).ok
    ).toBe(true);
    expect(
      assertFederationBinding({ ...base, tlsProtocol: "TLSv1.2", allowInsecureTransport: true }).ok
    ).toBe(false);
    expect(
      assertFederationBinding({
        keyType: "mk_live_",
        clientCert: cert,
        tlsProtocol: undefined,
        allowInsecureTransport: true,
      }).ok
    ).toBe(false);
  });
});
