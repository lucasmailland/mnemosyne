import { describe, it, expect } from "vitest";
import { lintMigration } from "../../migration-safety.js";

// SAFE-1: three recurring bugs (0008's index-target grant gap, mnemo_audit_log's
// INSERT-only RLS gap, mnemo_semantic_neighbor's missing GRANT — all fixed by
// hand after shipping) share one root cause: creating a table/enabling RLS
// without a matching GRANT / policy. The linter had zero rule for either
// pattern before this.

describe("grant_completeness", () => {
  it("flags a migration that CREATE TABLEs without a matching GRANT to mnemo_app_role", () => {
    const sql = `CREATE TABLE mnemosyne.foo (id text);`;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "grant_completeness")).toBe(true);
  });

  it("accepts a migration that CREATE TABLEs and GRANTs on it", () => {
    const sql = `
      CREATE TABLE mnemosyne.foo (id text);
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.foo TO mnemo_app_role;
    `;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "grant_completeness")).toBe(false);
  });

  it("accepts a migration that touches an existing table (no new CREATE TABLE)", () => {
    const sql = `ALTER TABLE mnemosyne.foo ADD COLUMN bar text;`;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "grant_completeness")).toBe(false);
  });

  it("accepts an ungranted table with an explicit allow marker", () => {
    const sql = `
      -- migrate:allow-no-grant reason=internal bookkeeping table, app role never queries it directly
      CREATE TABLE mnemosyne.foo (id text);
    `;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "grant_completeness")).toBe(false);
  });

  it("handles a conditional (DO block) GRANT as satisfying the check", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS public.foo (id text);
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'foo') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.foo TO mnemo_app_role;
        END IF;
      END $$;
    `;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "grant_completeness")).toBe(false);
  });
});

describe("rls_policy_completeness", () => {
  it("flags a table with ENABLE ROW LEVEL SECURITY but no policy", () => {
    const sql = `
      CREATE TABLE mnemosyne.foo (id text, workspace_id uuid);
      ALTER TABLE mnemosyne.foo ENABLE ROW LEVEL SECURITY;
    `;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "rls_policy_completeness")).toBe(true);
  });

  it("flags a table with only a SELECT policy (no ALL / INSERT-UPDATE-DELETE coverage)", () => {
    const sql = `
      CREATE TABLE mnemosyne.foo (id text, workspace_id uuid);
      ALTER TABLE mnemosyne.foo ENABLE ROW LEVEL SECURITY;
      CREATE POLICY foo_read ON mnemosyne.foo FOR SELECT USING (true);
    `;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "rls_policy_completeness")).toBe(true);
  });

  it("accepts ENABLE RLS + a FOR ALL policy", () => {
    const sql = `
      CREATE TABLE mnemosyne.foo (id text, workspace_id uuid);
      ALTER TABLE mnemosyne.foo ENABLE ROW LEVEL SECURITY;
      CREATE POLICY foo_ws ON mnemosyne.foo FOR ALL USING (workspace_id = current_setting('mnemosyne.workspace_id')::uuid);
    `;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "rls_policy_completeness")).toBe(false);
  });

  it("accepts ENABLE RLS + separate SELECT and ALL-writes-covering policies", () => {
    const sql = `
      CREATE TABLE mnemosyne.foo (id text, workspace_id uuid);
      ALTER TABLE mnemosyne.foo ENABLE ROW LEVEL SECURITY;
      CREATE POLICY foo_read ON mnemosyne.foo FOR SELECT USING (true);
      CREATE POLICY foo_insert ON mnemosyne.foo FOR INSERT WITH CHECK (true);
      CREATE POLICY foo_update ON mnemosyne.foo FOR UPDATE USING (true);
      CREATE POLICY foo_delete ON mnemosyne.foo FOR DELETE USING (true);
    `;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "rls_policy_completeness")).toBe(false);
  });

  it("accepts a table with RLS enabled and no policy given an explicit allow marker", () => {
    const sql = `
      -- migrate:allow-rls-no-policy reason=append-only table, INSERT-only for app role via REVOKE
      CREATE TABLE mnemosyne.foo (id text, workspace_id uuid);
      ALTER TABLE mnemosyne.foo ENABLE ROW LEVEL SECURITY;
    `;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "rls_policy_completeness")).toBe(false);
  });

  it("flags ENABLE RLS on a pre-existing table with no policy in this file either (the exact mnemo_recall_log/audit_log bug shape — this is a per-file linter, it cannot see an earlier migration's policy)", () => {
    const sql = `ALTER TABLE mnemosyne.mnemo_recall_log ENABLE ROW LEVEL SECURITY;`;
    const violations = lintMigration(sql);
    expect(violations.some((v) => v.check === "rls_policy_completeness")).toBe(true);
  });
});
