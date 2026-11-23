/**
 * P131 B3 — every row is indexed in BOTH languages, and queries OR the arms.
 *
 * One text-search configuration cannot serve two languages. The manual's recipe
 * — chain `spanish_stem` and `english_stem` — does not work, and the reason is
 * measurable: `ts_lexize('spanish_stem', 'running')` returns `{running}`, which
 * is non-NULL, so the dictionary chain stops there and `english_stem` never
 * runs. Chaining silently costs English its stemming.
 *
 * MEASURED BEFORE BUILDING, because the easy cases said this was not worth
 * doing. On simple Spanish — plurals, accents — the English configuration
 * already matched everything: `english_stem` strips `-s`/`-es`, which covers
 * the commonest Spanish inflection by coincidence, and 0035's `unaccent` covers
 * the accents. The gap only opens on verb morphology:
 *
 *   corriendo/corre, correr/corren, guardar/guardamos, almacenamiento/almacena
 *     → English 0/4, Spanish 4/4
 *   configuracion/configuraciones
 *     → English 1/1, Spanish 0/1
 *
 * English alone matched 1 of 8, Spanish alone 4, the two ORed 5. Neither can
 * replace the other, which is why this adds a column rather than switching one.
 *
 * These tests read source and migrations rather than running SQL: the
 * behavioural half needs Postgres and lives in the integration suite, and the
 * failure this guards against — one arm quietly missing from a call site — is a
 * structural drift that a behavioural test with both arms present cannot see.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FTS_CONFIG, FTS_CONFIG_ES } from "../repositories/_fts-config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const MIGRATION = join(REPO, "migrations", "baseline", "0036_p131_b3_spanish_fts_column.sql");

const repo = (f: string) => readFileSync(join(REPO, "src", "repositories", f), "utf8");

describe("P131 B3 — the Spanish arm exists and is distinct", () => {
  it("names a different configuration from the English one", () => {
    expect(FTS_CONFIG_ES).not.toBe(FTS_CONFIG);
    expect(FTS_CONFIG_ES).toMatch(/^mnemosyne\./);
  });

  it("the migration builds it from `spanish`, not from `english`", () => {
    // COPY = english would produce a second column identical to the first: two
    // indexes, twice the writes, and zero new matches.
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(`CREATE TEXT SEARCH CONFIGURATION ${FTS_CONFIG_ES} (COPY = spanish)`);
    expect(sql).toContain("WITH unaccent, spanish_stem");
  });

  it("covers the same ten tables 0035 aligned — a missed table is a blind spot", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const added = sql.match(/ADD COLUMN IF NOT EXISTS text_lemmatized_es/g) ?? [];
    expect(added).toHaveLength(10);
  });

  it("indexes every column it queries", () => {
    // mnemo_fact_archive is the deliberate exception: it is not a recall source
    // and has no English FTS index either, so a Spanish one would index rows
    // nothing reads.
    const sql = readFileSync(MIGRATION, "utf8");
    const indexes = sql.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_\w+_fts_es/g) ?? [];
    expect(indexes).toHaveLength(9);
    expect(sql).not.toContain("idx_mnemo_fact_archive_fts_es");
  });
});

describe("P131 B3 — no call site queries only one arm", () => {
  /**
   * The failure mode this exists for. A site that keeps only the English arm
   * still returns results, still passes every behavioural test, and silently
   * loses the Spanish matches the column was added for.
   */
  for (const file of ["RecallRepository.ts", "FactRepository.ts"]) {
    it(`${file} pairs every text_lemmatized use with the _es twin`, () => {
      const src = repo(file);
      // Every arm goes through the shared helpers, so a bare tsquery against
      // one column is the drift.
      const bare = src
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
        .filter((l) => /plainto_tsquery\(/.test(l));

      expect(
        bare,
        `${file} builds a tsquery outside the shared helpers:\n${bare.join("\n")}`
      ).toEqual([]);
    });
  }

  it("the helpers themselves query both configurations", () => {
    const src = repo("_fts-config.ts");
    const helpers = src.slice(src.indexOf("export function ftsMatchesEither"));
    expect(helpers).toContain("ftsConfig()");
    expect(helpers).toContain("ftsConfigEs()");
  });

  it("ranking takes the better arm, never the sum", () => {
    // The arms are two readings of the SAME text, not two pieces of evidence.
    // Summing would rank a row that stems alike in both languages above one
    // that matches a single language well — an artefact of the scheme, not
    // relevance.
    const src = repo("_fts-config.ts");
    expect(src).toContain("GREATEST(ts_rank(");
    expect(src).toContain("GREATEST(ts_rank_cd(");
  });

  it("the language OR does NOT become an OR between terms", () => {
    // P130's rejected fix, re-measured while building this and still unsafe:
    // the English arm keeps Spanish stopwords as indexed terms, so a
    // term-level OR matches unrelated rows through 'el'/'de'/'es'. Both arms
    // must keep plainto_tsquery's inner AND.
    const src = repo("_fts-config.ts");
    expect(src).not.toContain("websearch_to_tsquery");
    expect(src).not.toMatch(/replace\([^)]*' & '/);
  });
});

describe("P131 B3 — the schema exposes the column the queries reference", () => {
  it("drizzle declares textLemmatizedEs wherever it declares textLemmatized", () => {
    // A query referencing schema.<table>.textLemmatizedEs against a table that
    // does not declare it is a compile error — but only for the tables the
    // queries touch. This checks the pairing directly.
    const dir = join(REPO, "src", "schema");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, file), "utf8");
      const en = (src.match(/textLemmatized: tsvector/g) ?? []).length;
      const es = (src.match(/textLemmatizedEs: tsvector/g) ?? []).length;
      expect(es, `${file} declares ${en} English columns and ${es} Spanish ones`).toBe(en);
    }
  });
});
