/**
 * P125 — the collapse honours `topicKey` instead of always inserting.
 *
 * `topicKey` exists so that saying the same thing twice UPDATES rather than
 * duplicates, and `mnemo_fact` enforces it with a unique index over active
 * rows. `remember()` — the explicit path — goes through
 * `mergeFactByTopicKey`. The collapse — the automatic path, which runs
 * unattended at the end of every session — called `createFact` directly.
 *
 * So a second session about the same topic violated the index, and because the
 * violation aborts the persist transaction it took the WHOLE session's
 * extraction with it, not just the colliding fact. Verified against a real
 * container: a 500 with `internal_error`, four turns of conversation extracted
 * into nothing.
 *
 * That the UNATTENDED path was the broken one is the part worth remembering:
 * nobody is watching it, and it fails more often the more the system is used on
 * recurring topics — exactly backwards from how a memory should behave.
 *
 * Driven through the storage port rather than the full pipeline, because what
 * changed is which port method the persist step calls. Whether the merge itself
 * is bitemporally correct is P76's contract and is proven against real Postgres
 * in the adapter's own tests.
 */
import { describe, it, expect, vi } from "vitest";

type MergeInput = { workspaceId: string; topicKey: string; statement: string };

/**
 * The persist decision under test, extracted to the shape the collapse now
 * uses: merge when there is a topicKey and something to merge into, create
 * otherwise.
 */
async function persist(
  storage: {
    mergeFactByTopicKey: (i: MergeInput) => Promise<{ id: string } | null>;
    createFact: (i: unknown) => Promise<{ id: string }>;
  },
  extracted: { content: string; topicKey?: string },
  workspaceId = "ws_1"
) {
  const merged = extracted.topicKey
    ? await storage.mergeFactByTopicKey({
        workspaceId,
        topicKey: extracted.topicKey,
        statement: extracted.content,
      })
    : null;
  return merged ?? (await storage.createFact({ workspaceId, statement: extracted.content }));
}

describe("P125 — collapse persists through the topicKey upsert", () => {
  it("merges instead of inserting when the topic already has an active fact", async () => {
    const mergeFactByTopicKey = vi.fn<(i: MergeInput) => Promise<{ id: string } | null>>(
      async () => ({ id: "fact_existing" })
    );
    const createFact = vi.fn<(i: unknown) => Promise<{ id: string }>>(async () => ({
      id: "fact_new",
    }));

    const out = await persist(
      { mergeFactByTopicKey, createFact },
      {
        content: "el cache corre sobre valkey",
        topicKey: "infra/cache",
      }
    );

    expect(out.id).toBe("fact_existing");
    // The assertion that matters: the INSERT that used to blow up the whole
    // transaction never happens.
    expect(createFact).not.toHaveBeenCalled();
    expect(mergeFactByTopicKey).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      topicKey: "infra/cache",
      statement: "el cache corre sobre valkey",
    });
  });

  it("creates when the topic is new — merge returns null", async () => {
    // The other half. A change that merged unconditionally would swallow every
    // first-time fact and pass the test above.
    const mergeFactByTopicKey = vi.fn<(i: MergeInput) => Promise<{ id: string } | null>>(
      async () => null
    );
    const createFact = vi.fn<(i: unknown) => Promise<{ id: string }>>(async () => ({
      id: "fact_new",
    }));

    const out = await persist(
      { mergeFactByTopicKey, createFact },
      {
        content: "algo que nadie dijo antes",
        topicKey: "infra/nuevo",
      }
    );

    expect(out.id).toBe("fact_new");
    expect(createFact).toHaveBeenCalledTimes(1);
  });

  it("does not consult the upsert at all when there is no topicKey", async () => {
    // Most extracted facts carry none. Calling merge with an empty key would be
    // a query per fact for nothing, and worse, a key of "" could collide
    // across unrelated facts.
    const mergeFactByTopicKey = vi.fn<(i: MergeInput) => Promise<{ id: string } | null>>(
      async () => null
    );
    const createFact = vi.fn<(i: unknown) => Promise<{ id: string }>>(async () => ({
      id: "fact_new",
    }));

    await persist({ mergeFactByTopicKey, createFact }, { content: "sin topic key" });

    expect(mergeFactByTopicKey).not.toHaveBeenCalled();
    expect(createFact).toHaveBeenCalledTimes(1);
  });

  it("the collapse source really calls mergeFactByTopicKey", async () => {
    // The above proves the SHAPE. This proves the shape is the one collapse.ts
    // actually uses — without it, the whole file could pass against a
    // collapse that still inserts blindly.
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "collapse.ts"),
      "utf8"
    );

    expect(src).toContain("mergeFactByTopicKey");
    expect(src).toContain("await storage.createFact(input)");
    // And the merge has to come BEFORE the insert, or it is decoration.
    expect(src.indexOf("mergeFactByTopicKey")).toBeLessThan(
      src.indexOf("await storage.createFact(input)")
    );
  });
});
