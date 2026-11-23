// packages/federation/src/__tests__/pull-client-plaintext-reject.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { pullFromPeer } from "../PullClient.js";

function makeKeys() {
  // Ed25519 public key object stands in for a pinned peer signing key.
  const { publicKey } = generateKeyPairSync("ed25519");
  return { peerSigningPublicKey: publicKey, symmetricKey: Buffer.alloc(32, 7) };
}

describe("pullFromPeer plaintext rejection (F9)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("REJECTS a plaintext body by default when peer keys are configured", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ remoteId: "f1", version: 1 }], nextCursor: null }),
    } as unknown as Response);

    const { peerSigningPublicKey, symmetricKey } = makeKeys();
    await expect(
      pullFromPeer("https://peer.example.com", "k", { peerSigningPublicKey, symmetricKey }),
    ).rejects.toThrow(/plaintext.*reject|unsigned|downgrade/i);
  });

  it("allows plaintext under MNEMO_FED_ALLOW_PLAINTEXT escape hatch (opts override)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ remoteId: "f1", version: 1 }], nextCursor: null }),
    } as unknown as Response);

    const warn = vi.fn();
    const { peerSigningPublicKey, symmetricKey } = makeKeys();
    const result = await pullFromPeer("https://peer.example.com", "k", {
      peerSigningPublicKey,
      symmetricKey,
      allowPlaintextDowngrade: true,
      logger: { warn },
    });
    expect(result.items).toHaveLength(1);
    expect(result.secure).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("still accepts plaintext when NO peer keys are configured (legacy unprotected peer)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ remoteId: "f1", version: 1 }], nextCursor: null }),
    } as unknown as Response);

    const result = await pullFromPeer("https://peer.example.com", "k");
    expect(result.items).toHaveLength(1);
    expect(result.secure).toBe(false);
  });
});
