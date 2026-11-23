import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitSqlStatements } from "../sql-split.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "baseline",
);

describe("splitSqlStatements — basics", () => {
  it("splits simple semicolon-separated statements", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2; SELECT 3")).toEqual([
      "SELECT 1",
      "SELECT 2",
      "SELECT 3",
    ]);
  });

  it("drops empty statements and trims whitespace", () => {
    expect(splitSqlStatements("  SELECT 1 ;;\n\n ; SELECT 2 ;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("keeps a trailing statement that has no terminating semicolon", () => {
    expect(splitSqlStatements("CREATE TABLE t (id int)")).toEqual([
      "CREATE TABLE t (id int)",
    ]);
  });

  it("returns no statements for comment-only / blank input", () => {
    expect(splitSqlStatements("-- just a comment\n   \n")).toEqual([]);
    expect(splitSqlStatements("/* block only */\n")).toEqual([]);
    expect(splitSqlStatements("")).toEqual([]);
  });
});

describe("splitSqlStatements — dollar-quote awareness", () => {
  it("does NOT split on semicolons inside a $$ … $$ body", () => {
    const sql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'r') THEN
    CREATE ROLE r;
  END IF;
END
$$;
CREATE INDEX CONCURRENTLY idx_a ON t (c);
`;
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("DO $$");
    expect(out[0]).toContain("CREATE ROLE r;");
    expect(out[0]).toMatch(/\$\$$/); // ends at the closing $$
    expect(out[1]).toBe("CREATE INDEX CONCURRENTLY idx_a ON t (c)");
  });

  it("handles named dollar tags ($tag$ … $tag$) and inner $$", () => {
    const sql = `
CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $body$
BEGIN
  -- a nested $$ that is just text here; tags must match exactly
  RETURN 1;
END;
$body$;
SELECT 2;
`;
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("$body$");
    expect(out[0]).toContain("RETURN 1;");
    expect(out[1]).toBe("SELECT 2");
  });

  it("treats a lone $ (not a tag) as a literal character", () => {
    // No valid dollar-tag here, so the ; still separates.
    const out = splitSqlStatements("SELECT '$' AS a; SELECT 2");
    expect(out).toEqual(["SELECT '$' AS a", "SELECT 2"]);
  });
});

describe("splitSqlStatements — string & comment awareness", () => {
  it("does NOT split on semicolons inside single-quoted literals", () => {
    const out = splitSqlStatements("SELECT 'a;b;c'; SELECT 2");
    expect(out).toEqual(["SELECT 'a;b;c'", "SELECT 2"]);
  });

  it("handles the doubled-quote '' escape inside a literal", () => {
    const out = splitSqlStatements("SELECT 'it''s; fine'; SELECT 2");
    expect(out).toEqual(["SELECT 'it''s; fine'", "SELECT 2"]);
  });

  it("handles backslash escapes inside E'…' strings", () => {
    const out = splitSqlStatements("SELECT E'a\\';b'; SELECT 2");
    expect(out).toEqual(["SELECT E'a\\';b'", "SELECT 2"]);
  });

  it("does NOT split on semicolons inside line comments", () => {
    const out = splitSqlStatements("SELECT 1; -- trailing ; comment\nSELECT 2");
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("SELECT 1");
    expect(out[1]).toContain("SELECT 2");
  });

  it("does NOT split on semicolons inside block comments (incl. nested)", () => {
    const out = splitSqlStatements(
      "SELECT 1; /* outer ; /* inner ; */ still ; */ SELECT 2",
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("SELECT 1");
    expect(out[1]).toContain("SELECT 2");
  });
});

describe("splitSqlStatements — real 0001_v3_complete_baseline.sql", () => {
  const baseline = readFileSync(join(MIGRATIONS_DIR, "0001_v3_complete_baseline.sql"), "utf8");

  it("is marked no-transaction", () => {
    expect(baseline).toMatch(/--\s*migrate:no-transaction/i);
  });

  it("splits the plpgsql function bodies (AS $$ … $$) as whole single statements", () => {
    const out = splitSqlStatements(baseline);
    // The squash file contains CREATE FUNCTION ... AS $$ ... $$; blocks.
    const fnBlocks = out.filter((s) => /\bCREATE\s+FUNCTION\b/i.test(s));
    // There are multiple plpgsql functions in the baseline.
    expect(fnBlocks.length).toBeGreaterThanOrEqual(3);
    // None got chopped at an internal semicolon: each must contain its function body
    // (BEGIN ... END) and close with the dollar-quote tag (e.g. $$ or $_$).
    for (const b of fnBlocks) {
      // Every function block ends with a dollar-quote closing tag at statement end
      expect(b).toMatch(/\$[^$]*\$;?\s*$/);
    }
  });

  it("round-trips: all CREATE TABLE statements are preserved as separate entries", () => {
    const out = splitSqlStatements(baseline);
    const rawCount = (baseline.match(/\bCREATE TABLE\b/gi) ?? []).length;
    const splitCount = out.reduce(
      (acc, s) => acc + (s.match(/\bCREATE TABLE\b/gi) ?? []).length,
      0,
    );
    expect(splitCount).toBe(rawCount);
  });

  it("produces no statement that bundles multiple CREATE TABLE definitions", () => {
    const out = splitSqlStatements(baseline);
    const bundled = out.filter(
      (s) => (s.match(/\bCREATE TABLE\b/gi) ?? []).length > 1,
    );
    expect(bundled).toEqual([]);
  });
});

describe("splitSqlStatements — every no-transaction migration round-trips", () => {
  const noTxFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .filter((f) =>
      /--\s*migrate:no-transaction/i.test(
        readFileSync(join(MIGRATIONS_DIR, f), "utf8"),
      ),
    );

  it("finds the marked files (sanity)", () => {
    expect(noTxFiles.length).toBeGreaterThan(0);
  });

  for (const f of noTxFiles) {
    it(`splits ${f} without bundling CONCURRENTLY builds`, () => {
      const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      const out = splitSqlStatements(text);
      // Concatenating the split statements must preserve every CONCURRENTLY
      // build (none lost, none merged).
      const rawCount = (text.match(/CREATE INDEX CONCURRENTLY/g) ?? []).length;
      const splitCount = out.reduce(
        (acc, s) => acc + (s.match(/CREATE INDEX CONCURRENTLY/g) ?? []).length,
        0,
      );
      expect(splitCount).toBe(rawCount);
      // No single statement bundles two CONCURRENTLY builds.
      for (const s of out) {
        expect(
          (s.match(/CREATE INDEX CONCURRENTLY/g) ?? []).length,
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});
