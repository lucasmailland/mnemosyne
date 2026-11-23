import { sql, type SQL } from "drizzle-orm";

/**
 * P131 B1 — the single name for the full-text search configuration.
 *
 * Both halves of full-text search have to agree, and for a long time they did
 * not: every generated `text_lemmatized` column indexed with
 * `to_tsvector('english', …)` while three `FactRepository` sites queried with
 * `plainto_tsquery('simple', …)`. Measured on pg17:
 *
 *   to_tsvector('english','los mensajes se guardan cifrados')
 *     @@ plainto_tsquery('simple','mensajes cifrados')   →  FALSE
 *
 * The lexemes never met — `'english'` stems mensajes→mensaj, `'simple'` does
 * not. It cost `findContradictingFacts` the ability to see a contradiction it
 * was looking straight at (P130's first cause).
 *
 * The disagreement was possible because there was nothing to disagree WITH:
 * each call site spelled the configuration as its own string literal, and no
 * two literals were ever compared. This constant is that missing thing. The
 * configuration itself is created by migration
 * `0035_p131_unaccent_fts_config.sql` and is `english` plus `unaccent`.
 *
 * Schema-qualified on purpose: `search_path` is set per connection, and a bare
 * name that resolves differently between the migrate role and the app role
 * would reintroduce exactly the split this is here to close.
 */
export const FTS_CONFIG = "mnemosyne.mnemo_fts";

/**
 * The configuration as a SQL fragment, for interpolation into `to_tsvector` /
 * `plainto_tsquery` calls: `plainto_tsquery(${ftsConfig()}, ${text})`.
 *
 * A function rather than a shared constant so each call site gets its own
 * chunk, and `sql.raw` rather than a bound parameter because a regconfig is
 * part of the statement, not a value — a `$1` there is a syntax error. That is
 * safe here and only here: {@link FTS_CONFIG} is a compile-time literal, never
 * anything that reached us from a caller.
 */
export const ftsConfig = (): SQL => sql.raw(`'${FTS_CONFIG}'`);

/**
 * P131 B3 — the Spanish-stemmed twin, created by migration `0036`.
 *
 * One configuration cannot serve two languages: chaining the stemmers is the
 * manual's recipe and does not work, because `ts_lexize('spanish_stem',
 * 'running')` returns `{running}` — non-NULL, so the chain stops and
 * `english_stem` never runs. Every row is therefore indexed BOTH ways
 * (`text_lemmatized` and `text_lemmatized_es`) and queries OR the two arms,
 * each under its own configuration. No language detection: a per-row
 * `language` column was the alternative, and it adds a classifier that is
 * silently wrong when it guesses badly while buying nothing measurable.
 *
 * Measured on eight hard Spanish cases (verb morphology, where the English
 * stemmer's accidental handling of `-s`/`-es` plurals stops helping):
 * English alone matched 1, Spanish alone 4, the two ORed 5. Spanish is better
 * on average and English still wins a case, so neither can simply replace the
 * other.
 */
export const FTS_CONFIG_ES = "mnemosyne.mnemo_fts_es";

/** {@link FTS_CONFIG_ES} as a SQL fragment. See {@link ftsConfig}. */
export const ftsConfigEs = (): SQL => sql.raw(`'${FTS_CONFIG_ES}'`);

/** Normalized query lexemes in both indexed languages for recall term deduplication. */
export function ftsTermLexemes(term: SQL): { en: SQL; es: SQL } {
  return {
    en: sql`plainto_tsquery(${ftsConfig()}, ${term})::text`,
    es: sql`plainto_tsquery(${ftsConfigEs()}, ${term})::text`,
  };
}

/**
 * P131 B3 — "this text matches, in either language".
 *
 * Both arms keep AND semantics inside themselves (`plainto_tsquery` ANDs its
 * terms); the OR is only between the two LANGUAGES. That distinction is
 * load-bearing: replacing the inner AND with OR was measured again while
 * building this and is still unsafe, because the English arm keeps Spanish
 * stopwords ('el', 'de', 'es') as indexed terms and an OR query matches
 * unrelated rows through them. P130 is closed by cosine candidates, so nothing
 * needs the inner OR.
 *
 * Takes the two columns as fragments rather than naming them, because the call
 * sites disagree about how they refer to columns — some hold a Drizzle column
 * reference, some are inside raw SQL over a table chosen at runtime.
 */
export function ftsMatchesEither(en: SQL, es: SQL, text: SQL | string): SQL {
  return sql`(${en} @@ plainto_tsquery(${ftsConfig()}, ${text}) OR ${es} @@ plainto_tsquery(${ftsConfigEs()}, ${text}))`;
}

/**
 * Rank under whichever language matched better.
 *
 * GREATEST rather than a sum: the arms are two readings of the SAME text, not
 * two pieces of evidence. Adding them would score a row that happens to stem
 * alike in both languages above a row that matches one of them well, which is
 * an artefact of the indexing scheme rather than anything about relevance.
 */
export function ftsRankEither(en: SQL, es: SQL, text: SQL | string): SQL {
  return sql`GREATEST(ts_rank(${en}, plainto_tsquery(${ftsConfig()}, ${text})), ts_rank(${es}, plainto_tsquery(${ftsConfigEs()}, ${text})))`;
}

/** `ts_rank_cd` variant of {@link ftsRankEither}, for the sites that use it. */
export function ftsRankCdEither(en: SQL, es: SQL, text: SQL | string): SQL {
  return sql`GREATEST(ts_rank_cd(${en}, plainto_tsquery(${ftsConfig()}, ${text})), ts_rank_cd(${es}, plainto_tsquery(${ftsConfigEs()}, ${text})))`;
}
