/**
 * APP-048 (re-audit): a unique index or constraint added to a table that
 * already has rows fails the whole migration if duplicates exist — at deploy
 * time, on real data. A new migration must check for duplicates first (or
 * declare why it cannot fail).
 */
import { describe, expect, it } from "vitest";
import { lintMigration } from "../../migration-safety.js";

const unique = (sql: string) =>
  lintMigration(sql).filter((v) => v.check === "unique_index_duplicate_check");

describe("unique_index_duplicate_check", () => {
  it("flags a unique index on a pre-existing table", () => {
    expect(unique("CREATE UNIQUE INDEX CONCURRENTLY u ON mnemosyne.mnemo_fact (a, b);")).toHaveLength(1);
  });

  it("flags ADD CONSTRAINT ... UNIQUE on a pre-existing table", () => {
    expect(
      unique("ALTER TABLE mnemosyne.mnemo_task ADD CONSTRAINT t_u UNIQUE (workspace_id, title);")
    ).toHaveLength(1);
  });

  it("accepts it after a duplicate check in the same file", () => {
    const sql = `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM mnemosyne.mnemo_fact GROUP BY a, b HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'duplicates';
      END IF; END $$;
      CREATE UNIQUE INDEX CONCURRENTLY u ON mnemosyne.mnemo_fact (a, b);`;
    expect(unique(sql)).toEqual([]);
  });

  it("accepts a reviewed marker with a reason", () => {
    const sql = `-- migrate:unique-checked reason=widens-an-existing-unique-key
      CREATE UNIQUE INDEX CONCURRENTLY u ON mnemosyne.mnemo_fact (a, b, c);`;
    expect(unique(sql)).toEqual([]);
  });

  it("accepts a unique index on a table created in the same migration", () => {
    expect(
      unique("CREATE TABLE mnemosyne.t (id int); CREATE UNIQUE INDEX u ON mnemosyne.t (id);")
    ).toEqual([]);
  });
});
