/**
 * TenantRepository — raw postgres.js queries for the multi-tenant model.
 *
 * Tables (migration 0006):
 *   mnemosyne.mnemo_tenant
 *   mnemosyne.mnemo_user
 *   mnemosyne.mnemo_tenant_member
 *   mnemosyne.mnemo_workspace
 *   mnemosyne.mnemo_workspace_member
 *
 * RLS is enabled for these tables. Callers that need tenant/user-scoped access
 * must bind this repository to a transaction where the tenant GUCs are set.
 * New tenants and accounts go through the provisioning functions of migration
 * 0047 (provisionTenant, provisionUser, findUserIdByEmail).
 * All timestamps are returned as ISO-8601 strings (::text cast in SQL).
 */

import type { Sql, TransactionSql } from "postgres";

// ─── Row shapes ───────────────────────────────────────────────────────────────

type TenantRow = {
  id: string;
  name: string;
  kind: string;
  plan: string;
  created_at: string;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  personal_tenant_id: string;
  created_at: string;
};

type TenantMemberRow = {
  tenant_id: string;
  user_id: string;
  role: string;
  joined_at: string;
};

type WorkspaceRow = {
  id: string;
  name: string;
  slug: string | null;
  tenant_id: string;
  owner_user_id: string | null;
  visibility: string;
  created_at: string;
};

type WorkspaceMemberRow = {
  workspace_id: string;
  user_id: string;
  role: string;
  joined_at: string;
};

// ─── Repository ───────────────────────────────────────────────────────────────

export class TenantRepository {
  constructor(private readonly sql: Sql | TransactionSql) {}

  // ── Tenants ────────────────────────────────────────────────────────────────

