import { randomUUID } from "node:crypto";
import { APPROVAL_USE_TTL_MS } from "../ports.js";
import type { ApprovalStore, ApprovalRequest, ApprovalRequestInput } from "../ports.js";

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly byId = new Map<string, ApprovalRequest>();

  async create(input: ApprovalRequestInput): Promise<ApprovalRequest> {
    const ar: ApprovalRequest = {
      ...input,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date(),
    };
    this.byId.set(ar.id, ar);
    return ar;
  }

  async get(workspaceId: string, id: string): Promise<ApprovalRequest | null> {
    const ar = this.byId.get(id);
    return ar && ar.workspaceId === workspaceId ? ar : null;
  }

  async resolve(
    workspaceId: string,
    id: string,
    status: "approved" | "denied",
    resolvedBy: string,
  ): Promise<boolean> {
    const ar = this.byId.get(id);
    if (!ar || ar.workspaceId !== workspaceId) throw new Error(`approval ${id} not found`);
    if (ar.status !== "pending" || ar.expiresAt.getTime() <= Date.now()) return false;
    ar.status = status;
    ar.resolvedBy = resolvedBy;
    ar.resolvedAt = new Date();
    // The use window starts at the decision.
    if (status === "approved") ar.expiresAt = new Date(Date.now() + APPROVAL_USE_TTL_MS);
    return true;
  }

  async consume(
    workspaceId: string,
    id: string,
    by: { requestedBy: string; method: string; path: string },
  ): Promise<boolean> {
    const ar = this.byId.get(id);
    if (!ar || ar.workspaceId !== workspaceId) return false;
    if (ar.status !== "approved" || ar.expiresAt.getTime() <= Date.now()) return false;
    if (ar.requestedBy !== by.requestedBy) return false;
    if (ar.payload["method"] !== by.method || ar.payload["path"] !== by.path) return false;
    ar.status = "consumed";
    return true;
  }
}
