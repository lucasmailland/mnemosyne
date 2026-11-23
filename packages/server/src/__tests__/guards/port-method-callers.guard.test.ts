import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard: every storage-port method must have a caller.
 *
 * Sibling of queue-job-wiring.guard.test.ts, covering a second instance of the
 * same systemic shape — one half of a mechanism implemented, the other half
 * absent, nothing failing.
 *
 * The case that motivated it, since fixed: `lookupFactHash` was declared on
 * FactPort and implemented three times (Drizzle, the in-memory adapter, the
 * in-memory fact index). Its counterpart `upsertFactHash` ran on every fact
 * write, so the hashes were all there, and nothing ever read them back —
 * exact-duplicate detection fully built and never connected, while
 * memory_remember's description promised content-hash idempotency it did not
 * have. remember() now consults it (P85.3), which is what took the entry off
 * the list below: the guard found it, and closing it removed it.
 *
 * A port method with implementations and no callers is either a feature that was
 * never finished or dead weight that reads as a feature. Both need to be visible.
 *
 * Scope: the declared members of the `*Port` interfaces in types/src/ports.ts.
 * A "caller" is any `.method(` occurrence in production source outside ports.ts
 * itself and outside the adapters that merely implement or delegate it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PORTS_FILE = join(ROOT, "types", "src", "ports.ts");

/**
 * P111 — CLOSED. Uncalled on purpose, decided, and not coming back for triage.
 *
 * Kept separate from the pending list below because lumping them together made
 * the residue read as six open questions when four were open and two were
 * answers. A permanent exception and an un-triaged gap look identical in a flat
 * allowlist, and the flat version is what let this sit at "16 entries" until
 * someone actually counted.
 *
 * Adding to THIS map is a claim that the method should never have a caller.
 * Adding to the one below is a promise to come back.
 */
const PERMANENT_EXCEPTIONS: Record<string, string> = {
  updateDecision:
    "Uncalled BY DESIGN since WP-6 / PRIM-18. Its only caller was PATCH /decisions/:id, " +
    "which wrote status and the successor pointer as a raw field update with no " +
    "validation (self-supersede accepted, a missing successor surfaced as a 500, " +
    "validTo left NULL). Supersession now goes through the atomic `supersedeDecision`; " +
    "no route should hand a client a raw decision-field write again. Closed 2026-10-17.",
  deleteRelation:
    "Uncalled BY DESIGN. Retraction is exposed through `closeRelation` " +
    "(DELETE /relations/:id), a bitemporal close that keeps the row and its " +
    "judgment provenance, matching forget()'s contract. This one is the physical " +
    "DELETE: no close, no audit entry, no deletion-log row. Wiring it would need a " +
    "memory:hard_delete gate and an audit trail first — and the reason not to is " +
    "that `closeRelation` already covers every case a caller actually has. Closed " +
    "2026-08-13: this is the answer, not a deferral.",
  markEmbeddingsStale:
    "Uncalled because its semantics are REDUNDANT, which only became clear when " +
    "someone went to wire it (2026-08-13). It marks in bulk by MODEL, and both " +
    "readers of the flag — listStaleEmbeddings and hasActiveEmbeddingMigration — " +
    "already OR `embedding_model != currentModel`, so the daily migration picks up " +
    "a model swap with or without it. The real gap was the opposite shape: an " +
    "in-place text edit under the SAME model, which no model comparison can catch. " +
    "That is fixed at the write instead (FactRepository.updateFact sets " +
    "embedding_stale when the statement changes), so the flag now has a writer with " +
    "a real effect and this bulk variant still has no non-redundant caller. Kept " +
    "rather than deleted because it is the operator escape hatch for forcing a " +
    "re-embed. Closed 2026-08-13.",
  getActorDek:
    "A false positive of this guard's own scope, not dead code. " +
    "DrizzleStorageAdapter passes it to AuditRepository as a bound reference " +
    "(`this.encryption.getActorDek.bind(...)`), and this scanner deliberately skips " +
    "the adapter layer, so an internal adapter dependency reads as unused. Kept as a " +
    "documented exception rather than by widening the scan, which would let genuine " +
    "adapter-only orphans through. Closed 2026-08-13.",
  getEpisodeTreeNeighbors:
    "Uncalled BY DESIGN since WP-3 (RECALL-2). Its one caller was cold recall, which " +
    "injected an episode's parent, siblings and children into the ranked hits at half " +
    "the episode's score, with no relevance evidence of their own — the same bypass " +
    "as hyperedge co-members and source-episode promotion, removed together. Ranked " +
    "recall must not admit structurally related rows, so that caller is not coming " +
    "back. The method stays for an explicit episode-tree drill-down (navigation, not " +
    "ranking), which nobody has asked for yet. Closed 2026-10-18.",
};

/**
 * Port methods with no caller that STILL NEED A DECISION. Wire it or delete it,
 * then remove the entry. This map should only ever shrink.
 */
const PENDING_TRIAGE: Record<string, string> = {
  updateEpisode:
    "P111 — unused today, but it is the method P109's eager-episode design would " +
    "need if collapse switches from creating an episode to enriching one.",
  persistCompression:
    "P111 — WIDER than it looks, and a decision. The whole Experience-Compression " +
    "subsystem (spec §2) is unwired: detectCompressionCandidate and compressSubtree " +
    "have no callers either, so wiring only the persist step would change nothing " +
    "observable. compressSubtree spends real LLM tokens per run, so 'when does " +
    "compression fire' (on collapse? a sweep? a depth threshold?) is a product " +
    "question, not plumbing.",
};

