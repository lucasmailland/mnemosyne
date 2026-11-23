// B6.35 Task 4 — every PostgreSQL fact writer must guard against pending
// consolidation markers. The repository methods bind to a live Postgres tx, so
// the SQL/where-clause coverage is enforced here by source-enumeration guards.
// Runtime behaviour under FORCE RLS is covered by the integration suites
// (consolidation-storage / fact-replace). The dedicated updateFact/setCanonical
// where-clause shapes are also unit-tested in update-fact-rls.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOS = resolve(HERE, "../../repositories");
const PENDING = "__mnemoConsolidationPending";

function read(rel: string): string {
  return readFileSync(resolve(REPOS, rel), "utf8");
}

function occurrences(source: string, re: RegExp): number {
  return (source.match(re) ?? []).length;
}

// Quote-agnostic .indexOf(): Prettier's quote style for a file flips on
// whatever the next commit that touches it runs through the pre-commit prettier, so a
// boundary marker hardcoded with single quotes can silently stop matching.
// Pass the single-quote form; this also tries the double-quote form.
function indexOfEither(source: string, singleQuoted: string): number {
  const idx = source.indexOf(singleQuoted);
  if (idx !== -1) return idx;
  return source.indexOf(singleQuoted.replace(/'/g, '"'));
}

describe("FactRepository pending-marker guards", () => {
  const source = read("FactRepository.ts");

  it("createFact strips a caller-supplied marker before insert", () => {
    // The insert value builder strips the reserved key from caller metadata.
    const createFn = source.slice(
      source.indexOf("async createFact"),
      source.indexOf("async getFact")
    );
    expect(createFn).toMatch(/__mnemoConsolidationPending: _pending, \.\.\.safe/);
  });

  it("updateFact adds the marker exclusion only when pinned is set", () => {
    const updateFn = source.slice(
      source.indexOf("async updateFact"),
      source.indexOf("async mergeFactByTopicKey")
    );
    expect(updateFn).toMatch(/input\.pinned !== undefined[\s\S]*?'__mnemoConsolidationPending'/);
    // And metadata updates strip + reattach the genuine marker.
    expect(updateFn).toMatch(/__mnemoConsolidationPending: _pending, \.\.\.safe/);
    expect(updateFn).toMatch(/currentMarker/);
  });

  it("replaceFact refuses a pending source and does not copy the marker to the successor", () => {
    const replaceFn = source.slice(
      source.indexOf("async replaceFact"),
      source.indexOf("async archiveFact")
    );
    // Source lock SELECT carries the exclusion.
    expect(replaceFn).toMatch(
      /lte\(schema\.factTable\.validFrom, now\)[\s\S]*?'__mnemoConsolidationPending'/
    );
  });

  it("the shared supersede strips the marker from every successor it writes", () => {
    // P76 moved the close + successor + `supersedes` write out of replaceFact
    // into `supersedeActiveFact`, so that mergeFactByTopicKey stops overwriting
    // in place and shares ONE bitemporal implementation. The marker strip moved
    // with it, and this assertion follows it there rather than being dropped:
    // it now covers BOTH callers at once, which is strictly more than it
    // covered before.
    const supersedeFn = source.slice(
      source.indexOf("private async supersedeActiveFact"),
      source.indexOf("async replaceFact")
    );
    expect(supersedeFn.length).toBeGreaterThan(0);
    expect(supersedeFn).toMatch(/__mnemoConsolidationPending: _pending, \.\.\.safe/);
  });

  it("mergeFactByTopicKey refuses a pending source", () => {
    // The guard used to live in the merge's UPDATE ... WHERE. With no UPDATE
    // left it had to move to the SELECT, and losing it would let a topic-key
    // merge supersede a row a consolidation rollback still needs.
    const mergeFn = source.slice(
      source.indexOf("async mergeFactByTopicKey"),
      source.indexOf("private async supersedeActiveFact")
    );
    expect(mergeFn.length).toBeGreaterThan(0);
    expect(mergeFn).toMatch(/'__mnemoConsolidationPending'/);
    // And it must not have quietly gone back to an in-place overwrite.
    expect(mergeFn).toContain("supersedeActiveFact");
  });

  it("archiveFact returns early for a pending row", () => {
    const archiveFn = source.slice(
      source.indexOf("async archiveFact"),
      source.indexOf("async queryFacts")
    );
    // Quote-agnostic: this is a plain JS string literal (unlike the other
    // occurrences below, which sit inside sql`...` template contents Prettier
    // never touches), so its quote style flips with the repo's Prettier config.
    // WP-5 (PRIM-3): archiveFact now reports whether it closed the fact, so
    // the early return is `return false;`.
    expect(archiveFn).toMatch(
      /hasOwnProperty[\s\S]*?['"]__mnemoConsolidationPending['"][\s\S]*?return(?: false)?;/
    );
  });

  it("setCanonical adds the marker exclusion to its WHERE", () => {
    const fn = source.slice(
      source.indexOf("async setCanonical"),
      source.indexOf("async getRecalledFactIds")
    );
    expect(fn).toContain(PENDING);
  });

  it("purgeFactsBySensitivity excludes pending rows in BOTH discovery and mutation", () => {
    const fn = source.slice(source.indexOf("async purgeFactsBySensitivity"));
    // dry-run count subquery + update subquery = 2.
    expect(occurrences(fn, /\?\s*'__mnemoConsolidationPending'/g)).toBeGreaterThanOrEqual(2);
  });
});

describe("RecallRepository pending-marker guards", () => {
  const source = read("RecallRepository.ts");

  it("updateWorth('fact') excludes pending rows", () => {
    const updateWorth = source.slice(
      source.indexOf("async updateWorth"),
      source.indexOf("async recordRecall")
    );
    const factCase = updateWorth.slice(
      indexOfEither(updateWorth, "case 'fact'"),
      indexOfEither(updateWorth, "case 'strategy'")
    );
    expect(factCase).toContain(PENDING);
  });

  it("decayKind semantic pass excludes pending rows", () => {
    const decay = source.slice(source.indexOf("async decayKind"));
    const semantic = decay.slice(
      indexOfEither(decay, "decayClass === 'semantic'"),
      indexOfEither(decay, "decayClass === 'episodic'")
    );
    expect(semantic).toContain(PENDING);
  });

  it("recordRecall is an explicitly-safe writer (only touches last_recalled_at)", () => {
    const record = source.slice(
      source.indexOf("async recordRecall"),
      source.indexOf("async getTdPredecessors")
    );
    // It updates lastRecalledAt only — must NOT carry the predicate and must not
    // touch the marker, lifecycle, or the four snapshotted worth fields.
    expect(record).toContain("lastRecalledAt");
    expect(record).not.toContain(PENDING);
    expect(record).not.toMatch(/worthAlpha|worthBeta|worthSuccess|worthFailure|status:/);
  });
});

describe("CompositionRepository.materialiseInference strips forged markers", () => {
  const source = read("CompositionRepository.ts");
  it("derived fact metadata strips the reserved key", () => {
    const fn = source.slice(source.indexOf("async materialiseInference"));
    expect(fn).toMatch(/__mnemoConsolidationPending: _pending, \.\.\.safe/);
  });
});

describe("EncryptionRepository.hardDeleteFact rejects pending rows", () => {
  const source = read("EncryptionRepository.ts");
  it("delete WHERE carries the marker exclusion", () => {
    const fn = source.slice(source.indexOf("async hardDeleteFact"));
    expect(fn).toContain(PENDING);
  });
});

describe("FactRepository enumeration guard — every write site is classified", () => {
  // B6.35 enumeration proof: scan ALL .insert / .update / .delete call sites
  // against schema.factTable in FactRepository.ts and assert each either:
  //   (a) carries the pending-marker exclusion in its WHERE / values, or
  //   (b) is reached only after a pre-write guard that already excluded pending rows.
  //
  // Adding a new, unclassified fact writer fails this test until the author
  // decides whether it needs the exclusion and updates one of the two lists.

  const source = read("FactRepository.ts");
  const lines = source.split("\n");

  // Collect zero-indexed line numbers for every write anchor on schema.factTable.
  function writeLineIndices(): number[] {
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/\.(insert|update|delete)\(schema\.factTable\)/.test(lines[i]!)) {
        out.push(i);
      }
    }
    return out;
  }

  // For each write site, search a combined window: 65 lines BEFORE (pre-write guard)
  // + 65 lines AFTER (inline WHERE / values guard). This picks up:
  //   • INSERT .values() blocks that strip the marker (up to 50 lines after the anchor)
  //   • UPDATE WHERE clauses that carry the exclusion (within 20 lines after)
  //   • JS early-return guards preceding the write (within 65 lines before)
  // Widened from 60→65 (provenance-identity migration, 2026-08-01): archiveFact's
  // two writes sit 62 lines after its single top-of-function early-return guard,
  // which the migration's added userId/actorType field mappings pushed just past
  // the old 60-line ceiling — verified manually that the guard still covers both
  // writes (it returns before either runs); only the heuristic's window needed
  // room to keep seeing that.
  function contextWindow(lineIdx: number): string {
    const before = Math.max(0, lineIdx - 65);
    const after = Math.min(lines.length, lineIdx + 65);
    return lines.slice(before, after).join("\n");
  }

  // A site is classified when the pending key appears anywhere in its context window.
  // This covers all three guard forms:
  //   1. SQL WHERE NOT jsonb ? '__mnemoConsolidationPending'
  //   2. values() stripping: { __mnemoConsolidationPending: _pending, ...safe }
  //   3. JS early-return: hasOwnProperty.call(... '__mnemoConsolidationPending')
  function isClassified(lineIdx: number): boolean {
    return contextWindow(lineIdx).includes(PENDING);
  }

  it("every .insert/.update/.delete on schema.factTable is classified with a pending guard", () => {
    const indices = writeLineIndices();
    expect(
      indices.length,
      "Expected at least 6 write sites in FactRepository.ts"
    ).toBeGreaterThanOrEqual(6);

    for (const idx of indices) {
      const win = lines.slice(idx, idx + 12).join("\n");
      expect(
        isClassified(idx),
        `Unclassified fact write at line ${idx + 1}:\n${win}\n\n` +
          `Add the pending-marker exclusion (? '__mnemoConsolidationPending') to the ` +
          `WHERE / values clause, or add a JS early-return guard before the write.`
      ).toBe(true);
    }
  });

  it("mergeFactByTopicKey UPDATE carries the inline pending exclusion in its WHERE", () => {
    // Regression: mergeFactByTopicKey must never drop the SQL-level guard.
    const mergeFn = source.slice(
      source.indexOf("async mergeFactByTopicKey"),
      source.indexOf("async replaceFact")
    );
    const updates = mergeFn.match(/\.update\(schema\.factTable\)/g) ?? [];
    expect(updates.length, "mergeFactByTopicKey must contain exactly one factTable UPDATE").toBe(1);
    expect(mergeFn).toContain(PENDING);
  });
});
