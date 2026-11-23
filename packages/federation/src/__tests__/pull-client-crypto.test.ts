import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { pullFromPeer } from "../PullClient.js";
import { buildSecureItemsEnvelope } from "../secureEnvelope.js";
import { FederationVerifyError, FederationDecryptError } from "../secureEnvelope.js";
import type { FederatedItem } from "../SyncEngine.js";

function fakeResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

const sample: FederatedItem[] = [
  { remoteId: "f1", version: 2, peerDomain: "peer.example.com", payload: { statement: "secret value" } },
];

describe("pullFromPeer — P0-1 crypto enforcement + scoped sync (§20)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("verifies + decrypts a secure envelope when peer keys are configured", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const symmetricKey = randomBytes(32);
    const envelope = buildSecureItemsEnvelope(sample, null, {
      instancePrivateKey: privateKey,
      symmetricKey,
    });
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(envelope));

    const result = await pullFromPeer("https://peer.example.com", "key", {
      peerSigningPublicKey: publicKey,
      symmetricKey,
    });

    expect(result.secure).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.payload).toEqual({ statement: "secret value" });
  });

  it("throws FederationVerifyError on a forged signature (wrong peer key)", async () => {
    const serve = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const symmetricKey = randomBytes(32);
    const envelope = buildSecureItemsEnvelope(sample, null, {
      instancePrivateKey: serve.privateKey,
      symmetricKey,
    });
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(envelope));

    await expect(
      pullFromPeer("https://peer.example.com", "key", {
        peerSigningPublicKey: attacker.publicKey,
        symmetricKey,
      }),
    ).rejects.toThrow(FederationVerifyError);
  });

  it("throws FederationDecryptError when the symmetric key does not match", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const envelope = buildSecureItemsEnvelope(sample, null, {
      instancePrivateKey: privateKey,
      symmetricKey: randomBytes(32),
    });
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(envelope));

    await expect(
      pullFromPeer("https://peer.example.com", "key", {
        peerSigningPublicKey: publicKey,
        symmetricKey: randomBytes(32), // wrong
      }),
    ).rejects.toThrow(FederationDecryptError);
  });

  it("rejects a secure envelope when no keys are configured (cannot verify/decrypt)", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const envelope = buildSecureItemsEnvelope(sample, null, {
      instancePrivateKey: privateKey,
      symmetricKey: randomBytes(32),
    });
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(envelope));

    await expect(pullFromPeer("https://peer.example.com", "key")).rejects.toThrow(
      /secure envelope but no peer signing key/,
    );
  });

  it("falls back to plaintext (no keys configured) and returns secure=false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ items: sample, nextCursor: null }),
    );
    const result = await pullFromPeer("https://peer.example.com", "key");
    expect(result.secure).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.payload).toEqual({ statement: "secret value" });
  });

  it("logs a downgrade warning when keys are configured but the peer sends plaintext", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const warn = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ items: sample, nextCursor: null }),
    );

    const result = await pullFromPeer("https://peer.example.com", "key", {
      peerSigningPublicKey: publicKey,
      symmetricKey: randomBytes(32),
      allowPlaintextDowngrade: true,
      logger: { warn },
    });

    expect(result.secure).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/downgrade/);
  });

  it("sends the knowledgeTypes scoped-sync query param", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse({ items: [], nextCursor: null }));
    await pullFromPeer("https://peer.example.com", "key", {
      since: "2026-01-01T00:00:00Z",
      knowledgeTypes: ["fact", "decision"],
    });
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain("knowledgeTypes=fact%2Cdecision");
    expect(url).toContain("since=2026-01-01T00%3A00%3A00Z");
  });
});
