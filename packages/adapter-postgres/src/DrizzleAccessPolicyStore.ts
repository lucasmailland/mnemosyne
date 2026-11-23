import { sql } from "drizzle-orm";
import type { AccessPolicyStore, AccessPolicyRecord } from "@mnemo-ai/types";
import type { DrizzleClient } from "./DrizzleStorageAdapter.js";

const COLUMNS = sql`agent_id, workspace_id, read_scopes, write_scopes, self_edit,
               task_scopes, limits, require_approval_for, federation_access, namespaces`;

// Drizzle's sql template expands a JS array into a parenthesised list ("()" when
// empty), not a Postgres array, so text[] columns go through jsonb.
function textArray(xs: readonly string[]) {
  return sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb))`;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rawRows = (result as { rows?: unknown[] }).rows ?? result;
  return Array.isArray(rawRows) ? (rawRows as Record<string, unknown>[]) : [];
}

function toRecord(r: Record<string, unknown>): AccessPolicyRecord {
  return {
    agentId: r["agent_id"] as string,
    workspaceId: r["workspace_id"] as string,
    readScopes: r["read_scopes"] as AccessPolicyRecord["readScopes"],
    writeScopes: r["write_scopes"] as AccessPolicyRecord["writeScopes"],
    selfEdit: r["self_edit"] as AccessPolicyRecord["selfEdit"],
    taskScopes: r["task_scopes"] as AccessPolicyRecord["taskScopes"],
    limits: r["limits"] as AccessPolicyRecord["limits"],
    requireApprovalFor: r["require_approval_for"] as AccessPolicyRecord["requireApprovalFor"],
    federationAccess: r["federation_access"] as AccessPolicyRecord["federationAccess"],
    namespaces: r["namespaces"] as string[] | undefined,
  };
}

/** One write to mnemo_access_policy, as the replicas poll it (migration 0067). */
export interface AccessPolicyChange {
  seq: number;
  workspaceId: string;
  agentId: string;
}

export class DrizzleAccessPolicyStore implements AccessPolicyStore {
  constructor(private readonly db: DrizzleClient) {}

  /**
   * Policy writes after `afterSeq`, plus those of the last 10 s again (a lower
   * seq can commit after a higher one was read). Every workspace: the SECURITY
   * DEFINER function returns ids only. A trigger writes these rows in the same
   * transaction as the policy.
   */
  async changesSince(afterSeq: number): Promise<AccessPolicyChange[]> {
    const rows = await this.db.execute(
      sql`SELECT seq, workspace_id, agent_id FROM mnemosyne.mnemo_access_policy_changes(${afterSeq})`
    );
    return rowsOf(rows).map((r) => ({
      seq: Number(r["seq"]),
      workspaceId: r["workspace_id"] as string,
      agentId: r["agent_id"] as string,
    }));
  }

  /** Drops change rows older than an hour, past every replica's cache TTL. */
  async purgeChanges(): Promise<number> {
    const rows = await this.db.execute(
      sql`SELECT mnemosyne.mnemo_purge_access_policy_changes() AS n`
    );
    return Number(rowsOf(rows)[0]?.["n"] ?? 0);
  }

  async getPolicy(workspaceId: string, agentId: string): Promise<AccessPolicyRecord | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute(sql`
        SELECT ${COLUMNS}
        FROM mnemosyne.mnemo_access_policy
        WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId} LIMIT 1`);
      const r = rowsOf(rows)[0];
      return r ? toRecord(r) : null;
    });
  }

  async listPolicies(workspaceId: string): Promise<AccessPolicyRecord[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute(sql`
        SELECT ${COLUMNS}
        FROM mnemosyne.mnemo_access_policy
        WHERE workspace_id = ${workspaceId} ORDER BY agent_id`);
      return rowsOf(rows).map(toRecord);
    });
  }

  async deletePolicy(workspaceId: string, agentId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute(sql`
        DELETE FROM mnemosyne.mnemo_access_policy
        WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId}
        RETURNING agent_id`);
      return rowsOf(rows).length > 0;
    });
  }

  async putPolicy(p: AccessPolicyRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${p.workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_access_policy
          (id, workspace_id, agent_id, read_scopes, write_scopes, self_edit, task_scopes,
           limits, require_approval_for, federation_access, namespaces)
        VALUES (${`${p.workspaceId}:${p.agentId}`}, ${p.workspaceId}, ${p.agentId},
           ${textArray(p.readScopes)}, ${textArray(p.writeScopes)},
           ${JSON.stringify(p.selfEdit)}::jsonb,
           ${JSON.stringify(p.taskScopes)}::jsonb, ${JSON.stringify(p.limits)}::jsonb,
           ${textArray(p.requireApprovalFor)}, ${p.federationAccess},
           ${textArray(p.namespaces ?? [])})
        ON CONFLICT (workspace_id, agent_id) DO UPDATE SET
           read_scopes = EXCLUDED.read_scopes, write_scopes = EXCLUDED.write_scopes,
           self_edit = EXCLUDED.self_edit, task_scopes = EXCLUDED.task_scopes,
           limits = EXCLUDED.limits, require_approval_for = EXCLUDED.require_approval_for,
           federation_access = EXCLUDED.federation_access, namespaces = EXCLUDED.namespaces,
           updated_at = now()`);
    });
  }
}
