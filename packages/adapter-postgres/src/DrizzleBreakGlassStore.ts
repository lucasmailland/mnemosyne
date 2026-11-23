import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type {
  BreakGlassStore,
  BreakGlassRequestInput,
  BreakGlassRequestRecord,
  SpecScope,
} from "@mnemo-ai/types";
import type { DrizzleClient } from "./DrizzleStorageAdapter.js";

/**
 * WP8 (F10) — Postgres-backed BreakGlassStore.
 *
 * The pure decision logic (requester ≠ approver, status finite-state) lives
 * here in the adapter because Drizzle issues the SQL; the same predicates are
 * mirrored in the in-memory test double. RLS is enforced by the
 * `mnemo_break_glass_request_ws` policy installed in migration 0069; this
 * adapter sets `mnemosyne.workspace_id` for each transaction via
 * `mnemo_set_workspace` exactly like every other Drizzle store in this package.
 */

function mapRow(r: Record<string, unknown>): BreakGlassRequestRecord {
  return {
    id: r["id"] as string,
    workspaceId: r["workspace_id"] as string,
    requestedBy: r["requested_by"] as string,
    reason: r["reason"] as string,
    requestedScopes: (r["requested_scopes"] as SpecScope[] | null) ?? [],
    status: r["status"] as BreakGlassRequestRecord["status"],
    approvedBy: (r["approved_by"] as string | null) ?? undefined,
    approvedAt: r["approved_at"] ? new Date(r["approved_at"] as string) : undefined,
    usedAt: r["used_at"] ? new Date(r["used_at"] as string) : undefined,
    expiresAt: new Date(r["expires_at"] as string),
    createdAt: new Date(r["created_at"] as string),
  };
}

function firstRow(rows: unknown): Record<string, unknown> | undefined {
  const raw = (rows as unknown as { rows?: unknown[] }).rows ?? rows;
  return Array.isArray(raw) ? (raw[0] as Record<string, unknown> | undefined) : undefined;
}

export class DrizzleBreakGlassStore implements BreakGlassStore {
  constructor(private readonly db: DrizzleClient) {}

  async request(input: BreakGlassRequestInput): Promise<BreakGlassRequestRecord> {
    const id = randomUUID();
    const createdAt = new Date();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      await tx.execute(sql`
        -- Drizzle expands a JS array into a parenthesised list, never a
        -- Postgres array, so the scopes travel as one jsonb parameter.
        INSERT INTO mnemosyne.mnemo_break_glass_request
          (id, workspace_id, requested_by, reason, requested_scopes,
           status, expires_at, created_at)
        VALUES (
          ${id}, ${input.workspaceId}, ${input.requestedBy}, ${input.reason},
          ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.requestedScopes)}::jsonb)),
          'pending',
          ${input.expiresAt.toISOString()}, ${createdAt.toISOString()}
        )`);
    });
    return { ...input, id, status: "pending", createdAt };
  }

  async approve(workspaceId: string, id: string, approverId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute(sql`
        SELECT requested_by, status
        FROM mnemosyne.mnemo_break_glass_request
        WHERE workspace_id = ${workspaceId} AND id = ${id}
        FOR UPDATE LIMIT 1`);
      const r = firstRow(rows);
      if (!r) throw new Error(`break-glass request ${id} not found`);
      if ((r["requested_by"] as string) === approverId) {
        throw new Error("requester cannot self-approve break-glass request");
      }
      if ((r["status"] as string) !== "pending") {
        throw new Error(`break-glass request ${id} is not pending`);
      }
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_break_glass_request
        SET status = 'approved', approved_by = ${approverId}, approved_at = now()
        WHERE workspace_id = ${workspaceId} AND id = ${id}`);
    });
  }

  async get(workspaceId: string, id: string): Promise<BreakGlassRequestRecord | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute(sql`
        SELECT id, workspace_id, requested_by, reason, requested_scopes, status,
               approved_by, approved_at, used_at, expires_at, created_at
        FROM mnemosyne.mnemo_break_glass_request
        WHERE workspace_id = ${workspaceId} AND id = ${id} LIMIT 1`);
      const r = firstRow(rows);
      return r ? mapRow(r) : null;
    });
  }

  async getActiveApproved(
    workspaceId: string,
    requestedBy: string
  ): Promise<BreakGlassRequestRecord | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute(sql`
        SELECT id, workspace_id, requested_by, reason, requested_scopes, status,
               approved_by, approved_at, used_at, expires_at, created_at
        FROM mnemosyne.mnemo_break_glass_request
        WHERE workspace_id = ${workspaceId}
          AND requested_by = ${requestedBy}
          AND status = 'approved'
          AND expires_at > now()
        ORDER BY approved_at DESC LIMIT 1`);
      const r = firstRow(rows);
      return r ? mapRow(r) : null;
    });
  }

  async markUsed(workspaceId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_break_glass_request
        SET status = 'used', used_at = now()
        WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'approved'`);
    });
  }
}