/** What the guard tolerates: the decided ones plus the ones still owed a decision. */
const KNOWN_UNCALLED: Record<string, string> = { ...PERMANENT_EXCEPTIONS, ...PENDING_TRIAGE };

const STAGED_PORT_INTERFACES = new Set([
  // Task 5 establishes the adapter contract; Task 8 adds the only production
  // worker allowed to consume these lease-sensitive lifecycle operations.
  "ManagedSessionLifecyclePort",
]);

/** Files that implement or delegate a port rather than consume it. */
function isImplementationFile(rel: string): boolean {
  return (
    rel.includes("adapter-postgres/src/repositories/") ||
    rel.includes("adapter-postgres/src/DrizzleStorageAdapter") ||
    rel.includes("types/src/testing/") ||
    rel.endsWith("types/src/ports.ts")
  );
}

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

/** Method names declared inside `export interface *Port { … }` blocks. */
function declaredPortMethods(): string[] {
  const src = readFileSync(PORTS_FILE, "utf8");
  const names = new Set<string>();

  for (const header of src.matchAll(/export interface (\w*Port)\s*\{/g)) {
    if (STAGED_PORT_INTERFACES.has(header[1]!)) continue;
    const start = header.index! + header[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    // `name(` or `name?(` at the start of a line — methods, not properties.
    for (const m of body.matchAll(/^\s{2}(\w+)\??\s*(?:<[^>]*>)?\(/gm)) {
      names.add(m[1]!);
    }
  }
  return [...names];
}

function callerCounts(methods: string[]): Map<string, number> {
  const counts = new Map(methods.map((m) => [m, 0]));
  for (const file of sourceFiles(ROOT)) {
    const rel = relative(ROOT, file);
    if (isImplementationFile(rel)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of methods) {
      // A use, not a declaration. Must tolerate the shapes the codebase
      // actually has:
      //   `.method(`            — the ordinary call
      //   `.method?.(`          — optional call
      //   `.method!(`           — non-null assertion on the method itself; this
      //                           is why recordSessionRecall first read as
      //                           uncalled despite routes/recall.ts calling it
      //   `.method.bind(`       — passed as a bound reference rather than
      //                           called here; DrizzleStorageAdapter hands
      //                           getActorDek to AuditRepository exactly this
      //                           way, and counting only call syntax reported a
      //                           live method as dead.
      //   `.method as T)(`      — a cast-wrapped call. retention-purge.ts
      //                           invokes purgeFacts as
      //                           `(deps.storage.purgeFacts as NonNullable<…>)({…})`
      //                           to satisfy the optional signature, and this
      //                           guard reported a load-bearing SOC2 method as
      //                           an unwired capability because of it. Any
      //                           `.method as` is a reference, so it counts.
      const re = new RegExp(`\\.${m}\\s*(?:[!?]?\\.?\\s*\\(|\\.bind\\s*\\(|as\\s)`, "g");
      const n = [...src.matchAll(re)].length;
      if (n > 0) counts.set(m, counts.get(m)! + n);
    }
  }
  return counts;
}

// These scan the whole source tree; on a loaded machine (pre-push sweep) the 5 s default is not enough.
describe("port method caller guard", { timeout: 60_000 }, () => {
  it("every declared port method is called somewhere", () => {
    const methods = declaredPortMethods();

    // Sanity: a scanner that finds nothing would pass forever.
    expect(methods.length).toBeGreaterThan(100);

    const counts = callerCounts(methods);
    const uncalled = methods
      .filter((m) => counts.get(m) === 0 && !(m in KNOWN_UNCALLED))
      .sort()
      .map((m) => `${m} — declared on a *Port, implemented, never called`);

    expect(uncalled).toEqual([]);
  });

  it("the pending-triage list only shrinks", () => {
    // P111. Without this the split into permanent/pending is cosmetic: someone
    // adds a seventh uncalled method, drops it in the pending map with a
    // sentence, and the residue silently grows back while every test stays
    // green. Lowering this number is the point; raising it needs a human to
    // decide the entry is genuinely owed a decision rather than an oversight.
    expect(Object.keys(PENDING_TRIAGE).length).toBeLessThanOrEqual(2);
  });

  it("a method is never in both maps", () => {
    // "Permanent" and "we'll come back to it" are contradictory claims, and a
    // duplicated key would resolve to whichever spread wins — silently.
    const both = Object.keys(PERMANENT_EXCEPTIONS).filter((m) => m in PENDING_TRIAGE);
    expect(both).toEqual([]);
  });

  it("every permanent exception says WHY it is permanent, not just that it is", () => {
    // An exception with a one-line reason is how a deferral gets laundered into
    // a decision. Each of these has to carry the argument, because the next
    // reader's only alternative is to re-derive it.
    for (const [name, reason] of Object.entries(PERMANENT_EXCEPTIONS)) {
      expect(reason.length, `${name}'s reason is too thin to be a decision`).toBeGreaterThan(200);
      expect(reason, `${name} does not say when it was closed`).toMatch(/Closed \d{4}-\d{2}-\d{2}/);
    }
  });

  it("every KNOWN_UNCALLED entry is still uncalled", () => {
    const methods = declaredPortMethods();
    const counts = callerCounts(methods);

    const stale = Object.keys(KNOWN_UNCALLED)
      .filter((m) => !methods.includes(m) || counts.get(m)! > 0)
      .map((m) => `${m} is in KNOWN_UNCALLED but now has callers — delete the entry`);

    expect(stale).toEqual([]);
  });
});
