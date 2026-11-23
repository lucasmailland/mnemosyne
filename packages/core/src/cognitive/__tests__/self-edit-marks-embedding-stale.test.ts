/**
 * P111 — an in-place text edit marks the row's embedding stale.
 *
 * The allowlist entry for `markEmbeddingsStale` said "a model swap silently
 * leaves stale vectors". Checked against the code, that turned out to be the
 * one case that is NOT a problem: both readers of the flag
 * (`listStaleEmbeddings`, `hasActiveEmbeddingMigration`) already OR
 * `embedding_model != currentModel`, so the daily migration picks up a model
 * swap with or without anything ever setting the flag.
 *
 * The real hole is the opposite shape — an edit under the SAME model:
 *
 *   `memory_self_edit(action: "append")` runs
 *   `updateFact({ statement: existing + "\n" + content })`. Nothing re-embeds
 *   afterwards (self-edit.ts enqueues no vector_upsert), and `embedding_model`
 *   is untouched, so `embedding_model != currentModel` is FALSE and the
 *   migration never looks at the row. The fact keeps being ranked by the
 *   meaning of the text it USED to have. Permanently, and silently — recall
 *   still returns it, just for the wrong queries.
 *
 * The flag is set inside the same UPDATE as the text, so the row cannot be
 * committed with new content and an unflagged old vector, and callers that do
 * not exist yet are covered without remembering to opt in.
 */
import { describe, it, expect } from "vitest";

import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { factStatementHash } from "@mnemo-ai/types";

const WS = "ws_1";

const MODEL = "test-model";

/**
 * Create a fact AND embed it, so the row starts in the state this is about.
 *
 * A freshly created fact is `embeddingStale: true` in both adapters, and
 * correctly so — the row exists before its vector does. Asserting the
 * transition from a fresh row would prove nothing, because the flag is already
 * set. What matters is a row that HAS a current embedding losing it.
 */
async function seed(storage: InMemoryStorageAdapter, statement: string) {
  const fact = await storage.createFact({
    workspaceId: WS,
    subject: "workspace",
    kind: "other",
    statement,
    actorId: "key:k1",
    actorType: "agent",
    userId: null,
  } as never);
  await storage.updateEmbeddingVector?.(
    "fact",
    fact.id,
    WS,
    new Float32Array(1536).fill(0.01),
    MODEL
  );
  const embedded = await storage.getFact(fact.id, WS);
  // Guard the guard: if embedding a row stopped clearing the flag, every
  // assertion below would pass for the wrong reason.
  if (embedded?.embeddingStale !== false) {
    throw new Error("seed precondition failed: embedding a row must clear embeddingStale");
  }
  return embedded;
}

describe("P111 — editing a fact's text invalidates its embedding", () => {
  it("marks the row stale when the statement changes", async () => {
    const storage = new InMemoryStorageAdapter();
    const fact = await seed(storage, "el cache corre sobre redis");
    expect(fact.embeddingStale).toBe(false);

    await storage.updateFact(fact.id, WS, {
      statement: "el cache corre sobre redis\nactualización: ahora es valkey",
    });

    const after = await storage.getFact(fact.id, WS);
    // Without this the vector still says "redis" while the text says "valkey",
    // and nothing anywhere will ever notice.
    expect(after?.embeddingStale).toBe(true);
  });

  it("does NOT mark it stale when the statement is unchanged", async () => {
    // Pinning a fact, closing it, patching its metadata — none of those touch
    // the text, so none should queue a re-embed. Marking on every update would
    // make the migration cron re-embed the whole workspace on a pin sweep.
    const storage = new InMemoryStorageAdapter();
    const fact = await seed(storage, "el cache corre sobre redis");

    await storage.updateFact(fact.id, WS, { pinned: true });

    const after = await storage.getFact(fact.id, WS);
    expect(after?.embeddingStale).toBeFalsy();
  });

  it("does NOT mark it stale when the statement is rewritten to the SAME text", async () => {
    // An idempotent write should be free. Comparing against the existing value
    // rather than merely checking `statement !== undefined` is what makes it so.
    const storage = new InMemoryStorageAdapter();
    const text = "el cache corre sobre redis";
    const fact = await seed(storage, text);

    await storage.updateFact(fact.id, WS, { statement: text });

    const after = await storage.getFact(fact.id, WS);
    expect(after?.embeddingStale).toBeFalsy();
  });

  it("the stale row is what the migration query looks for", async () => {
    // The flag only matters because `listStaleEmbeddings` ORs it. Asserted here
    // so the two halves cannot drift: if someone narrows that predicate to the
    // model comparison alone, this fails rather than the fix quietly becoming
    // a no-op again.
    const storage = new InMemoryStorageAdapter();
    const fact = await seed(storage, "texto original");
    await storage.updateFact(fact.id, WS, { statement: "texto editado" });

    const stale = await storage.listStaleEmbeddings?.("fact", WS, MODEL, 10);
    expect(stale?.some((r) => r.id === fact.id)).toBe(true);
  });
});

describe("P126 — editing the text also invalidates the dedupe fingerprint", () => {
  /**
   * The sibling of the embedding case above, and the more expensive one: an
   * orphaned fingerprint is not a stale index, it is a LOST WRITE.
   *
   * `remember()` consults `mnemo_fact_hash` before inserting. If an edit leaves
   * the old text's fingerprint pointing at this row, a later write of that
   * ORIGINAL text matches it, is handed this fact's id, and stores nothing —
   * with a 201 and a real id whose row says something else. Same family as P74,
   * and harder to notice, because P74 at least returned an id matching no row.
   */
  it("drops the fingerprint of the text that no longer exists", async () => {
    const storage = new InMemoryStorageAdapter();
    const original = "el cache corre sobre redis";
    const fact = await seed(storage, original);

    await storage.upsertFactHash?.({
      workspaceId: WS,
      statementHash: factStatementHash(original, fact.subject),
      factId: fact.id,
    });
    expect(
      await storage.lookupFactHash?.(WS, factStatementHash(original, fact.subject))
    ).toBeTruthy();

    await storage.updateFact(fact.id, WS, { statement: "el cache corre sobre valkey" });

    expect(
      await storage.lookupFactHash?.(WS, factStatementHash(original, fact.subject)),
      "the old text's fingerprint still resolves — a later write of it would be swallowed"
    ).toBeNull();
  });

  it("leaves the fingerprint alone when the text did not change", async () => {
    // Pinning or closing a fact must not cost its dedupe entry: dropping it
    // would turn every unrelated update into a licence to duplicate.
    const storage = new InMemoryStorageAdapter();
    const text = "el cache corre sobre redis";
    const fact = await seed(storage, text);
    await storage.upsertFactHash?.({
      workspaceId: WS,
      statementHash: factStatementHash(text, fact.subject),
      factId: fact.id,
    });

    await storage.updateFact(fact.id, WS, { pinned: true });

    expect(await storage.lookupFactHash?.(WS, factStatementHash(text, fact.subject))).toBeTruthy();
  });

  it("the hash formula is shared, not reimplemented", () => {
    // Five inline copies is what made this worth extracting: the fingerprint
    // only works if writer and reader agree byte for byte, and a drifted copy
    // does not error — it silently stops matching and the dedupe becomes a
    // duplicate factory.
    expect(factStatementHash("  El Cache  ", "infra")).toBe(factStatementHash("el cache", "infra"));
    expect(factStatementHash("x", "a")).not.toBe(factStatementHash("x", "b"));
  });
});
