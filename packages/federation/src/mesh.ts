export interface AnnounceMessage {
  instanceId: string;
  capabilities: string[];
  publicKey: string;
}

export interface MeshPeer extends AnnounceMessage {
  announcedAt: string;
}

export class FederationMesh {
  private readonly peers = new Map<string, MeshPeer>();

  announce(msg: AnnounceMessage): MeshPeer {
    if (!msg.instanceId) throw new Error("announce: instanceId is required");
    if (!msg.publicKey) throw new Error("announce: publicKey is required");
    const peer: MeshPeer = { ...msg, announcedAt: new Date().toISOString() };
    this.peers.set(msg.instanceId, peer);
    return peer;
  }

  get(instanceId: string): MeshPeer | undefined { return this.peers.get(instanceId); }
  list(): MeshPeer[] { return [...this.peers.values()]; }
  withCapability(cap: string): MeshPeer[] { return this.list().filter((p) => p.capabilities.includes(cap)); }
}
