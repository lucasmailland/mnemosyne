/**
 * Unit tests for TenantRepository — P12 owner auto-seed.
 *
 * Tests verify that createWorkspace inserts an owner member row when
 * ownerUserId is provided, and does NOT insert one when it is absent.
 *
 * We use a minimal mock Sql that records template-tagged calls without
 * opening a real database connection.
 */

import { describe, it, expect } from "vitest";
import type postgres from "postgres";
import { TenantRepository } from "../repositories/TenantRepository.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type QueryCall = {
  fragment: string;
  values: readonly unknown[];
};

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/g, " ").trim();
}

/** Build a mock sql handle that records calls and returns realistic rows. */
function makeMockSql() {
  const calls: QueryCall[] = [];

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = normalizeSql(strings);
    calls.push({ fragment, values });

    // Return a workspace row for workspace INSERT
    if (fragment.includes("INSERT INTO mnemosyne.mnemo_workspace")) {
      return [
        {
          id: "ws-test-001",
          name: values[0],
          slug: null,
          tenant_id: values[2] ?? "tenant-1",
          owner_user_id: values[3] ?? null,
          visibility: "private",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ];
    }

    // workspace_member INSERT — return empty (ON CONFLICT DO UPDATE)
    if (fragment.includes("INSERT INTO mnemosyne.mnemo_workspace_member")) {
      return [];
    }

    return [];
  }) as unknown as postgres.Sql;

  return { sql, calls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TenantRepository.createWorkspace — P12 owner auto-seed", () => {
  it("5.1 inserts workspace AND member row when ownerUserId is provided", async () => {
    const { sql, calls } = makeMockSql();
    const repo = new TenantRepository(sql);

    const result = await repo.createWorkspace({
      name: "My Workspace",
      tenantId: "tenant-1",
      ownerUserId: "user-1",
    });

    expect(result.id).toBe("ws-test-001");
    expect(result.name).toBe("My Workspace");

    // Should have 2 INSERT calls: workspace + member
    const insertCalls = calls.filter((c) => c.fragment.includes("INSERT INTO"));
    expect(insertCalls).toHaveLength(2);

    const workspaceInsert = calls.find((c) =>
      c.fragment.includes("INSERT INTO mnemosyne.mnemo_workspace"),
    );
    expect(workspaceInsert).toBeTruthy();

    const memberInsert = calls.find((c) =>
      c.fragment.includes("INSERT INTO mnemosyne.mnemo_workspace_member"),
    );
    expect(memberInsert).toBeTruthy();
    // Verify the member insert params include workspaceId, userId, and role='owner'
    expect(memberInsert?.values).toContain("ws-test-001");
    expect(memberInsert?.values).toContain("user-1");
    expect(memberInsert?.values).toContain("owner");
  });

  it("5.2 inserts workspace only (no member row) when ownerUserId is absent", async () => {
    const { sql, calls } = makeMockSql();
    const repo = new TenantRepository(sql);

    const result = await repo.createWorkspace({
      name: "Shared Workspace",
      tenantId: "tenant-1",
    });

    expect(result.id).toBe("ws-test-001");

    // Should have exactly 1 INSERT call: workspace only
    const insertCalls = calls.filter((c) => c.fragment.includes("INSERT INTO"));
    expect(insertCalls).toHaveLength(1);

    const workspaceInsert = calls.find((c) =>
      c.fragment.includes("INSERT INTO mnemosyne.mnemo_workspace"),
    );
    expect(workspaceInsert).toBeTruthy();

    const memberInsert = calls.find((c) =>
      c.fragment.includes("INSERT INTO mnemosyne.mnemo_workspace_member"),
    );
    expect(memberInsert).toBeUndefined();
  });
});
