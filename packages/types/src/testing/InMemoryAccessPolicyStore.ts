import type { AccessPolicyStore, AccessPolicyRecord } from "../ports.js";

export class InMemoryAccessPolicyStore implements AccessPolicyStore {
  private readonly byKey = new Map<string, AccessPolicyRecord>();

  private key(ws: string, agent: string): string {
    return `${ws}::${agent}`;
  }

  async getPolicy(workspaceId: string, agentId: string): Promise<AccessPolicyRecord | null> {
    return this.byKey.get(this.key(workspaceId, agentId)) ?? null;
  }

  async putPolicy(policy: AccessPolicyRecord): Promise<void> {
    this.byKey.set(this.key(policy.workspaceId, policy.agentId), policy);
  }

  async listPolicies(workspaceId: string): Promise<AccessPolicyRecord[]> {
    return [...this.byKey.values()].filter((p) => p.workspaceId === workspaceId);
  }

  async deletePolicy(workspaceId: string, agentId: string): Promise<boolean> {
    return this.byKey.delete(this.key(workspaceId, agentId));
  }
}
