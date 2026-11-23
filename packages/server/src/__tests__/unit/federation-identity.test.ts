/**
 * The puller's half of the federation protocol: what federationIdentityFromEnv
 * reads and what pullHeaders sends must pass the serving peer's gate
 * (authenticateFederationRequest) as-is, and only for the peer it was made for.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { InMemoryJtiStore } from "@mnemo-ai/core";
import {
  federationIdentityFromEnv,
  pullHeaders,
  pullTlsFromEnv,
} from "../../federation/federationIdentity.js";
import { authenticateFederationRequest } from "../../federation/authenticateFederationRequest.js";

const { privateKey } = generateKeyPairSync("ed25519");
const PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function servingGate(pinned: Uint8Array, selfAudience: string) {
  return {
    peerStore: {
      async get(id: string) {
        return id === "larkspur.example"
          ? { peerId: id, pinnedCertDer: pinned, enabled: true }
          : null;
      },
    },
    jtiStore: new InMemoryJtiStore(),
    selfAudience,
    transport: { allowInsecure: true },
  };
}

function request(headers: Record<string, string>) {
  return {
    req: { header: (k: string) => headers[k.toLowerCase()] },
    get: () => "mk_fed_",
  };
}

describe("federationIdentityFromEnv", () => {
  it("is undefined until both the id and the key are set", () => {
    expect(federationIdentityFromEnv({})).toBeUndefined();
    expect(federationIdentityFromEnv({ MNEMO_FED_PEER_ID: "larkspur.example" })).toBeUndefined();
    expect(federationIdentityFromEnv({ MNEMO_FEDERATION_PRIVATE_KEY: PEM })).toBeUndefined();
  });

  it("refuses a key that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    expect(() =>
      federationIdentityFromEnv({ MNEMO_FED_PEER_ID: "x", MNEMO_FEDERATION_PRIVATE_KEY: rsa })
    ).toThrow(/Ed25519/);
  });
});

// The happy path (a real certificate through a real nginx) runs in
// federation-tls-proxy.integration.test.ts; these are the refusals at boot.
describe("pullTlsFromEnv", () => {
  const dir = mkdtempSync(join(tmpdir(), "mnemo-fed-tls-"));
  const keyFile = join(dir, "client.key");
  writeFileSync(keyFile, PEM);
  const missing = join(dir, "missing.crt");

  it("is undefined when no file is configured (pulls stay as they were)", () => {
    expect(pullTlsFromEnv({})).toBeUndefined();
  });

  it("refuses a certificate without its key, and the reverse", () => {
    expect(() => pullTlsFromEnv({ MNEMO_FED_CLIENT_CERT_FILE: missing })).toThrow(/set both/);
    expect(() => pullTlsFromEnv({ MNEMO_FED_CLIENT_KEY_FILE: keyFile })).toThrow(/set both/);
  });

  it("names the variable of a file it cannot read", () => {
    expect(() =>
      pullTlsFromEnv({ MNEMO_FED_CLIENT_CERT_FILE: missing, MNEMO_FED_CLIENT_KEY_FILE: keyFile })
    ).toThrow(/MNEMO_FED_CLIENT_CERT_FILE: cannot read/);
    expect(() => pullTlsFromEnv({ MNEMO_FED_CA_FILE: missing })).toThrow(/MNEMO_FED_CA_FILE/);
  });

  it("refuses a certificate file that is not a certificate", () => {
    expect(() =>
      pullTlsFromEnv({ MNEMO_FED_CLIENT_CERT_FILE: keyFile, MNEMO_FED_CLIENT_KEY_FILE: keyFile })
    ).toThrow(/not usable/);
  });
});

describe("pullHeaders against the serving peer's gate", () => {
  const identity = federationIdentityFromEnv({
    MNEMO_FED_PEER_ID: "larkspur.example",
    MNEMO_FEDERATION_PRIVATE_KEY: PEM,
  })!;

  it("passes the gate of the peer it was signed for", async () => {
    const r = await authenticateFederationRequest(
      request(pullHeaders(identity, "acme.example")),
      servingGate(identity.spkiDer, "acme.example") as never
    );
    expect(r).toEqual({ ok: true, peerId: "larkspur.example", workspaceScope: [] });
  });

  it("is refused by any other peer (aud is the serving peer's id)", async () => {
    const r = await authenticateFederationRequest(
      request(pullHeaders(identity, "acme.example")),
      servingGate(identity.spkiDer, "other.example") as never
    );
    expect(r).toMatchObject({ ok: false, reason: "aud mismatch" });
  });

  it("is refused when the serving peer pinned a different key", async () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    const r = await authenticateFederationRequest(
      request(pullHeaders(identity, "acme.example")),
      servingGate(new Uint8Array(other), "acme.example") as never
    );
    expect(r).toMatchObject({ ok: false, reason: "cert pin mismatch" });
  });
});
