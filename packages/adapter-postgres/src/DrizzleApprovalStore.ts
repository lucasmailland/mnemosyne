import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ApprovalStore, ApprovalRequest, ApprovalRequestInput } from "@mnemo-ai/types";
import { APPROVAL_USE_TTL_MS } from "@mnemo-ai/types";
import type { DrizzleClient } from "./DrizzleStorageAdapter.js";

export class DrizzleApprovalStore implements ApprovalStore {
  constructor(private readonly db: DrizzleClient) {}

  async create(input: ApprovalRequestInput): Promise<ApprovalRequest> {
    const id = randomUUID();
    const createdAt = new Date();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_approval_request
          (id, workspace_id, requested_by, trigger, resource, resource_id,
           payload, status, expires_at, created_at)
        VALUES (
          ${id}, ${input.workspaceId}, ${input.requestedBy},
          ${input.trigger}, ${input.resource}, ${input.resourceId ?? null},
          ${JSON.stringify(input.payload)}::jsonb, 'pending',
          ${input.expiresAt.toISOString()}, ${createdAt.toISOString()}
        )`);
    });
    return {
      ...input,
      id,
      status: "pending",
      createdAt,
    };
  }

  async get(workspaceId: string, id: string): Promise<ApprovalRequest | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute(sql`
        SELECT id, workspace_id, requested_by, trigger, resource, resource_id,
               payload, status, resolved_by, resolved_at, expires_at, created_at
        FROM mnemosyne.mnemo_approval_request
        WHERE workspace_id = ${workspaceId} AND id = ${id} LIMIT 1`);
      const rawRows = (rows as unknown as { rows?: unknown[] }).rows ?? rows;
      const r = Array.isArray(rawRows) ? rawRows[0] as Record<string, unknown> | undefined : undefined;
      if (!r) return null;
      return {
        id: r["id"] as string,
        workspaceId: r["workspace_id"] as string,
        requestedBy: r["requested_by"] as string,
        trigger: r["trigger"] as ApprovalRequest["trigger"],
        resource: r["resource"] as string,
        resourceId: r["resource_id"] as string | undefined,
        payload: r["payload"] as Record<string, unknown>,
        status: r["status"] as ApprovalRequest["status"],
        resolvedBy: r["resolved_by"] as string | undefined,
        resolvedAt: r["resolved_at"] ? new Date(r["resolved_at"] as string) : undefined,
        expiresAt: new Date(r["expires_at"] as string),
        createdAt: new Date(r["created_at"] as string),
      };
    });
  }

  async resolve(
    workspaceId: string,
    id: string,
    status: "approved" | "denied",
    resolvedBy: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      // Only a pending, unexpired request moves: two resolvers cannot both win.
      const rows = await tx.execute(sql`
        UPDATE mnemosyne.mnemo_approval_request
        SET status = ${status}, resolved_by = ${resolvedBy}, resolved_at = now(),
            -- final review I6: an approval is usable for a fixed window from
            -- the decision, not from when the request was raised.
            expires_at = CASE WHEN ${status} = 'approved'
                              THEN now() + make_interval(secs => ${APPROVAL_USE_TTL_MS / 1000})
                              ELSE expires_at END
        WHERE workspace_id = ${workspaceId} AND id = ${id}
          AND status = 'pending' AND expires_at > now()
        RETURNING id`);
      return rowCount(rows) > 0;
    });
  }

  /** APP-007 — spend an approved request on the request it was granted for. */
  async consume(
    workspaceId: string,
    id: string,
    by: { requestedBy: string; method: string; path: string },
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute(sql`
        UPDATE mnemosyne.mnemo_approval_request
        SET status = 'consumed'
        WHERE workspace_id = ${workspaceId} AND id = ${id}
          AND status = 'approved' AND expires_at > now()
          AND requested_by = ${by.requestedBy}
          AND payload->>'method' = ${by.method}
          AND payload->>'path' = ${by.path}
        RETURNING id`);
      return rowCount(rows) > 0;
    });
  }
}

function rowCount(result: unknown): number {
  const raw = (result as { rows?: unknown[] }).rows ?? result;
  return Array.isArray(raw) ? raw.length : 0;
}
