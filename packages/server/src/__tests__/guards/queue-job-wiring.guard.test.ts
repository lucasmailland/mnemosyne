import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard: every queue job that is PRODUCED must be CONSUMED.
 *
 * Why this exists. `staging_evaluation` (P74) was produced on a hot write path
 * for months with no handler registered anywhere. Nothing failed: the outbox
 * worker enqueued it, `InMemoryQueueAdapter.enqueue` found no handler and
 * returned a job id as though it had accepted the work, and the content was
 * gone. Every test passed, because each half of the mechanism was individually
 * correct — the producer produced, the queue enqueued. Only the join was
 * missing, and nothing in the codebase was looking at the join.
 *
 * That shape — one half of a mechanism implemented, the other half absent, no
 * error anywhere — turned out to be systemic rather than a one-off. This guard
 * covers the queue-job instance of it. It is deliberately dumb: readFileSync +
 * regex over the source, the same house pattern as purity.test.ts and
 * ports-segregation.test.ts, because a guard nobody can read is a guard nobody
 * maintains.
 *
 * KNOWN_UNCONSUMED is not a suppression list. Every entry must carry a reason
 * and a backlog reference, and the second test fails when an entry stops being
 * produced — so the list can only shrink as items are wired or removed, and a
 * stale justification cannot outlive the thing it justifies.
 */

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * Jobs that are produced with no consumer, each with the reason it is still
 * tolerated. Fix or remove the producer, then delete the entry.
 */
const KNOWN_UNCONSUMED: Record<string, string> = {
  // Empty, and that is the point. This guard shipped with four entries — the
  // orphan it was written for (`staging_evaluation`, P74) plus three it found on
  // its first run: `mnemo.hot.rebuild`, `flag_missing_knowledge` and
  // `self_edit_abuse_review`. All four are resolved: one producer deleted, one
  // handler registered, and three signals re-routed to `mnemo_review_item`, the
  // durable queue that is actually read.
  //
  // Keep the map. An empty allowlist is the guard at full strength: the next job
  // produced without a consumer fails the run instead of quietly joining a list.
};

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

interface Produced {
  job: string;
  file: string;
}

function scan(): { produced: Produced[]; consumed: Set<string> } {
  const produced: Produced[] = [];
  const consumed = new Set<string>();
  // Job-name constants, so `queue.process(SCOPED_CONFLICT_JOB, ...)` resolves.
  const constants = new Map<string, string>();

  const files = sourceFiles(PACKAGES_DIR);

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([a-z0-9._]+)["']/g)) {
      constants.set(m[1]!, m[2]!);
    }
  }

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = relative(PACKAGES_DIR, file);

    // Producers: an outbox `queue_job` payload naming its job.
    for (const m of src.matchAll(/\bjob:\s*["']([a-z0-9._]+)["']/g)) {
      produced.push({ job: m[1]!, file: rel });
    }

    // Consumers: queue.process("name", …) or queue.process(SOME_CONST, …).
    for (const m of src.matchAll(/\.process\(\s*(?:["']([a-z0-9._]+)["']|([A-Z][A-Z0-9_]*))/g)) {
      const literal = m[1];
      const viaConst = m[2] ? constants.get(m[2]) : undefined;
      if (literal) consumed.add(literal);
      else if (viaConst) consumed.add(viaConst);
    }
  }

  return { produced, consumed };
}

// These scan the whole source tree; on a loaded machine (pre-push sweep) the 5 s default is not enough.
describe("queue job wiring guard", { timeout: 60_000 }, () => {
  it("every produced job has a registered consumer", () => {
    const { produced, consumed } = scan();

    // Sanity: if the scanner stops finding producers the guard is silently dead.
    expect(produced.length).toBeGreaterThan(0);

    const orphans = produced
      .filter((p) => !consumed.has(p.job) && !(p.job in KNOWN_UNCONSUMED))
      .map((p) => `${p.job} (produced in ${p.file}, no queue.process handler)`);

    expect(orphans).toEqual([]);
  });

  it("every KNOWN_UNCONSUMED entry is still produced", () => {
    const { produced, consumed } = scan();
    const producedNames = new Set(produced.map((p) => p.job));

    const stale = Object.keys(KNOWN_UNCONSUMED)
      .filter((job) => !producedNames.has(job) || consumed.has(job))
      .map((job) => `${job} is in KNOWN_UNCONSUMED but is no longer an orphan — delete the entry`);

    expect(stale).toEqual([]);
  });

  it("the scanner resolves constant-named consumers, not just literals", () => {
    // Regression guard on the guard: scoped_semantic_conflict_check is only ever
    // registered as `queue.process(SCOPED_CONFLICT_JOB, …)`. If constant
    // resolution breaks, it reads as an orphan and the noise buries real ones.
    const { consumed } = scan();
    expect(consumed.has("scoped_semantic_conflict_check")).toBe(true);
  });
});
