/**
 * Top-level SQL statement splitter.
 *
 * WHY THIS EXISTS
 * ---------------
 * Migrations marked `-- migrate:no-transaction` (required by the
 * migration-safety linter for anything containing `CREATE INDEX
 * CONCURRENTLY`) cannot run as a single multi-statement string: psql/
 * postgres-js send that as one simple-query batch, which Postgres wraps
 * in an implicit transaction, and `CREATE INDEX CONCURRENTLY` is rejected
 * inside any transaction block. The fix is to split such a file into its
 * individual top-level statements and run each one on its own — every
 * `CREATE INDEX CONCURRENTLY` then executes as a standalone simple query
 * with no surrounding transaction.
 *
 * Splitting on a naive `;` is wrong: the baseline migration (0001) defines
 * PL/pgSQL via `DO $$ … $$;` blocks whose bodies contain `;`, and CHECK
 * constraints embed `;`-free but quote-bearing string literals. This
 * splitter is therefore aware of:
 *   • dollar-quoted blocks  — `$$ … $$` and `$tag$ … $tag$` (tags must
 *     match exactly; a `;` inside is part of the body, never a separator).
 *   • single-quoted string literals — `'…'`, including the SQL-standard
 *     doubled-quote escape `''` and backslash escapes inside `E'…'`.
 *   • line comments — `-- …` to end of line.
 *   • block comments — `/* … *​/`, which Postgres allows to nest.
 *
 * It returns the trimmed, non-empty statements in order, WITHOUT the
 * trailing `;` (postgres-js's `unsafe()` runs a single statement fine
 * with or without it, and dropping it keeps the executed text minimal).
 *
 * DRY NOTE: a byte-identical copy lives in
 * `packages/core/src/cli/migrate.ts`. The core CLI is published to npm as
 * a standalone artifact that deliberately avoids importing this package
 * (adapter-postgres is not a dependency of core), so the function is
 * duplicated rather than imported. If you change one, change the other —
 * both are exercised against real Postgres by the integration suites.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    // Line comment: -- … (consume to end of line, keep it in the buffer so
    // the emitted statement text round-trips, but never treat its `;` as a
    // separator).
    if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comment: /* … */ with Postgres-style nesting.
    if (ch === "/" && next === "*") {
      let depth = 1;
      current += "/*";
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && i + 1 < n && sql[i + 1] === "*") {
          depth += 1;
          current += "/*";
          i += 2;
        } else if (sql[i] === "*" && i + 1 < n && sql[i + 1] === "/") {
          depth -= 1;
          current += "*/";
          i += 2;
        } else {
          current += sql[i];
          i += 1;
        }
      }
      continue;
    }

    // Single-quoted string literal: '…'. Handles the standard doubled-quote
    // escape ('' -> literal '). An immediately-preceding E/e (E'…') enables
    // backslash escaping, so a backslash there escapes the next char.
    if (ch === "'") {
      const escapesBackslash = current.length > 0 && /[Ee]$/.test(current);
      current += ch;
      i += 1;
      while (i < n) {
        const c = sql[i];
        if (escapesBackslash && c === "\\" && i + 1 < n) {
          current += c + sql[i + 1];
          i += 2;
          continue;
        }
        if (c === "'") {
          if (i + 1 < n && sql[i + 1] === "'") {
            // Doubled quote — an escaped ' that stays inside the literal.
            current += "''";
            i += 2;
            continue;
          }
          current += "'";
          i += 1;
          break; // end of string literal
        }
        current += c;
        i += 1;
      }
      continue;
    }

    // Dollar-quoted block: $$ … $$ or $tag$ … $tag$. A `$` only opens a
    // dollar quote when it is immediately followed by an optional tag of
    // word characters and a closing `$`. Otherwise it's an ordinary char
    // (e.g. a positional param like $1, which never appears in raw DDL but
    // must not be mistaken for a quote opener).
    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length);
        const end = closeIdx === -1 ? n : closeIdx + tag.length;
        current += sql.slice(i, end);
        i = end;
        continue;
      }
      // Not a dollar-quote opener — fall through and treat `$` literally.
    }

    // Statement separator.
    if (ch === ";") {
      pushIfSql(statements, current);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  // Trailing statement with no terminating ';' (a final comment-only or
  // whitespace-only tail contains no SQL and is dropped).
  pushIfSql(statements, current);

  return statements;
}

/**
 * Push `fragment` (trimmed) onto `out` only if it contains real SQL — i.e.
 * something remains after stripping comments and whitespace. A fragment that
 * is purely comments (e.g. a trailing `-- note` with no following statement)
 * is a no-op to execute and is dropped. The ORIGINAL fragment text (including
 * any leading comment, which is valid before a statement) is what gets pushed.
 */
function pushIfSql(out: string[], fragment: string): void {
  const trimmed = fragment.trim();
  if (trimmed.length === 0) return;
  if (stripComments(trimmed).trim().length === 0) return;
  out.push(trimmed);
}

/** Remove `-- …` line comments and `/* … *​/` (nesting-aware) block comments. */
function stripComments(s: string): string {
  let result = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    const next = i + 1 < n ? s[i + 1] : "";
    if (ch === "-" && next === "-") {
      const eol = s.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (s[i] === "/" && i + 1 < n && s[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (s[i] === "*" && i + 1 < n && s[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }
    // A string/dollar-quote body always contains SQL "content", so once we hit
    // a quote we can stop — there is real SQL here.
    if (ch === "'" || ch === "$") {
      return s.slice(i); // non-empty → caller treats fragment as real SQL
    }
    result += ch;
    i += 1;
  }
  return result;
}

/**
 * If position `i` in `sql` is the start of a dollar-quote tag
 * (`$$` or `$tag$`, where tag matches /[A-Za-z_][A-Za-z0-9_]*​/), return
 * the full tag text (including both `$`); otherwise return null.
 */
function matchDollarTag(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  // Optional tag identifier.
  const first = sql[j];
  if (first !== undefined && /[A-Za-z_]/.test(first)) {
    j += 1;
    let c = sql[j];
    while (c !== undefined && /[A-Za-z0-9_]/.test(c)) {
      j += 1;
      c = sql[j];
    }
  }
  // Must be closed by a second `$` to be a valid tag.
  if (sql[j] === "$") {
    return sql.slice(i, j + 1);
  }
  return null;
}
