import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigration } from "../migration-safety.js";
const sql = () =>
  readFileSync(
    new URL("../../migrations/baseline/0049_dashboard_user_credentials.sql", import.meta.url),
    "utf8"
  );
describe("dashboard credentials migration", () => {
  it("AUTH-10 passes every migration safety rule without exemptions", () => {
    expect(lintMigration(sql())).toEqual([]);
  });
  it("AUTH-10 forces own-user RLS and restricts bootstrap execution", () => {
    expect(sql()).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql()).toMatch(/WITH CHECK/);
    expect(sql()).toMatch(/REVOKE ALL ON FUNCTION[\s\S]+FROM PUBLIC/);
    expect(sql()).toMatch(/SECURITY DEFINER[\s\S]+SET search_path/);
    expect(sql()).toMatch(/FOR UPDATE/);
  });
});
