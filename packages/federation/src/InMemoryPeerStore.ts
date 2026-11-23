// InMemoryPeerStore — in-memory PeerStore, used when the server has no
// Postgres adapter. The server uses DrizzlePeerStore (@mnemo-ai/adapter-postgres)
// otherwise.

import type { PeerConfig, PeerStore } from "./MtlsAuthAdapter.js";

export class InMemoryPeerStore implements PeerStore {
  private peers = new Map<string, PeerConfig>();

  async get(peerId: string): Promise<PeerConfig | null> {
    return this.peers.get(peerId) ?? null;
  }

  async addPeer(peer: PeerConfig): Promise<boolean> {
    if (this.peers.has(peer.peerId)) return false;
    this.peers.set(peer.peerId, peer);
    return true;
  }

  /**
   * Update the pinned cert of an EXISTING peer (key-rotation path).
   *
   * SECURITY (FED-04): this method MUST NOT create a peer. Pinning a cert for an
   * unknown peerId would let any caller of the key-rotation surface
   * (POST .../approve-key → approveKeyRotation, or a pre-approved processAnnounce)
   * enrol an attacker-controlled peer as enabled+trusted. Peers come only from
   * deliberate operator provisioning. Unknown peerId → throw, mirroring the
   * "unknown_peer" guard in MtlsAuthAdapter.processAnnounce.
   */
  async upsertPinnedCert(peerId: string, certDer: Uint8Array, approvedAt: string): Promise<void> {
    const existing = this.peers.get(peerId);
    if (!existing) {
      throw new Error(`unknown_peer: cannot pin cert for unprovisioned peer '${peerId}'`);
    }
    this.peers.set(peerId, { ...existing, pinnedCertDer: certDer, approvedAt });
  }

  async list(): Promise<PeerConfig[]> {
    return Array.from(this.peers.values());
  }

  async deletePeer(id: string): Promise<void> {
    this.peers.delete(id);
  }
}
