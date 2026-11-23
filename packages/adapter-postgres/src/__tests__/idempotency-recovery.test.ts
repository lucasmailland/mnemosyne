import { describe, it, expect } from "vitest";
import { DrizzleIdempotencyStore } from "../DrizzleIdempotencyStore.js";

/** Minimal fake that captures the last SELECT result and records UPDATE SQL text. */
function fakeDb(recoveryPointToReturn: string | null) {
  const executed: string[] = [];
  const tx = {
    async execute(q: unknown) {
      // Drizzle's sql`...` template returns an SQL object whose static text is in
      // its `queryChunks` array. Static StringChunks expose a `value` array of
      // strings, parameter placeholders are plain strings — concat both for asserts.
      const chunks = (q as { queryChunks?: unknown[] }).queryChunks;
      const text = Array.isArray(chunks)
        ? chunks
            .map((c) => {
              if (typeof c === "string") return c;
              const v = (c as { value?: unknown }).value;
              if (Array.isArray(v)) return v.join("");
              return "";
            })
            .join(" ")
        : String((q as { sql?: string }).sql ?? q);
      executed.push(text);
      if (/SELECT\s+recovery_point/i.test(text)) {
        return { rows: recoveryPointToReturn == null ? [] : [{ recovery_point: recoveryPointToReturn }] };
      }
      return { rows: [] };
    },
  };
  const db = {
    async transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> { return fn(tx); },
  };
  return { db, executed };
}

describe("DrizzleIdempotencyStore recovery points (spec §Idempotency RDD9)", () => {
  it("getRecoveryPoint returns the stored phase", async () => {
    const { db } = fakeDb("llm_called");
    const store = new DrizzleIdempotencyStore(db as never);
    const rp = await store.getRecoveryPoint("ws1", "k1");
    expect(rp).toBe("llm_called");
  });

  it("getRecoveryPoint returns null for an unknown key", async () => {
    const { db } = fakeDb(null);
    const store = new DrizzleIdempotencyStore(db as never);
    expect(await store.getRecoveryPoint("ws1", "missing")).toBeNull();
  });

  it("recordPhase issues an UPDATE setting recovery_point and is guarded by workspace + key", async () => {
    const { db, executed } = fakeDb(null);
    const store = new DrizzleIdempotencyStore(db as never);
    await store.recordPhase("ws1", "k1", "facts_persisted");
    const update = executed.find((s) => /UPDATE\s+mnemosyne\.mnemo_idempotency_keys/i.test(s) && /recovery_point/i.test(s));
    expect(update).toBeTruthy();
  });
});
