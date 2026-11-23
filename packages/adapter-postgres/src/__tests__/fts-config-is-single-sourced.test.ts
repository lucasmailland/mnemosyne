/**
 * P131 B1 — both halves of full-text search name the SAME configuration.
 *
 * They did not, for a long time, and nothing noticed. Every generated
 * `text_lemmatized` column indexed with `to_tsvector('english', …)` while three
 * `FactRepository` sites queried with `plainto_tsquery('simple', …)`. Measured
 * on pg17:
 *
 *   to_tsvector('english','los mensajes se guardan cifrados')
 *     @@ plainto_tsquery('simple','mensajes cifrados')   →  FALSE
 *
 * `'english'` stems mensajes→mensaj and `'simple'` does not, so the lexemes
 * never met. `findContradictingFacts` could not see a contradiction it was
 * looking straight at — the first of P130's two causes.
 *
 * WHY A FILE-SCANNING TEST AND NOT A UNIT TEST: the defect is not in any one
 * function's behaviour. Each site was individually correct and internally
 * consistent; the bug lived in the RELATIONSHIP between two files that never
 * referenced each other. Nothing short of comparing them can catch that, and a
 * runtime test cannot — with mismatched configs the query returns zero rows,
 * which is indistinguishable from "no matches" on any fixture that does not
 * already know the right answer.
 *
 * This scans source text instead. Coarse on purpose: it cannot prove the
 * configuration is GOOD (that is B3's question), only that there is exactly one
 * of it and everyone spells it the same way.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FTS_CONFIG, ftsConfig } from "../repositories/_fts-config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const MIGRATIONS = join(HERE, "..", "..", "migrations", "baseline");

/** Every .ts under src/, except the constant's own file (its docstring quotes the historical literals). */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "testing") sourceFiles(full, acc);
    } else if (entry.name.endsWith(".ts") && entry.name !== "_fts-config.ts") {
      acc.push(full);
    }
  }
  return acc;
}

describe("P131 B1 — there is exactly one FTS configuration name", () => {
  it("no source file hardcodes a text-search config in a tsquery or to_tsvector call", () => {
    // THE regression guard. A new call site that spells its own literal is
    // exactly how the original split happened, and it would pass every other
    // test in the suite.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
        if (
          /(?:plainto_|websearch_to_|phraseto_)?tsquery\('/.test(line) ||
          /to_tsvector\('/.test(line)
        ) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `hardcoded FTS config — use ftsConfig() from _fts-config.ts:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the migration creates the configuration the constant names", () => {
    // The other direction: the constant could be renamed while the migration
    // still creates the old name, which fails only at runtime and only on a
    // query that returns zero rows.
    const migration = readFileSync(join(MIGRATIONS, "0035_p131_unaccent_fts_config.sql"), "utf8");
    expect(migration).toContain(`CREATE TEXT SEARCH CONFIGURATION ${FTS_CONFIG}`);
    expect(migration).toContain(`ALTER TEXT SEARCH CONFIGURATION ${FTS_CONFIG}`);
  });

  it("every generated tsvector column in that migration uses it — none left behind", () => {
    // Ten tables carry a text_lemmatized column. One missed table is a silently
    // split index: half the rows lemmatised one way, half the other.
    const migration = readFileSync(join(MIGRATIONS, "0035_p131_unaccent_fts_config.sql"), "utf8");
    const setExpressions = migration.match(/SET EXPRESSION AS \(to_tsvector\(([^,]+),/g) ?? [];

    expect(setExpressions.length).toBe(10);
    for (const expr of setExpressions) {
      expect(expr, `a SET EXPRESSION does not use ${FTS_CONFIG}`).toContain(
        `'${FTS_CONFIG}'::regconfig`
      );
    }
  });

  it("no LATER migration reintroduces a bare config in a generated column", () => {
    // 0035 aligns what exists today. Nothing stops migration 0036 from adding
    // an eleventh table with to_tsvector('english', …) and quietly recreating
    // the split — this is the check that would fail when it does.
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && /^00(3[6-9]|[4-9]\d)/.test(f))
      .sort();

    const offenders: string[] = [];
    for (const file of later) {
      const text = readFileSync(join(MIGRATIONS, file), "utf8");
      for (const m of text.match(/to_tsvector\('(\w+)'/g) ?? []) {
        if (!m.includes(FTS_CONFIG)) offenders.push(`${file}: ${m}`);
      }
    }
    expect(offenders, `migration adds an unaligned FTS config:\n${offenders.join("\n")}`).toEqual(
      []
    );
  });

  it("ftsConfig() emits a quoted, schema-qualified regconfig literal", () => {
    // Schema-qualified because search_path differs between the migrate role and
    // the app role; quoted because a regconfig is part of the statement, not a
    // bindable value.
    const chunks = JSON.stringify(ftsConfig());
    expect(chunks).toContain(`'${FTS_CONFIG}'`);
    expect(FTS_CONFIG).toMatch(/^mnemosyne\./);
  });
});