  async createTenant(input: {
    name: string;
    kind: "personal" | "organization";
    plan?: string;
  }): Promise<{ id: string; name: string; kind: string; plan: string; createdAt: string }> {
    const plan = input.plan ?? "free";
    const rows = await this.sql<TenantRow[]>`
      INSERT INTO mnemosyne.mnemo_tenant (name, kind, plan)
      VALUES (${input.name}, ${input.kind}, ${plan})
      RETURNING id, name, kind, plan, created_at::text
    `;
    const row = rows[0];
    if (!row) throw new Error("Failed to insert tenant");
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      plan: row.plan,
      createdAt: row.created_at,
    };
  }

  async getTenant(
    id: string
  ): Promise<{ id: string; name: string; kind: string; plan: string } | null> {
    const rows = await this.sql<TenantRow[]>`
      SELECT id, name, kind, plan
      FROM mnemosyne.mnemo_tenant
      WHERE id = ${id}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, name: row.name, kind: row.kind, plan: row.plan };
  }

  async listTenantsForUser(
    userId: string
  ): Promise<Array<{ tenantId: string; tenantName: string; role: string }>> {
    type Row = { tenant_id: string; tenant_name: string; role: string };
    const rows = await this.sql<Row[]>`
      SELECT tm.tenant_id, t.name AS tenant_name, tm.role
      FROM mnemosyne.mnemo_tenant_member tm
      JOIN mnemosyne.mnemo_tenant t ON t.id = tm.tenant_id
      WHERE tm.user_id = ${userId}
      ORDER BY t.name
    `;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      role: r.role,
    }));
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  async createUser(input: {
    email: string;
    displayName?: string;
    personalTenantId: string;
  }): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    personalTenantId: string;
    createdAt: string;
  }> {
    const displayName = input.displayName ?? null;
    const rows = await this.sql<UserRow[]>`
      INSERT INTO mnemosyne.mnemo_user (email, display_name, personal_tenant_id)
      VALUES (${input.email}, ${displayName}, ${input.personalTenantId})
      RETURNING id, email, display_name, personal_tenant_id, created_at::text
    `;
    const row = rows[0];
    if (!row) throw new Error("Failed to insert user");
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      personalTenantId: row.personal_tenant_id,
      createdAt: row.created_at,
    };
  }

  async getUserByEmail(email: string): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    personalTenantId: string;
  } | null> {
    const rows = await this.sql<UserRow[]>`
      SELECT id, email, display_name, personal_tenant_id
      FROM mnemosyne.mnemo_user
      WHERE email = ${email}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      personalTenantId: row.personal_tenant_id,
    };
  }

  // ── Provisioning (migration 0047) ──────────────────────────────────────────
  //
  // A new tenant's id is never the caller's tenant and a new user is never the
  // caller, so under a tenant-bound caller's GUCs RLS refuses these rows. The
  // SECURITY DEFINER functions write them instead: they generate every id, take
  // nothing that already exists, and refuse a user who is not owner or admin of
  // the tenant in mnemosyne.actor_tenant_id (SQLSTATE 42501).

  /**
   * Creates a tenant; a caller with a user becomes its owner. With
   * `workspaceName`, also the tenant's first workspace, owned by that user
   * (needs a caller with a user).
   */
  async provisionTenant(input: {
    name: string;
    kind: "personal" | "organization";
    plan?: string;
    workspaceName?: string;
  }): Promise<{
    tenant: { id: string; name: string; kind: string; plan: string; createdAt: string };
    workspace: {
      id: string;
      name: string;
      slug: string | null;
      tenantId: string;
      visibility: string;
      createdAt: string;
    } | null;
  }> {
    type Row = {
      tenant_id: string;
      tenant_name: string;
      tenant_kind: string;
      tenant_plan: string;
      tenant_created_at: string;
      workspace_id: string | null;
      workspace_name: string | null;
      workspace_slug: string | null;
      workspace_visibility: string | null;
      workspace_created_at: string | null;
    };
    const rows = await this.sql<Row[]>`
      SELECT * FROM mnemosyne.mnemo_provision_tenant(
        ${input.name}, ${input.kind}, ${input.plan ?? null}, ${input.workspaceName ?? null})
    `;
    const row = rows[0];
    if (!row) throw new Error("Failed to provision tenant");
    return {
      tenant: {
        id: row.tenant_id,
        name: row.tenant_name,
        kind: row.tenant_kind,
        plan: row.tenant_plan,
        createdAt: row.tenant_created_at,
      },
      workspace: row.workspace_id
        ? {
            id: row.workspace_id,
            name: row.workspace_name ?? "",
            slug: row.workspace_slug,
            tenantId: row.tenant_id,
            visibility: row.workspace_visibility ?? "private",
            createdAt: row.workspace_created_at ?? "",
          }
        : null,
    };
  }

  /**
   * Creates a user with its personal tenant and personal workspace, both owned
   * by it. A taken email fails with unique_violation (23505).
   */
  async provisionUser(input: {
    email: string;
    displayName?: string;
    workspaceName: string;
  }): Promise<{
    user: {
      id: string;
      email: string;
      displayName: string | null;
      personalTenantId: string;
      createdAt: string;
    };
    tenant: { id: string; name: string; kind: string; plan: string; createdAt: string };
    workspace: {
      id: string;
      name: string;
      slug: string | null;
      tenantId: string;
      visibility: string;
      createdAt: string;
    };
  }> {
    type Row = {
      user_id: string;
      user_email: string;
      user_display_name: string | null;
      user_created_at: string;
      tenant_id: string;
      tenant_name: string;
      tenant_kind: string;
      tenant_plan: string;
      tenant_created_at: string;
      workspace_id: string;
      workspace_name: string;
      workspace_slug: string | null;
      workspace_visibility: string;
      workspace_created_at: string;
    };
    const rows = await this.sql<Row[]>`
      SELECT * FROM mnemosyne.mnemo_provision_user(
        ${input.email}, ${input.displayName ?? null}, ${input.workspaceName})
    `;
    const row = rows[0];
    if (!row) throw new Error("Failed to provision user");
    return {
      user: {
        id: row.user_id,
        email: row.user_email,
        displayName: row.user_display_name,
        personalTenantId: row.tenant_id,
        createdAt: row.user_created_at,
      },
      tenant: {
        id: row.tenant_id,
        name: row.tenant_name,
        kind: row.tenant_kind,
        plan: row.tenant_plan,
        createdAt: row.tenant_created_at,
      },
      workspace: {
        id: row.workspace_id,
        name: row.workspace_name,
        slug: row.workspace_slug,
        tenantId: row.tenant_id,
        visibility: row.workspace_visibility,
        createdAt: row.workspace_created_at,
      },
    };
  }

  /** The id of the user with this email, past mnemo_user_own; null if none. */
  async findUserIdByEmail(email: string): Promise<string | null> {
    const rows = await this.sql<Array<{ id: string | null }>>`
      SELECT mnemosyne.mnemo_find_user_id_by_email(${email}) AS id
    `;
    return rows[0]?.id ?? null;
  }

  // ── Tenant members ─────────────────────────────────────────────────────────

  async addTenantMember(
    tenantId: string,
    userId: string,
    role: string,
    invitedBy?: string
  ): Promise<void> {
    await this.sql`
      INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role, invited_by)
      VALUES (${tenantId}, ${userId}, ${role}, ${invitedBy ?? null})
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
  }

  async listTenantMembers(
    tenantId: string
  ): Promise<Array<{ userId: string; role: string; joinedAt: string }>> {
    const rows = await this.sql<TenantMemberRow[]>`
      SELECT user_id, role, joined_at::text
      FROM mnemosyne.mnemo_tenant_member
      WHERE tenant_id = ${tenantId}
      ORDER BY joined_at
    `;
    return rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      joinedAt: r.joined_at,
    }));
  }

  async removeTenantMember(tenantId: string, userId: string): Promise<void> {
    await this.sql`
      DELETE FROM mnemosyne.mnemo_tenant_member
      WHERE tenant_id = ${tenantId} AND user_id = ${userId}
    `;
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────

  async createWorkspace(input: {
    name: string;
    slug?: string;
    tenantId: string;
    ownerUserId?: string;
    visibility?: string;
  }): Promise<{
    id: string;
    name: string;
    slug: string | null;
    tenantId: string;
    visibility: string;
    createdAt: string;
  }> {
    const slug = input.slug ?? null;
    const ownerUserId = input.ownerUserId ?? null;
    const visibility = input.visibility ?? "private";
    const rows = await this.sql<WorkspaceRow[]>`
      INSERT INTO mnemosyne.mnemo_workspace (name, slug, tenant_id, owner_user_id, visibility)
      VALUES (${input.name}, ${slug}, ${input.tenantId}, ${ownerUserId}, ${visibility})
      RETURNING id, name, slug, tenant_id, owner_user_id, visibility, created_at::text
    `;
    const row = rows[0];
    if (!row) throw new Error("Failed to insert workspace");

    // Auto-seed owner membership when ownerUserId is provided.
    // Both INSERTs run on the same sql handle so they are part of the same
    // transaction when called from within a withTenantRls block. A plain
    // INSERT, not addWorkspaceMember's upsert: the workspace is new, and for a
    // caller with a user this row passes RLS through the INSERT-only
    // mnemo_workspace_member_seed_owner policy (migration 0047).
    if (input.ownerUserId) {
      await this.sql`
        INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
        VALUES (${row.id}, ${input.ownerUserId}, ${"owner"})
      `;
    }

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      tenantId: row.tenant_id,
      visibility: row.visibility,
      createdAt: row.created_at,
    };
  }

  async getWorkspace(id: string): Promise<{
    id: string;
    name: string;
    slug: string | null;
    tenantId: string;
    visibility: string;
  } | null> {
    const rows = await this.sql<WorkspaceRow[]>`
      SELECT id, name, slug, tenant_id, owner_user_id, visibility
      FROM mnemosyne.mnemo_workspace
      WHERE id = ${id}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      tenantId: row.tenant_id,
      visibility: row.visibility,
    };
  }

  async listWorkspacesForTenant(tenantId: string): Promise<
    Array<{
      id: string;
      name: string;
      slug: string | null;
      visibility: string;
      memberCount: number;
    }>
  > {
    type Row = {
      id: string;
      name: string;
      slug: string | null;
      visibility: string;
      member_count: string;
    };
    const rows = await this.sql<Row[]>`
      SELECT w.id, w.name, w.slug, w.visibility,
             COUNT(wm.user_id)::text AS member_count
      FROM mnemosyne.mnemo_workspace w
      LEFT JOIN mnemosyne.mnemo_workspace_member wm ON wm.workspace_id = w.id
      WHERE w.tenant_id = ${tenantId}
      GROUP BY w.id, w.name, w.slug, w.visibility
      ORDER BY w.name
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      visibility: r.visibility,
      memberCount: parseInt(r.member_count, 10),
    }));
  }

  async listWorkspacesForUser(
    userId: string
  ): Promise<
    Array<{ workspaceId: string; workspaceName: string; role: string; visibility: string }>
  > {
    type Row = { workspace_id: string; workspace_name: string; role: string; visibility: string };
    const rows = await this.sql<Row[]>`
      SELECT wm.workspace_id, w.name AS workspace_name, wm.role, w.visibility
      FROM mnemosyne.mnemo_workspace_member wm
      JOIN mnemosyne.mnemo_workspace w ON w.id = wm.workspace_id
      WHERE wm.user_id = ${userId}
      ORDER BY w.name
    `;
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      role: r.role,
      visibility: r.visibility,
    }));
  }

  // ── Workspace members ──────────────────────────────────────────────────────

  async addWorkspaceMember(
    workspaceId: string,
    userId: string,
    role: string,
    invitedBy?: string
  ): Promise<void> {
    await this.sql`
      INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role, invited_by)
      VALUES (${workspaceId}, ${userId}, ${role}, ${invitedBy ?? null})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
  }

  async listWorkspaceMembers(
    workspaceId: string
  ): Promise<Array<{ userId: string; role: string; joinedAt: string }>> {
    const rows = await this.sql<WorkspaceMemberRow[]>`
      SELECT user_id, role, joined_at::text
      FROM mnemosyne.mnemo_workspace_member
      WHERE workspace_id = ${workspaceId}
      ORDER BY joined_at
    `;
    return rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      joinedAt: r.joined_at,
    }));
  }

  /**
   * Removes the membership and revokes the member's user-bound keys homed in
   * that workspace, as mnemo_workspace_member_apply does for the dashboard:
   * the auth path keeps a key's own scopes when its home membership is gone,
   * so a removed member's key would otherwise keep working. Callers run this
   * in one transaction and drop the user from the auth caches afterwards.
   */
  async removeWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
    await this.sql`
      DELETE FROM mnemosyne.mnemo_workspace_member
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `;
    await this.sql`
      UPDATE mnemosyne.mnemo_api_keys SET revoked_at = clock_timestamp()
      WHERE user_id = ${userId} AND workspace_id = ${workspaceId} AND revoked_at IS NULL
    `;
  }

  async updateWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
    role: string
  ): Promise<void> {
    await this.sql`
      UPDATE mnemosyne.mnemo_workspace_member
      SET role = ${role}
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `;
  }

  // ── Membership role lookups (used by authorization checks in routes) ────────

  async getTenantMemberRole(tenantId: string, userId: string): Promise<string | null> {
    type Row = { role: string };
    const rows = await this.sql<Row[]>`
      SELECT role
      FROM mnemosyne.mnemo_tenant_member
      WHERE tenant_id = ${tenantId} AND user_id = ${userId}
      LIMIT 1
    `;
    return rows[0]?.role ?? null;
  }

  async getWorkspaceMemberRole(workspaceId: string, userId: string): Promise<string | null> {
    type Row = { role: string };
    const rows = await this.sql<Row[]>`
      SELECT role
      FROM mnemosyne.mnemo_workspace_member
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
      LIMIT 1
    `;
    return rows[0]?.role ?? null;
  }
}
