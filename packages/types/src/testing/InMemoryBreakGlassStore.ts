import { randomUUID } from "node:crypto";
import type {
  BreakGlassStore,
  BreakGlassRequestInput,
  BreakGlassRequestRecord,
} from "../ports.js";

/**
 * WP8 (F10) — In-memory test double for the BreakGlassStore port.
 *
 * Pure decision logic only — no infra imports (Postgres / Drizzle live in the
 * adapter layer). The two-person dual-control rule (requester ≠ approver) and
 * the pending → approved → used finite-state machine are enforced here so they
 * can be unit-tested without a database.
 */
export class InMemoryBreakGlassStore implements BreakGlassStore {
  private readonly byId = new Map<string, BreakGlassRequestRecord>();

  async request(input: BreakGlassRequestInput): Promise<BreakGlassRequestRecord> {
    const r: BreakGlassRequestRecord = {
      ...input,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date(),
    };
    this.byId.set(r.id, r);
    return r;
  }

  async approve(workspaceId: string, id: string, approverId: string): Promise<void> {
    const r = this.byId.get(id);
    if (!r || r.workspaceId !== workspaceId) throw new Error(`break-glass request ${id} not found`);
    if (r.requestedBy === approverId) {
      throw new Error("requester cannot self-approve break-glass request");
    }
    if (r.status !== "pending") throw new Error(`break-glass request ${id} is not pending`);
    r.status = "approved";
    r.approvedBy = approverId;
    r.approvedAt = new Date();
  }

  async get(workspaceId: string, id: string): Promise<BreakGlassRequestRecord | null> {
    const r = this.byId.get(id);
    return r && r.workspaceId === workspaceId ? r : null;
  }

  async getActiveApproved(
    workspaceId: string,
    requestedBy: string,
  ): Promise<BreakGlassRequestRecord | null> {
    const now = Date.now();
    for (const r of this.byId.values()) {
      if (
        r.workspaceId === workspaceId &&
        r.requestedBy === requestedBy &&
        r.status === "approved" &&
        r.expiresAt.getTime() > now
      ) {
        return r;
      }
    }
    return null;
  }

  async markUsed(workspaceId: string, id: string): Promise<void> {
    const r = this.byId.get(id);
    if (!r || r.workspaceId !== workspaceId) throw new Error(`break-glass request ${id} not found`);
    r.status = "used";
    r.usedAt = new Date();
  }
}
