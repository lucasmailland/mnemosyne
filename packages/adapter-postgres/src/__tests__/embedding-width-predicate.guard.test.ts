import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard: every cosine query must constrain vector width.
 *
 * P118. Embedding columns are dimensionless `halfvec` on purpose (migration
 * 0009, multi-dimension support), which lets rows of different widths coexist —
 * and pgvector cannot compare two vectors of different widths. It does not
 * return a bad score, it raises `different halfvec dimensions N and M` and the
 * statement dies. So the first similarity query after an embedding-model change
 * throws, and keeps throwing until the whole corpus is re-embedded.
 *
 * Three of the seven cosine queries already knew this and carried a
 * `vector_dims(...)` predicate: PgVectorAdapter's fact search (with a comment
 * describing the exact error) and FactRepository's query cache. The other four
 * — episodes, entities, decisions, reasoning — plus the fact↔fact neighbour
 * join did not. The one over episodes is how it was found: it took down the
 * episodic collapse and cost the episode (P109).
 *
 * Same shape as the P111 guards: the mechanism existed, correct and documented,
 * in a minority of the places that needed it. A comment in one file cannot stop
 * the eighth query from being written without it. This can.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCAN_DIRS = [join(ROOT, "adapter-postgres", "src"), join(ROOT, "adapter-vector", "src")];

/** Satisfies the guard: any of these in the same SQL template as the `<=>`. */
const WIDTH_PREDICATES = ["vector_dims", "sameWidthAsQuery", "sameWidthAsEachOther"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.includes(".test."))
      out.push(full);
  }
  return out;
}

/**
 * Comments are removed before anything else, and that is load-bearing twice
 * over. These files discuss SQL in prose, with backticks around the fragments —
 * PgVectorAdapter's own explanation of this very predicate quotes
 * `vector_dims(embedding) = N` — so leaving comments in (a) flips the backtick
 * parity and misaligns every region after them, and (b) would let a query
 * satisfy the guard on the strength of a comment ABOUT the predicate rather
 * than the predicate. The second is the dangerous one: it is exactly how a
 * guard ends up reading as protection while protecting nothing.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Split a source file into backtick-delimited template regions. Only regions
 * containing `<=>` are ever examined, so non-SQL templates are irrelevant —
 * which keeps this from needing a TypeScript parser to be correct.
 */
function templateRegions(src: string): string[] {
  const regions: string[] = [];
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf("`", i);
    if (start === -1) break;
    let j = start + 1;
    while (j < src.length && !(src[j] === "`" && src[j - 1] !== "\\")) j++;
    regions.push(src.slice(start + 1, j));
    i = j + 1;
  }
  return regions;
}

function offenders(): string[] {
  const found: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(dir)) {
      const src = stripComments(readFileSync(file, "utf8"));
      if (!src.includes("<=>")) continue;
      for (const region of templateRegions(src)) {
        if (!region.includes("<=>")) continue;
        if (WIDTH_PREDICATES.some((p) => region.includes(p))) continue;
        const line =
          region
            .split("\n")
            .find((l) => l.includes("<=>"))
            ?.trim() ?? "<=>";
        found.push(`${relative(ROOT, file)} — cosine query with no width predicate: ${line}`);
      }
    }
  }
  return found.sort();
}

describe("embedding width predicate guard (P118)", () => {
  it("every cosine query constrains vector width", () => {
    expect(offenders()).toEqual([]);
  });

  it("the scanner actually detects a missing predicate", () => {
    // Without this, a scanner that silently matches nothing would pass forever
    // and read as protection. The two snippets differ ONLY by the predicate.
    const violating = templateRegions(
      "const q = sql`SELECT id FROM t WHERE embedding IS NOT NULL ORDER BY embedding <=> $1`;"
    );
    const compliant = templateRegions(
      "const q = sql`SELECT id FROM t WHERE vector_dims(embedding) = 3 ORDER BY embedding <=> $1`;"
    );

    const detects = (regions: string[]) =>
      regions.some((r) => r.includes("<=>") && !WIDTH_PREDICATES.some((p) => r.includes(p)));

    expect(detects(violating)).toBe(true);
    expect(detects(compliant)).toBe(false);

    // And a predicate that exists only in PROSE must NOT satisfy it.
    const commentOnly = templateRegions(
      stripComments(
        "// we rely on vector_dims(embedding) = N here\n" +
          "const q = sql`SELECT id FROM t ORDER BY embedding <=> $1`;"
      )
    );
    expect(detects(commentOnly)).toBe(true);
  });

  it("finds the cosine queries it is supposed to be watching", () => {
    // A path typo would make SCAN_DIRS empty and the first test vacuous.
    const scanned = SCAN_DIRS.flatMap((d) => sourceFiles(d))
      .map((f) => stripComments(readFileSync(f, "utf8")))
      .filter((s) => s.includes("<=>")).length;
    expect(scanned).toBeGreaterThanOrEqual(6);
  });
});
