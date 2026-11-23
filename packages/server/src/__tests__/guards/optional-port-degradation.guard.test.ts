import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard: every OPTIONAL port method must be implemented by the
 * production adapter.
 *
 * Third sibling of queue-job-wiring and port-method-callers, covering the
 * nastiest variant of the same systemic shape. The first two catch "declared and
 * never used". This one catches "used and never provided".
 *
 * The case that motivated it: `hasActiveEmbeddingMigration` was declared
 * optional, called by recall-cold on every cold recall, and implemented by NO
 * adapter. Because the call site guards it —
 * `ctx.storage.hasActiveEmbeddingMigration ? await … : false` — nothing ever
 * threw. It simply took the `false` branch forever.
 *
 * That is worse than a missing method, because the guard is what makes it
 * invisible: the code reads as a careful degradation path, and the degradation
 * is permanent. Here it inverted a correctness decision — a workspace
 * mid-migration holds embeddings from two different models, which is exactly
 * when recall should lean lexical, and answering "no migration" kept the vector
 * arm weighted at 0.6 through the one window it is least trustworthy.
 *
 * `?` on a port method is a promise that SOME adapter may not have it — not
 * that the production one may quietly lack it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PORTS_FILE = join(ROOT, "types", "src", "ports.ts");
const DRIZZLE_FILE = join(ROOT, "adapter-postgres", "src", "DrizzleStorageAdapter.ts");

/**
 * Optional port methods the production adapter deliberately does not implement,
 * each with the reason. Implement it or drop the declaration, then delete the
 * entry.
 */
const KNOWN_UNIMPLEMENTED: Record<string, string> = {
  getWorkspaceLLMTokenUsage:
    "P111 — BLOCKED, not deferred: there is no data source. METER_METRICS " +
    "(core/src/cognitive/metering.ts) is [recall, write, session, reasoning_hit, " +
    "embedding, storage_gb, federation_sync] — no LLM-token metric exists, so no " +
    "row in mnemo_meter_event could satisfy this. Implementing it means first " +
    "emitting a new metric at the LLM call sites, which is a decision about what " +
    "we meter, not a missing query. Its sibling getWorkspaceEmbeddingTokenUsage " +
    "IS implemented, because `embedding` is a real metric.",
  getLatestActivatedPromptVersion:
    "P111 — needs the §14 prompt-version/A-B schema walked before a correct " +
    "avgScoreBefore/avgScoreAfter query can be written. Left for triage rather " +
    "than guessed at; GET /health/cognitive degrades to a null delta meanwhile.",
};

/** Optional method names (`name?(`) declared inside `export interface *Port {}`. */
function optionalPortMethods(): string[] {
  const src = readFileSync(PORTS_FILE, "utf8");
  const names = new Set<string>();

  for (const header of src.matchAll(/export interface (\w*Port)\s*\{/g)) {
    const start = header.index! + header[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    for (const m of body.matchAll(/^\s{2}(\w+)\?\s*(?:<[^>]*>)?\(/gm)) {
      names.add(m[1]!);
    }
  }
  return [...names];
}

/** Method names the production adapter defines. */
function drizzleMethods(): Set<string> {
  const src = readFileSync(DRIZZLE_FILE, "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/^\s{2}(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\(/gm)) names.add(m[1]!);
  // Assigned-arrow members, e.g. `foo = async (…) => …`.
  for (const m of src.matchAll(/^\s{2}(\w+)\s*=\s*(?:async\s*)?\(/gm)) names.add(m[1]!);
  return names;
}

describe("optional port degradation guard", () => {
  it("the production adapter implements every optional port method", () => {
    const optional = optionalPortMethods();
    const implemented = drizzleMethods();

    // Sanity: scanners that find nothing pass forever.
    expect(optional.length).toBeGreaterThan(10);
    expect(implemented.size).toBeGreaterThan(50);

    const missing = optional
      .filter((m) => !implemented.has(m) && !(m in KNOWN_UNIMPLEMENTED))
      .sort()
      .map(
        (m) =>
          `${m} — optional on a *Port and absent from DrizzleStorageAdapter; ` +
          `every guarded call site degrades permanently and silently`
      );

    expect(missing).toEqual([]);
  });

  it("every KNOWN_UNIMPLEMENTED entry is still unimplemented", () => {
    const optional = optionalPortMethods();
    const implemented = drizzleMethods();

    const stale = Object.keys(KNOWN_UNIMPLEMENTED)
      .filter((m) => !optional.includes(m) || implemented.has(m))
      .map((m) => `${m} is in KNOWN_UNIMPLEMENTED but no longer qualifies — delete the entry`);

    expect(stale).toEqual([]);
  });
});
